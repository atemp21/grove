#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { render } from "ink";
import { App } from "./App.js";
import { tryRun } from "./exec.js";
import { isRiskyFlag, loadRepo, repoCommands, trustRepo, type Repo } from "./repo.js";
import { writeClaudeSettings } from "./sessions.js";

const HELP = `grove - run Claude Code sessions in git worktrees

Usage: grove           open the dashboard for the repo in the current directory

Sessions run in the tmux session "grove-<repo>" and keep running after you quit.
Optional per-repo config in .grove.json at the repo root:
  { "base": "main", "copy": ["**/.env*"], "setup": "pnpm install", "claudeArgs": [] }`;

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}

if ((await tryRun("tmux", ["-V"])) === null) {
  console.error("grove needs tmux: brew install tmux");
  process.exit(1);
}

/** Show what the repo would make grove run and ask before allowing any of it. */
async function askTrust(repo: Repo): Promise<void> {
  const { setup, test, claudeArgs } = repoCommands(repo);
  console.log(`${repo.root} wants grove to run:`);
  if (setup) console.log(`  setup        ${setup}`);
  if (test) console.log(`  test         ${test}`);
  if (claudeArgs.length) {
    console.log(`  claude args  ${claudeArgs.map((a) => JSON.stringify(a)).join(" ")}`);
    const risky = claudeArgs.filter(isRiskyFlag);
    if (risky.length) console.log(`  ⚠ ${risky.join(", ")} loosens Claude's permissions or loads other config`);
  }
  if (!process.stdin.isTTY) {
    console.log("Not a terminal, so none of it will run.\n");
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Trust these? Only say yes if you trust this repo. [y/N] ");
  rl.close();
  if (/^y(es)?$/i.test(answer.trim())) trustRepo(repo);
  else console.log("Running without them: no setup, no tests, no extra claude args.\n");
}

let repo: Repo;
try {
  repo = await loadRepo(process.cwd());
} catch {
  console.error("grove: not inside a git repository");
  process.exit(1);
}

if (!repo.trusted) await askTrust(repo);
writeClaudeSettings();
const app = render(<App repo={repo} />);
await app.waitUntilExit();
