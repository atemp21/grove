import assert from "node:assert/strict";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadGrove, makeRepo, tempDir } from "./helpers.mjs";

const g = await loadGrove();

test("GROVE_HOME is private", async () => {
  await g.loadRepo(makeRepo(tempDir(), "private"));
  assert.equal(statSync(g.home).mode & 0o777, 0o700);
});

test("repos with the same folder name get their own key", async () => {
  const first = await g.loadRepo(makeRepo(tempDir(), "app"));
  const second = await g.loadRepo(makeRepo(tempDir(), "app"));
  assert.equal(first.key, "app");
  assert.match(second.key, /^app-[0-9a-f]{8}$/);
  assert.notEqual(first.tmuxSession, second.tmuxSession);
  assert.notEqual(first.worktreesDir, second.worktreesDir);
  assert.equal((await g.loadRepo(second.root)).key, second.key, "the key is stable across runs");
});

test("a repo with nothing to run is trusted", async () => {
  const repo = await g.loadRepo(makeRepo(tempDir(), "plain"));
  assert.equal(repo.trusted, true);
});

test(".grove.json commands don't run until trusted, and changing them asks again", async () => {
  const config = { setup: "echo hi", test: "make test", claudeArgs: ["--model", "opus"] };
  const root = makeRepo(tempDir(), "configured", { ".grove.json": JSON.stringify(config) });

  const repo = await g.loadRepo(root);
  assert.equal(repo.trusted, false);
  assert.equal(g.setupCommand(repo), undefined);
  assert.equal(g.testCommand(repo), undefined);
  assert.deepEqual(g.claudeArgs(repo), []);
  assert.deepEqual(g.repoCommands(repo), config);

  g.trustRepo(repo);
  const trusted = await g.loadRepo(root);
  assert.equal(trusted.trusted, true);
  assert.equal(g.setupCommand(trusted), "echo hi");
  assert.equal(g.testCommand(trusted), "make test");
  assert.deepEqual(g.claudeArgs(trusted), ["--model", "opus"]);
  assert.equal(statSync(join(g.home, "trusted.json")).mode & 0o777, 0o600);

  writeFileSync(join(root, ".grove.json"), JSON.stringify({ ...config, setup: "echo changed" }));
  assert.equal((await g.loadRepo(root)).trusted, false);
});

test("guessed install and test commands need trust too", async () => {
  const root = makeRepo(tempDir(), "node-app", {
    "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    "pnpm-lock.yaml": "",
  });
  const repo = await g.loadRepo(root);
  assert.deepEqual(g.repoCommands(repo), { setup: "pnpm install", test: "pnpm test", claudeArgs: [] });
  assert.equal(repo.trusted, false);
});

test("risky claude flags are recognized", () => {
  assert.ok(g.isRiskyFlag("--dangerously-skip-permissions"));
  assert.ok(g.isRiskyFlag("--permission-mode=bypassPermissions"));
  assert.ok(g.isRiskyFlag("--mcp-config"));
  assert.ok(!g.isRiskyFlag("--model"));
  assert.ok(!g.isRiskyFlag("--settingsx"));
});
