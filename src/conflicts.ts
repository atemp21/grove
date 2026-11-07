import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ExecError, run } from "./exec.js";
import type { Repo } from "./repo.js";
import type { Session } from "./sessions.js";

/** Another branch this session's work would conflict with, and the files involved. */
export type Conflict = { with: string; files: string[] };

export type Snapshot = { commit: string; key: string };

// Snapshot commits by HEAD + tree, so an unchanged worktree isn't re-committed every poll.
const snapshotCache = new Map<string, string>();
// merge-tree results by the pair of snapshots, so unchanged pairs aren't re-merged.
const mergeCache = new Map<string, string[]>();

/**
 * A commit of the worktree exactly as it is on disk, uncommitted and untracked
 * files included. Built with a throwaway index, so the worktree, its real index
 * and its refs are untouched; the commit is unreferenced and git gc drops it.
 */
async function snapshot(path: string): Promise<Snapshot> {
  const dir = mkdtempSync(join(tmpdir(), "grove-"));
  try {
    const index = join(dir, "index");
    const gitIndex = await run("git", ["rev-parse", "--git-path", "index"], path);
    const realIndex = isAbsolute(gitIndex) ? gitIndex : join(path, gitIndex);
    // Starting from the real index lets `git add` reuse its stat cache instead of rehashing everything.
    if (existsSync(realIndex)) copyFileSync(realIndex, index);
    const env = { GIT_INDEX_FILE: index };
    await run("git", ["add", "-A"], path, env);
    const [tree, head, headTree] = await Promise.all([
      run("git", ["write-tree"], path, env),
      run("git", ["rev-parse", "HEAD"], path),
      run("git", ["rev-parse", "HEAD^{tree}"], path),
    ]);
    const key = `${head}:${tree}`;
    if (tree === headTree) return { commit: head, key };
    let commit = snapshotCache.get(key);
    if (!commit) {
      commit = await run("git", ["commit-tree", tree, "-p", head, "-m", "grove snapshot"], path);
      snapshotCache.set(key, commit);
    }
    return { commit, key };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Files that would conflict if `a` and `b` were merged; empty if they merge cleanly. */
async function conflictingFiles(repo: Repo, a: Snapshot, b: Snapshot): Promise<string[]> {
  const cacheKey = [a.key, b.key].sort().join("|");
  const cached = mergeCache.get(cacheKey);
  if (cached) return cached;
  let files: string[] = [];
  try {
    await run("git", ["merge-tree", "--write-tree", "--name-only", "--no-messages", a.commit, b.commit], repo.root);
  } catch (e) {
    // Exit 1 means conflicts: stdout is the result tree, then one conflicted path per line.
    if (!(e instanceof ExecError) || e.code !== 1) throw e;
    files = [...new Set(e.stdout.split("\n").slice(1).filter(Boolean))];
  }
  mergeCache.set(cacheKey, files);
  return files;
}

const hasWork = (s: Session) => s.ahead > 0 || s.added + s.deleted + s.untracked > 0;

/** Snapshot every worktree that has work in it, by session id. Worktrees that fail to snapshot are left out. */
export async function snapshotAll(sessions: Session[]): Promise<Map<string, Snapshot>> {
  const active = sessions.filter(hasWork);
  const snaps = await Promise.all(active.map((s) => snapshot(s.path).catch(() => null)));
  return new Map(active.flatMap((s, i) => (snaps[i] ? [[s.id, snaps[i]] as const] : [])));
}

/**
 * Predict merge conflicts between every pair of worktrees, and between each
 * worktree and the base branch, using their snapshots.
 */
export async function findConflicts(
  repo: Repo,
  sessions: Session[],
  snaps: Map<string, Snapshot>,
): Promise<Map<string, Conflict[]>> {
  const active = sessions.filter((s) => snaps.has(s.id));
  const result = new Map<string, Conflict[]>();
  if (active.length === 0) return result;

  const baseCommit = await run("git", ["rev-parse", repo.base], repo.root);
  const base: Snapshot = { commit: baseCommit, key: baseCommit };
  const add = (id: string, c: Conflict) => result.set(id, [...(result.get(id) ?? []), c]);

  const checks: Promise<void>[] = [];
  active.forEach((s, i) => {
    const snap = snaps.get(s.id)!;
    checks.push(
      conflictingFiles(repo, snap, base).then((files) => {
        if (files.length) add(s.id, { with: repo.base, files });
      }),
    );
    for (const other of active.slice(i + 1)) {
      checks.push(
        conflictingFiles(repo, snap, snaps.get(other.id)!).then((files) => {
          if (!files.length) return;
          add(s.id, { with: other.id, files });
          add(other.id, { with: s.id, files });
        }),
      );
    }
  });
  await Promise.all(checks.map((c) => c.catch(() => {})));
  // Checks finish in any order; keep the list stable between polls, base branch first.
  for (const list of result.values()) {
    list.sort((x, y) => Number(y.with === repo.base) - Number(x.with === repo.base) || x.with.localeCompare(y.with));
  }
  return result;
}
