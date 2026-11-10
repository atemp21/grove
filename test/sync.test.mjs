import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { git, loadGrove, makeRepo, tempDir, write } from "./helpers.mjs";

const g = await loadGrove();

/** A bare "origin", a clone of it to sync, and a second clone standing in for teammates pushing. */
function setup(name) {
  const dir = tempDir();
  const seed = makeRepo(dir, `${name}-seed`, { "a.txt": "a\n" });
  const origin = join(dir, `${name}-origin.git`);
  git(dir, "clone", "-q", "--bare", seed, origin);
  const local = join(dir, name);
  git(dir, "clone", "-q", origin, local);
  const other = join(dir, `${name}-other`);
  git(dir, "clone", "-q", origin, other);
  const push = (files) => {
    write(other, files);
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "upstream work");
    git(other, "push", "-q", "origin", "main");
  };
  return { local, push };
}

test("fast-forwards the checked-out base and its files", async () => {
  const { local, push } = setup("ff");
  const repo = await g.loadRepo(local);
  push({ "b.txt": "b\n" });
  push({ "c.txt": "c\n" });
  const result = await g.syncBase(repo);
  assert.equal(result.kind, "synced");
  assert.equal(result.pulled, 2);
  assert.equal(git(local, "show", "HEAD:c.txt"), "c");
  assert.equal(git(local, "status", "--porcelain"), "");

  assert.equal((await g.syncBase(repo)).pulled, 0, "a second sync has nothing to do");
});

test("moves the base ref when no checkout has it", async () => {
  const { local, push } = setup("ref");
  git(local, "switch", "-q", "-c", "elsewhere");
  const repo = await g.loadRepo(local);
  repo.base = "main";
  push({ "b.txt": "b\n" });
  assert.equal((await g.syncBase(repo)).pulled, 1);
  assert.equal(git(local, "rev-parse", "main"), git(local, "rev-parse", "origin/main"));
  assert.equal(git(local, "branch", "--show-current"), "elsewhere");
});

test("leaves a base with unpushed commits alone when the remote moved too", async () => {
  const { local, push } = setup("diverged");
  const repo = await g.loadRepo(local);
  write(local, { "mine.txt": "mine\n" });
  git(local, "add", "-A");
  git(local, "commit", "-q", "-m", "local work");
  const before = git(local, "rev-parse", "main");

  assert.deepEqual(
    { ...(await g.syncBase(repo)), at: undefined },
    { kind: "synced", upstream: "origin/main", ahead: 1, pulled: 0, at: undefined },
  );
  push({ "b.txt": "b\n" });
  const result = await g.syncBase(repo);
  assert.equal(result.kind, "diverged");
  assert.deepEqual([result.ahead, result.behind], [1, 1]);
  assert.equal(git(local, "rev-parse", "main"), before);
});

test("reports local edits in the way instead of touching them", async () => {
  const { local, push } = setup("dirty");
  const repo = await g.loadRepo(local);
  push({ "a.txt": "upstream\n" });
  write(local, { "a.txt": "my edit\n" });
  const result = await g.syncBase(repo);
  assert.equal(result.kind, "error");
  assert.match(result.message, /uncommitted changes/);
  assert.equal(git(local, "show", ":a.txt"), "a");
  assert.equal(git(local, "diff", "--name-only"), "a.txt");
});

test("a base without an upstream has nothing to sync", async () => {
  const repo = await g.loadRepo(makeRepo(tempDir(), "lonely"));
  assert.deepEqual(await g.syncBase(repo), { kind: "no-upstream" });
});
