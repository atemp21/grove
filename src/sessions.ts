import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { run, runInteractive, tryRun, pressEnterToContinue } from "./exec.js";
import { GROVE_HOME, claudeArgs, copyPatterns, setupCommand, type Repo } from "./repo.js";
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
  /** What Claude is doing right now, e.g. "editing src/App.tsx". */
  activity: string | null;
  added: number;
  deleted: number;
  untracked: number;
  /** Paths changed against the base, untracked files included. */
  files: string[];
  ahead: number;
  dirty: boolean;
  /** When the worktree was created, for listing the newest first. */
  created: number;
};

const STATUS_DIR = join(GROVE_HOME, "status");
/** Name of the integration preview's worktree directory and tmux window; never a session id. */
export const PREVIEW_ID = "_preview";
const SETTINGS_PATH = join(GROVE_HOME, "claude-settings.json");

export const slug = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const statusFile = (repo: Repo, id: string) => join(STATUS_DIR, `${slug(repo.key)}__${id}`);

/**
 * Hooks that make each Claude session report its state to the file named by
 * $GROVE_STATUS_FILE: the state on the first line, then the hook's JSON payload,
 * written atomically. Loaded with `claude --settings`, so the user's own
 * settings are left alone and sessions started outside grove are unaffected.
 */
export function writeClaudeSettings(): void {
  mkdirSync(STATUS_DIR, { recursive: true });
  const report = (state: ClaudeState) => [
    {
      hooks: [
        {
          type: "command",
          command: `[ -n "$GROVE_STATUS_FILE" ] && { echo ${state}; cat; } > "$GROVE_STATUS_FILE.tmp" && mv "$GROVE_STATUS_FILE.tmp" "$GROVE_STATUS_FILE"; exit 0`,
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
  const preview = join(repo.worktreesDir, PREVIEW_ID);
  for (const block of out.split("\n\n")) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (!path || path === repo.root || path === preview || /^prunable/m.test(block)) continue;
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null;
    trees.push({ path, branch });
  }
  return trees;
}

const idFor = (wt: Worktree) => slug(wt.branch ?? basename(wt.path));

/**
 * When a worktree was made: git writes its `.git` file once, at `worktree add`.
 * Birth time where the filesystem has one; otherwise that file's mtime.
 */
function createdAt(path: string): number {
  try {
    const st = statSync(join(path, ".git"));
    return st.birthtimeMs || st.mtimeMs;
  } catch {
    return 0;
  }
}

/** Read the start of a file; hook payloads with large tool inputs can be big. */
function readHead(file: string, bytes = 16384): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    return buf.toString("utf8", 0, readSync(fd, buf, 0, bytes, 0));
  } finally {
    closeSync(fd);
  }
}

type HookPayload = {
  hook_event_name?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  prompt?: string;
  message?: string;
};

function parsePayload(text: string): HookPayload {
  try {
    return JSON.parse(text) as HookPayload;
  } catch {
    // Truncated by readHead: pull out the fields that matter by hand.
    const field = (name: string) => {
      const raw = text.match(new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`))?.[1];
      return raw === undefined ? undefined : (JSON.parse(`"${raw}"`) as string);
    };
    const input: Record<string, unknown> = {};
    for (const k of ["file_path", "command", "description"]) if (field(k)) input[k] = field(k);
    return { cwd: field("cwd"), tool_name: field("tool_name"), tool_input: input };
  }
}

// Control characters are dropped too: Ink passes OSC sequences through, which could set the clipboard or title.
const oneLine = (s: string) => s.replace(/\s+/g, " ").replace(/\p{Cc}/gu, "").trim();

/** Describe a hook payload in a few words, or null if there's nothing to say. */
function describe(state: ClaudeState, p: HookPayload): string | null {
  if (state === "waiting") return p.message ? oneLine(p.message) : null;
  if (state !== "busy") return null;
  if (p.prompt !== undefined) return `“${oneLine(p.prompt)}”`;
  const tool = p.tool_name;
  if (!tool) return null;
  const input = p.tool_input ?? {};
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  const path = (k: string) => {
    const f = str(k);
    const rel = f && p.cwd ? relative(p.cwd, f) : f;
    return rel.startsWith("..") ? f : rel;
  };
  switch (tool) {
    case "Read":
      return `reading ${path("file_path")}`;
    case "Edit":
    case "MultiEdit":
      return `editing ${path("file_path")}`;
    case "Write":
      return `writing ${path("file_path")}`;
    case "NotebookEdit":
      return `editing ${path("notebook_path")}`;
    case "Bash":
      return `$ ${oneLine(str("command"))}`;
    case "Grep":
      return `searching for ${str("pattern")}`;
    case "Glob":
      return `finding ${str("pattern")}`;
    case "WebFetch":
      return `fetching ${str("url").replace(/^https?:\/\//, "")}`;
    case "WebSearch":
      return `searching the web for ${str("query")}`;
    case "Task":
    case "Agent":
      return `agent: ${str("description")}`;
    case "TodoWrite":
      return "planning";
  }
  const mcp = tool.match(/^mcp__(.+?)__(.+)$/);
  return mcp ? `${mcp[1]}: ${mcp[2]}` : tool;
}

function readState(repo: Repo, id: string): { state: ClaudeState; since: Date | null; activity: string | null } {
  const file = statusFile(repo, id);
  if (!existsSync(file)) return { state: "unknown", since: null, activity: null };
  const text = readHead(file);
  const newline = text.indexOf("\n");
  const state = (newline < 0 ? text : text.slice(0, newline)).trim() as ClaudeState;
  const payload = newline < 0 ? {} : parsePayload(text.slice(newline + 1));
  const activity = describe(state, payload);
  return { state, since: statSync(file).mtime, activity: activity && oneLine(activity) };
}

/** Re-read just the hook state of each session; cheap enough to poll often. */
export function refreshStates(repo: Repo, sessions: Session[]): Session[] {
  return sessions.map((s) => {
    const { state, since, activity } = readState(repo, s.id);
    return { ...s, state, stateSince: since, activity };
  });
}

async function changeStats(repo: Repo, path: string) {
  const mergeBase = await tryRun("git", ["merge-base", repo.base, "HEAD"], path);
  const [numstat, untracked, ahead, status] = await Promise.all([
    mergeBase ? tryRun("git", ["diff", "--numstat", mergeBase], path) : null,
    tryRun("git", ["ls-files", "--others", "--exclude-standard"], path),
    tryRun("git", ["rev-list", "--count", `${repo.base}..HEAD`], path),
    tryRun("git", ["status", "--porcelain"], path),
  ]);
  // Lines are "added<TAB>deleted<TAB>path", with "-" counts for binary files.
  const rows = numstat ? numstat.split("\n").map((l) => l.split("\t")) : [];
  const newFiles = untracked ? untracked.split("\n") : [];
  return {
    added: rows.reduce((n, [a]) => n + (Number(a) || 0), 0),
    deleted: rows.reduce((n, [, d]) => n + (Number(d) || 0), 0),
    untracked: newFiles.length,
    files: [...rows.map((r) => r.slice(2).join("\t")), ...newFiles],
    ahead: Number(ahead ?? 0),
    dirty: Boolean(status),
  };
}

/** Every session in the repo, newest first. */
export async function listSessions(repo: Repo): Promise<Session[]> {
  const [trees, windows] = await Promise.all([listWorktrees(repo), tmux.listWindows(repo.tmuxSession)]);
  const sessions = await Promise.all(
    trees.map(async (wt) => {
      const id = idFor(wt);
      const { state, since, activity } = readState(repo, id);
      return {
        id,
        path: wt.path,
        branch: wt.branch,
        running: windows.has(id),
        state,
        stateSince: since,
        activity,
        ...(await changeStats(repo, wt.path)),
        created: createdAt(wt.path),
      };
    }),
  );
  return sessions.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
}

async function startClaude(repo: Repo, id: string, cwd: string, firstRun: boolean, prompt?: string): Promise<void> {
  const claude = ["claude", "--settings", shq(SETTINGS_PATH), ...claudeArgs(repo).map(shq)];
  // Resume the previous conversation if this worktree has had one.
  const resume = existsSync(statusFile(repo, id)) ? " --continue" : "";
  const setup = firstRun ? setupCommand(repo) : undefined;
  const initial = prompt ? ` ${shq(prompt)}` : "";
  const command = [setup, `exec ${claude.join(" ")}${resume}${initial}`].filter(Boolean).join("; ");
  await tmux.startWindow({
    session: repo.tmuxSession,
    window: id,
    cwd,
    command,
    env: { GROVE_STATUS_FILE: statusFile(repo, id) },
  });
}

/** Copy the gitignored files named by the `copy` config (env files by default) from the main checkout. */
export async function copyIgnoredFiles(repo: Repo, path: string): Promise<void> {
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
}

/**
 * Create a worktree for `branch` (new or existing), copy env files, and start
 * Claude in it, optionally with `prompt` as its first message.
 */
export async function createSession(repo: Repo, branch: string, prompt?: string): Promise<string> {
  const id = slug(branch);
  if (!id) throw new Error("invalid branch name");
  if (id === PREVIEW_ID) throw new Error(`${PREVIEW_ID} is reserved for the preview`);
  const path = join(repo.worktreesDir, id);
  if (existsSync(path)) throw new Error(`${path} already exists`);
  mkdirSync(repo.worktreesDir, { recursive: true });

  const exists = (await tryRun("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo.root)) !== null;
  await run(
    "git",
    exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, repo.base],
    repo.root,
  );

  await copyIgnoredFiles(repo, path);
  rmSync(statusFile(repo, id), { force: true });
  await startClaude(repo, id, path, true, prompt);
  return id;
}

/** Attach to a session's tmux window as it is, e.g. right after creating it. */
export const attachSession = (repo: Repo, id: string) => tmux.attach(repo.tmuxSession, id);

/** Attach to a session's tmux window, relaunching Claude first if it has exited. */
export async function openSession(repo: Repo, s: Session) {
  if (!s.running) await startClaude(repo, s.id, s.path, false);
  return tmux.attach(repo.tmuxSession, s.id);
}

/** Remove a worktree. With `discardBranch`, its branch is deleted even if unmerged. */
export async function removeSession(repo: Repo, s: Session, force: boolean, discardBranch = false): Promise<string> {
  await tmux.killWindow(repo.tmuxSession, s.id);
  await run("git", ["worktree", "remove", ...(force ? ["--force"] : []), s.path], repo.root);
  rmSync(statusFile(repo, s.id), { force: true });
  if (!s.branch) return `removed ${s.id}`;
  const deleted = (await tryRun("git", ["branch", discardBranch ? "-D" : "-d", s.branch], repo.root)) !== null;
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
