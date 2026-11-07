import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git, loadGrove, makeRepo, tempDir, write } from "./helpers.mjs";

const g = await loadGrove();
const repo = await g.loadRepo(makeRepo(tempDir(), "states"));

/** Write a status file as the hooks would, and read back the session's state and activity. */
function stateFor(content) {
  mkdirSync(join(g.home, "status"), { recursive: true });
  writeFileSync(join(g.home, "status", `${repo.key}__s`), content);
  const [s] = g.refreshStates(repo, [{ id: "s" }]);
  return { state: s.state, activity: s.activity };
}

test("slug keeps ids safe for paths and tmux", () => {
  assert.equal(g.slug("feature/login page"), "feature-login-page");
  assert.equal(g.slug("../../etc"), "etc");
  assert.equal(g.slug("a:b.c"), "a-b-c");
});

test("activity describes the tool in use", () => {
  const payload = { cwd: "/w", tool_name: "Edit", tool_input: { file_path: "/w/src/App.tsx" } };
  assert.deepEqual(stateFor(`busy\n${JSON.stringify(payload)}`), { state: "busy", activity: "editing src/App.tsx" });
  assert.equal(stateFor(`busy\n${JSON.stringify({ prompt: "fix\n the  bug" })}`).activity, "“fix the bug”");
  assert.equal(stateFor(`waiting\n${JSON.stringify({ message: "Allow Bash?" })}`).activity, "Allow Bash?");
  assert.equal(stateFor(`idle\n{}`).activity, null);
});

test("activity drops terminal control characters", () => {
  const payload = { tool_name: "Bash", tool_input: { command: "echo \u001b]52;c;ZXZpbA==\u0007 hi\u009b2J" } };
  const { activity } = stateFor(`busy\n${JSON.stringify(payload)}`);
  assert.doesNotMatch(activity, /\p{Cc}/u);
  assert.equal(activity, "$ echo ]52;c;ZXZpbA== hi2J");
});

test("a truncated payload still yields the tool and its input", () => {
  const big = JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/x/out.txt", content: "x".repeat(40000) } });
  assert.equal(stateFor(`busy\n${big}`).activity, "writing /x/out.txt");
});

test("predicts conflicts between worktrees, uncommitted changes included", async () => {
  const root = makeRepo(tempDir(), "conflicts", { "a.txt": "base\n", "b.txt": "base\n" });
  const r = await g.loadRepo(root);
  const dirs = tempDir();
  const session = (id, edits) => {
    const path = join(dirs, id);
    git(root, "worktree", "add", "-q", "-b", id, path);
    write(path, edits);
    return { id, path, ahead: 0, added: 1, deleted: 1, untracked: 0 };
  };
  const one = session("one", { "a.txt": "one\n" });
  const two = session("two", { "a.txt": "two\n" });
  const three = session("three", { "b.txt": "three\n" });

  const sessions = [one, two, three];
  const found = await g.findConflicts(r, sessions, await g.snapshotAll(sessions));
  assert.deepEqual(found.get("one"), [{ with: "two", files: ["a.txt"] }]);
  assert.deepEqual(found.get("two"), [{ with: "one", files: ["a.txt"] }]);
  assert.equal(found.get("three"), undefined);
  assert.equal(git(one.path, "status", "--porcelain"), "M a.txt", "the worktree is left as it was");
});
