import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { snapshotAll, type Snapshot } from "./conflicts.js";
import { ExecError, run } from "./exec.js";
import type { Fanout } from "./fanout.js";
import { GROVE_HOME, setupCommand, type Repo } from "./repo.js";
import { PREVIEW_ID, copyIgnoredFiles, slug, type Session } from "./sessions.js";
import * as tmux from "./tmux.js";

/**
 * Which worktrees go into the preview. Worktrees are in unless `excluded`;
 * fan-out candidates are alternatives, so they're out unless `chosen`, and at
 * most one per fan-out is chosen.
 */
export type PreviewPicks = { excluded: string[]; chosen: string[] };

/** What the preview holds: the worktrees merged into it, and those left out because they conflict. */
export type PreviewResult = { included: string[]; conflicting: { id: string; files: string[] }[] };

export const previewPath = (repo: Repo) => join(repo.worktreesDir, PREVIEW_ID);
export const previewExists = (repo: Repo) => existsSync(previewPath(repo));
const picksFile = (repo: Repo) => join(GROVE_HOME, "preview", `${slug(repo.key)}.json`);

export function loadPicks(repo: Repo): PreviewPicks {
  const file = picksFile(repo);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as PreviewPicks) : { excluded: [], chosen: [] };
}

function savePicks(repo: Repo, picks: PreviewPicks): void {
  mkdirSync(join(GROVE_HOME, "preview"), { recursive: true });
  writeFileSync(picksFile(repo), JSON.stringify(picks, null, 2));
}

export const wanted = (picks: PreviewPicks, id: string, fanout?: Fanout) =>
  fanout ? picks.chosen.includes(id) : !picks.excluded.includes(id);

/**
 * Put a worktree into the preview or take it out. Choosing a fan-out candidate
 * drops its siblings. `fanout` is the live fan-out the worktree belongs to, if any.
 */
export function togglePick(repo: Repo, id: string, fanout?: Fanout): PreviewPicks {
  const picks = loadPicks(repo);
  const without = (ids: string[], drop: string[]) => ids.filter((x) => !drop.includes(x));
  let next: PreviewPicks;
  if (fanout) {
    const chosen = picks.chosen.includes(id) ? without(picks.chosen, [id]) : [...without(picks.chosen, fanout.members), id];
    next = { ...picks, chosen };
  } else {
    const excluded = picks.excluded.includes(id) ? without(picks.excluded, [id]) : [...picks.excluded, id];
    next = { ...picks, excluded };
  }
  savePicks(repo, next);
  return next;
}

// Merge steps by accumulated commit + snapshot, so unchanged prefixes of the fold aren't re-merged each poll.
const stepCache = new Map<string, { commit: string } | { files: string[] }>();
// The commit last written into each preview worktree, so an unchanged result isn't re-applied.
const applied = new Map<string, string>();
// Applies run one at a time: two read-trees in one worktree would fight over its index lock.
let queue: Promise<unknown> = Promise.resolve();

async function mergeStep(repo: Repo, acc: string, snap: Snapshot): Promise<{ commit: string } | { files: string[] }> {
  const key = `${acc}|${snap.key}`;
  const cached = stepCache.get(key);
  if (cached) return cached;
  let step: { commit: string } | { files: string[] };
  try {
    const tree = await run("git", ["merge-tree", "--write-tree", "--name-only", "--no-messages", acc, snap.commit], repo.root);
    const commit = await run("git", ["commit-tree", tree, "-p", acc, "-p", snap.commit, "-m", "grove preview"], repo.root);
    step = { commit };
  } catch (e) {
    // Exit 1 means conflicts: stdout is the result tree, then one conflicted path per line.
    if (!(e instanceof ExecError) || e.code !== 1) throw e;
    step = { files: [...new Set(e.stdout.split("\n").slice(1).filter(Boolean))] };
  }
  stepCache.set(key, step);
  return step;
}

/**
 * Merge the base and every wanted worktree's snapshot, one after another, and
 * write the result into the preview worktree. A worktree that conflicts with
 * what's merged before it is left out, so the preview never has conflict
 * markers. The preview's HEAD stays on the base, so `git diff --cached` there
 * shows everyone's work together.
 */
export async function updatePreview(
  repo: Repo,
  sessions: Session[],
  snaps: Map<string, Snapshot>,
  picks: PreviewPicks,
  fanouts: Fanout[],
): Promise<PreviewResult> {
  const groupOf = new Map(fanouts.flatMap((g) => g.members.map((m) => [m, g] as const)));
  const members = sessions
    .filter((s) => wanted(picks, s.id, groupOf.get(s.id)))
    .sort((a, b) => a.id.localeCompare(b.id));

  const base = await run("git", ["rev-parse", repo.base], repo.root);
  const result: PreviewResult = { included: [], conflicting: [] };
  let acc = base;
  for (const s of members) {
    const snap = snaps.get(s.id);
    // A worktree with no changes adds nothing but still counts as in the preview.
    if (!snap) {
      result.included.push(s.id);
      continue;
    }
    const step = await mergeStep(repo, acc, snap);
    if ("commit" in step) {
      acc = step.commit;
      result.included.push(s.id);
    } else {
      result.conflicting.push({ id: s.id, files: step.files });
    }
  }

  const path = previewPath(repo);
  const apply = queue.then(async () => {
    if (!existsSync(path) || applied.get(path) === acc) return;
    await run("git", ["read-tree", "-u", "--reset", acc], path);
    await run("git", ["update-ref", "--no-deref", "HEAD", base], path);
    applied.set(path, acc);
  });
  queue = apply.catch(() => {});
  await apply;
  return result;
}

async function startShell(repo: Repo, setup?: string): Promise<void> {
  const shell = process.env.SHELL || "sh";
  await tmux.startWindow({
    session: repo.tmuxSession,
    window: PREVIEW_ID,
    cwd: previewPath(repo),
    command: [setup, `exec ${shell}`].filter(Boolean).join("; "),
    env: {},
  });
}

/**
 * Create the preview worktree, fill it with the merged work, and start a shell
 * in it that first runs the repo's setup command.
 */
export async function createPreview(repo: Repo, sessions: Session[], fanouts: Fanout[]): Promise<string> {
  const path = previewPath(repo);
  mkdirSync(repo.worktreesDir, { recursive: true });
  await run("git", ["worktree", "add", "--detach", path, repo.base], repo.root);
  await copyIgnoredFiles(repo, path);
  applied.delete(path);
  // Merge before setup runs, so it installs the dependencies the combined work needs.
  const result = await updatePreview(repo, sessions, await snapshotAll(sessions), loadPicks(repo), fanouts);
  await startShell(repo, setupCommand(repo));
  const left = result.conflicting.length ? `; ${result.conflicting.length} left out for conflicts` : "";
  return `preview at ${path} with ${result.included.length} worktree${result.included.length === 1 ? "" : "s"}${left}`;
}

/** Attach to the preview's shell, starting one if it has exited. */
export async function openPreview(repo: Repo) {
  if (!(await tmux.listWindows(repo.tmuxSession)).has(PREVIEW_ID)) await startShell(repo);
  return tmux.attach(repo.tmuxSession, PREVIEW_ID);
}

export async function removePreview(repo: Repo): Promise<string> {
  await tmux.killWindow(repo.tmuxSession, PREVIEW_ID);
  await run("git", ["worktree", "remove", "--force", previewPath(repo)], repo.root);
  applied.delete(previewPath(repo));
  return "removed the preview";
}
