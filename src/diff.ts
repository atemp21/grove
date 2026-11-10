import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { snapshot } from "./conflicts.js";
import { run, runInteractive, tryRun } from "./exec.js";
import { GROVE_HOME, type Repo } from "./repo.js";
import { slug } from "./sessions.js";

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

/** One file's change: its counts and the patch lines from the first hunk on. */
export type FileDiff = {
  path: string;
  oldPath?: string;
  status: FileStatus;
  added: number;
  deleted: number;
  binary: boolean;
  lines: string[];
};

export type SessionDiff = {
  /** Every change against the base, uncommitted and untracked files included. */
  files: FileDiff[];
  /** The snapshot these files were read from; marking it seen makes it the next "last look". */
  commit: string;
  /** What changed since the last look, or null if there wasn't one (or it can't be found any more). */
  since: FileDiff[] | null;
};

const SEEN_DIR = join(GROVE_HOME, "seen");
const seenFile = (repo: Repo, id: string) => join(SEEN_DIR, `${slug(repo.key)}__${id}`);

function readSeen(repo: Repo, id: string): string | null {
  const file = seenFile(repo, id);
  return existsSync(file) ? readFileSync(file, "utf8").trim() || null : null;
}

/** Remember `commit` as what the user last looked at in this session. */
export function markSeen(repo: Repo, id: string, commit: string): void {
  mkdirSync(SEEN_DIR, { recursive: true });
  writeFileSync(seenFile(repo, id), commit);
}

/** Git quotes paths with unusual characters in C style; JSON reads the same escapes for what quotePath=false leaves. */
function unquote(p: string): string {
  if (!p.startsWith('"')) return p;
  try {
    return JSON.parse(p) as string;
  } catch {
    return p.slice(1, -1);
  }
}

/**
 * The path in a "diff --git a/P b/P" header. Renames and binary files can leave
 * this as the only place the path appears; a rename's real paths come later.
 * Both halves are the same length, so the first half is "a/P" (maybe quoted).
 */
function headerPath(line: string): string {
  const rest = line.slice("diff --git ".length);
  const first = unquote(rest.slice(0, (rest.length - 1) / 2));
  return first.startsWith("a/") ? first.slice(2) : first;
}

// Diff content is untrusted: tabs would throw off the layout, and control characters
// could drive the terminal (set the title, the clipboard, move the cursor).
const clean = (line: string) => line.replace(/\t/g, "    ").replace(/\p{Cc}/gu, "");

/** Split a `git diff` patch into its files. Expects a/ and b/ prefixes and no color. */
export function parsePatch(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let inHunks = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = { path: headerPath(line), status: "modified", added: 0, deleted: 0, binary: false, lines: [] };
      files.push(cur);
      inHunks = false;
      continue;
    }
    if (!cur) continue;
    if (!inHunks) {
      if (line.startsWith("@@")) inHunks = true;
      else if (line.startsWith("new file mode")) cur.status = "added";
      else if (line.startsWith("deleted file mode")) cur.status = "deleted";
      else if (line.startsWith("rename from ")) {
        cur.status = "renamed";
        cur.oldPath = unquote(line.slice("rename from ".length));
      } else if (line.startsWith("rename to ")) cur.path = unquote(line.slice("rename to ".length));
      else if (line.startsWith("+++ b/")) cur.path = unquote(line.slice("+++ b/".length));
      else if (line.startsWith('+++ "b/')) cur.path = unquote(`"${line.slice('+++ "b/'.length)}`);
      else if (line.startsWith("--- a/") && cur.status === "deleted") cur.path = unquote(line.slice("--- a/".length));
      else if (line.startsWith("Binary files ") || line === "GIT binary patch") cur.binary = true;
      if (!inHunks) continue;
    }
    if (line.startsWith("+")) cur.added++;
    else if (line.startsWith("-")) cur.deleted++;
    cur.lines.push(clean(line));
  }
  // A patch ends with a newline, which would otherwise leave an empty context line on the last file.
  const last = files.at(-1);
  if (last?.lines.at(-1) === "") last.lines.pop();
  return files;
}

const DIFF = [
  "-c", "core.quotePath=false",
  "diff", "--no-color", "--no-ext-diff", "--no-relative", "-M",
  "--src-prefix=a/", "--dst-prefix=b/",
];

/**
 * A session's changes against the base as files on disk have them, new files
 * included, plus what changed since the user last looked.
 */
export async function loadDiff(repo: Repo, path: string, id: string): Promise<SessionDiff> {
  const [mergeBase, snap] = await Promise.all([
    run("git", ["merge-base", repo.base, "HEAD"], path),
    snapshot(path),
  ]);
  const seen = readSeen(repo, id);
  const [patch, sincePatch] = await Promise.all([
    run("git", [...DIFF, mergeBase, snap.commit], path),
    // The seen commit is unreferenced, so git gc may have dropped it; then there's no last look to compare with.
    seen && seen !== snap.commit ? tryRun("git", [...DIFF, seen, snap.commit], path) : null,
  ]);
  return {
    files: parsePatch(patch),
    commit: snap.commit,
    since: seen === snap.commit ? [] : sincePatch === null ? null : parsePatch(sincePatch),
  };
}

/**
 * Show a session's whole patch against the base in git's pager, new files
 * included. Takes over the terminal.
 */
export async function showDiff(repo: Repo, path: string): Promise<void> {
  const [mergeBase, snap] = await Promise.all([run("git", ["merge-base", repo.base, "HEAD"], path), snapshot(path)]);
  // git's default `less -FRX` quits instantly on short diffs, which would just flash.
  const customPager = process.env.GIT_PAGER || (await tryRun("git", ["config", "core.pager"], path));
  const pager = customPager ? [] : ["-c", "core.pager=less -R"];
  runInteractive("git", [...pager, "diff", "--stat", "--patch", "-M", mergeBase, snap.commit], path);
}
