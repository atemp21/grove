import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Commits need an identity, and CI machines have none configured.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
});

/** A fresh temp dir; realpath'd because git reports macOS's /var as /private/var. */
export const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "grove-test-")));

/**
 * Point grove at a private GROVE_HOME and import its modules. GROVE_HOME is read
 * at import time, so this must run before any other import of dist/.
 */
export async function loadGrove() {
  process.env.GROVE_HOME = join(tempDir(), "home");
  const [repo, sessions, conflicts, diff] = await Promise.all([
    import("../dist/repo.js"),
    import("../dist/sessions.js"),
    import("../dist/conflicts.js"),
    import("../dist/diff.js"),
  ]);
  return { home: process.env.GROVE_HOME, ...repo, ...sessions, ...conflicts, ...diff };
}

export const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

export function write(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/** A git repo at `<parent>/<name>` with `files` committed on main. */
export function makeRepo(parent, name, files = {}) {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  write(root, files);
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
  return root;
}
