import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { run, runInteractive, tryRun, pressEnterToContinue } from "./exec.js";
import { GROVE_HOME, copyPatterns, setupCommand, type Repo } from "./repo.js";
import * as tmux from "./tmux.js";

/** What Claude is doing, as last reported by its hooks. */
export type ClaudeState = "busy" | "waiting" | "idle" | "ended" | "unknown";

export type Session = {
  id: string;
  path: string;
  branch: string | null;
  running: boolean;
  state: ClaudeState;
  stateSince: Date | null;
  added: number;
  deleted: number;
  untracked: number;
  ahead: number;
  dirty: boolean;
};

const STATUS_DIR = join(GROVE_HOME, "status");
const SETTINGS_PATH = join(GROVE_HOME, "claude-settings.json");

const slug = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const statusFile = (repo: Repo, id: string) => join(STATUS_DIR, `${slug(repo.name)}__${id}`);

/**
 * Hooks that make each Claude session report its state to the file named by
 * $GROVE_STATUS_FILE. Loaded with `claude --settings`, so the user's own
 * settings are left alone and sessions started outside grove are unaffected.
 */
export function writeClaudeSettings(): void {
  mkdirSync(STATUS_DIR, { recursive: true });
  const report = (state: ClaudeState) => [
    {
      hooks: [
        {
          type: "command",
          command: `[ -n "$GROVE_STATUS_FILE" ] && echo ${state} > "$GROVE_STATUS_FILE"; exit 0`,
        },
      ],
    },
  ];
  const settings = {
    hooks: {
      SessionStart: report("idle"),
      UserPromptSubmit: report("busy"),
      PreToolUse: report("busy"),
      PostToolUse: report("busy"),
      Notification: [{ matcher: "permission_prompt|elicitation_dialog", ...report("waiting")[0] }],
      Stop: report("idle"),
      SessionEnd: report("ended"),
    },
  };
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

type Worktree = { path: string; branch: string | null };

async function listWorktrees(repo: Repo): Promise<Worktree[]> {
  const out = await run("git", ["worktree", "list", "--porcelain"], repo.root);
  const trees: Worktree[] = [];
  for (const block of out.split("\n\n")) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (!path || path === repo.root || /^prunable/m.test(block)) continue;
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null;
    trees.push({ path, branch });
  }
  return trees;
}

const idFor = (wt: Worktree) => slug(wt.branch ?? basename(wt.path));

function readState(repo: Repo, id: string): { state: ClaudeState; since: Date | null } {
  const file = statusFile(repo, id);
  if (!existsSync(file)) return { state: "unknown", since: null };
  const state = readFileSync(file, "utf8").trim() as ClaudeState;
  return { state, since: statSync(file).mtime };
}

async function changeStats(repo: Repo, path: string) {
  const mergeBase = await tryRun("git", ["merge-base", repo.base, "HEAD"], path);
  const [shortstat, untracked, ahead, status] = await Promise.all([
    mergeBase ? tryRun("git", ["diff", "--shortstat", mergeBase], path) : null,
    tryRun("git", ["ls-files", "--others", "--exclude-standard"], path),
    tryRun("git", ["rev-list", "--count", `${repo.base}..HEAD`], path),
    tryRun("git", ["status", "--porcelain"], path),
  ]);
  return {
    added: Number(shortstat?.match(/(\d+) insertion/)?.[1] ?? 0),
    deleted: Number(shortstat?.match(/(\d+) deletion/)?.[1] ?? 0),
    untracked: untracked ? untracked.split("\n").length : 0,
    ahead: Number(ahead ?? 0),
    dirty: Boolean(status),
  };
}

export async function listSessions(repo: Repo): Promise<Session[]> {
  const [trees, windows] = await Promise.all([listWorktrees(repo), tmux.listWindows(repo.tmuxSession)]);
  return Promise.all(
    trees.map(async (wt) => {
      const id = idFor(wt);
      const { state, since } = readState(repo, id);
      return {
        id,
        path: wt.path,
        branch: wt.branch,
        running: windows.has(id),
        state,
        stateSince: since,
        ...(await changeStats(repo, wt.path)),
      };
    }),
  );
}

async function startClaude(repo: Repo, id: string, cwd: string, firstRun: boolean): Promise<void> {
  const claude = ["claude", "--settings", shq(SETTINGS_PATH), ...(repo.config.claudeArgs ?? []).map(shq)];
  // Resume the previous conversation if this worktree has had one.
  const resume = existsSync(statusFile(repo, id)) ? " --continue" : "";
  const setup = firstRun ? setupCommand(repo) : undefined;
  const command = [setup, `exec ${claude.join(" ")}${resume}`].filter(Boolean).join("; ");
  await tmux.startWindow({
    session: repo.tmuxSession,
    window: id,
    cwd,
    command,
    env: { GROVE_STATUS_FILE: statusFile(repo, id) },
  });
}

/** Create a worktree for `branch` (new or existing), copy env files, and start Claude in it. */
export async function createSession(repo: Repo, branch: string): Promise<string> {
  const id = slug(branch);
  if (!id) throw new Error("invalid branch name");
  const path = join(repo.worktreesDir, id);
  if (existsSync(path)) throw new Error(`${path} already exists`);
  mkdirSync(repo.worktreesDir, { recursive: true });

  const exists = (await tryRun("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo.root)) !== null;
  await run(
    "git",
    exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, repo.base],
    repo.root,
  );

  const toCopy = await tryRun(
    "git",
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--", ...copyPatterns(repo)],
    repo.root,
  );
  for (const file of toCopy ? toCopy.split("\n") : []) {
    if (file.includes("node_modules/")) continue;
    mkdirSync(dirname(join(path, file)), { recursive: true });
    copyFileSync(join(repo.root, file), join(path, file));
  }

  rmSync(statusFile(repo, id), { force: true });
  await startClaude(repo, id, path, true);
  return id;
}

/** Attach to a session's tmux window, relaunching Claude first if it has exited. */
export async function openSession(repo: Repo, s: Session) {
  if (!s.running) await startClaude(repo, s.id, s.path, false);
  return tmux.attach(repo.tmuxSession, s.id);
}

export async function removeSession(repo: Repo, s: Session, force: boolean): Promise<string> {
  await tmux.killWindow(repo.tmuxSession, s.id);
  await run("git", ["worktree", "remove", ...(force ? ["--force"] : []), s.path], repo.root);
  rmSync(statusFile(repo, s.id), { force: true });
  if (!s.branch) return `removed ${s.id}`;
  const deleted = (await tryRun("git", ["branch", "-d", s.branch], repo.root)) !== null;
  return deleted ? `removed ${s.id} and its branch` : `removed ${s.id} (branch ${s.branch} kept: not merged)`;
}

/** Merge a session's branch into the base branch in the main checkout. */
export async function mergeSession(repo: Repo, s: Session): Promise<string> {
  if (!s.branch) throw new Error("worktree has a detached HEAD");
  if (s.dirty) throw new Error(`${s.id} has uncommitted changes; commit them first`);
  if (s.ahead === 0) throw new Error(`${s.id} has no commits ahead of ${repo.base}`);
  const current = await run("git", ["branch", "--show-current"], repo.root);
  if (current !== repo.base) throw new Error(`main checkout is on ${current || "a detached HEAD"}, not ${repo.base}`);
  if (await run("git", ["status", "--porcelain", "--untracked-files=no"], repo.root)) {
    throw new Error(`main checkout has uncommitted changes`);
  }
  try {
    await run("git", ["merge", "--no-ff", "--no-edit", s.branch], repo.root);
  } catch {
    await tryRun("git", ["merge", "--abort"], repo.root);
    throw new Error(`merge conflicts; rebase ${s.branch} onto ${repo.base} in the worktree first`);
  }
  return `merged ${s.branch} into ${repo.base}; press x to remove the worktree`;
}

/** Push the branch and open a PR. Takes over the terminal. */
export function openPullRequest(s: Session): void {
  if (!s.branch) throw new Error("worktree has a detached HEAD");
  console.clear();
  if (s.dirty) console.log(`note: ${s.id} has uncommitted changes that won't be in the PR\n`);
  const pushed = runInteractive("git", ["push", "-u", "origin", s.branch], s.path) === 0;
  if (pushed) runInteractive("gh", ["pr", "create", "--fill", "--head", s.branch], s.path);
  pressEnterToContinue();
}

/** Show the session's changes against the base in git's pager. Takes over the terminal. */
export async function showDiff(repo: Repo, s: Session): Promise<void> {
  const mergeBase = await run("git", ["merge-base", repo.base, "HEAD"], s.path);
  // git's default `less -FRX` quits instantly on short diffs, which would just flash.
  const customPager = process.env.GIT_PAGER || (await tryRun("git", ["config", "core.pager"], s.path));
  const pager = customPager ? [] : ["-c", "core.pager=less -R"];
  runInteractive("git", [...pager, "diff", "--stat", "--patch", mergeBase], s.path);
}
