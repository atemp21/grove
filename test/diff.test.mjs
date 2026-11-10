import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git, loadGrove, makeRepo, tempDir, write } from "./helpers.mjs";

const g = await loadGrove();

/** A repo with a worktree for session `id`, branched from main. */
async function worktree(id, files) {
  const root = makeRepo(tempDir(), `diff-${id}`, files);
  const repo = await g.loadRepo(root);
  const path = join(tempDir(), id);
  git(root, "worktree", "add", "-q", "-b", id, path);
  return { repo, path };
}

const byPath = (files) => Object.fromEntries(files.map((f) => [f.path, f]));

test("includes new untracked files, uncommitted edits and committed work", async () => {
  const { repo, path } = await worktree("one", { "a.txt": "a\n", "gone.txt": "bye\n", "old.txt": "keep me\nas is\n" });
  write(path, { "b.txt": "committed\n" });
  git(path, "add", "-A");
  git(path, "commit", "-q", "-m", "work");
  write(path, { "a.txt": "a\nmore\n", "new/untracked.txt": "x\ny\n" });
  rmSync(join(path, "gone.txt"));
  git(path, "mv", "old.txt", "renamed.txt");

  const { files, since } = await g.loadDiff(repo, path, "one");
  const f = byPath(files);
  assert.deepEqual(Object.keys(f).sort(), ["a.txt", "b.txt", "gone.txt", "new/untracked.txt", "renamed.txt"]);
  assert.equal(f["new/untracked.txt"].status, "added");
  assert.equal(f["new/untracked.txt"].added, 2);
  assert.deepEqual(f["new/untracked.txt"].lines, ["@@ -0,0 +1,2 @@", "+x", "+y"]);
  assert.equal(f["b.txt"].status, "added");
  assert.equal(f["a.txt"].status, "modified");
  assert.deepEqual([f["a.txt"].added, f["a.txt"].deleted], [1, 0]);
  assert.equal(f["gone.txt"].status, "deleted");
  assert.equal(f["renamed.txt"].status, "renamed");
  assert.equal(f["renamed.txt"].oldPath, "old.txt");
  assert.equal(since, null, "no last look yet");

  // The real index and working tree are left alone.
  assert.match(git(path, "status", "--porcelain"), /\?\? new\//);
});

test("since the last look shows only what changed after it", async () => {
  const { repo, path } = await worktree("two", { "a.txt": "a\n" });
  write(path, { "a.txt": "a\nfirst\n", "b.txt": "b\n" });
  const first = await g.loadDiff(repo, path, "two");
  g.markSeen(repo, "two", first.commit);

  assert.deepEqual((await g.loadDiff(repo, path, "two")).since, [], "nothing new yet");

  write(path, { "c.txt": "c\n" });
  const second = await g.loadDiff(repo, path, "two");
  assert.deepEqual(second.files.map((f) => f.path).sort(), ["a.txt", "b.txt", "c.txt"]);
  assert.deepEqual(second.since.map((f) => f.path), ["c.txt"]);
});

test("a last look that git no longer has counts as none", async () => {
  const { repo, path } = await worktree("three", { "a.txt": "a\n" });
  g.markSeen(repo, "three", "0".repeat(40));
  write(path, { "a.txt": "b\n" });
  assert.equal((await g.loadDiff(repo, path, "three")).since, null);
});

test("parsePatch handles odd paths, binaries and control characters", () => {
  const patch = [
    "diff --git a/has space.txt b/has space.txt",
    "index 1..2 100644",
    "--- a/has space.txt",
    "+++ b/has space.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new\ttabbed \u001b]52;c;ZXZpbA==\u0007",
    "diff --git a/img.png b/img.png",
    "new file mode 100644",
    "index 0..1",
    "Binary files /dev/null and b/img.png differ",
    "",
  ].join("\n");
  const [text, bin] = g.parsePatch(patch);
  assert.equal(text.path, "has space.txt");
  assert.deepEqual([text.added, text.deleted], [1, 1]);
  assert.equal(text.lines[2], "+new    tabbed ]52;c;ZXZpbA==");
  assert.equal(bin.path, "img.png");
  assert.equal(bin.status, "added");
  assert.equal(bin.binary, true);
  assert.deepEqual(bin.lines, []);
});
