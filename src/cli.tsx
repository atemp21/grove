#!/usr/bin/env node
import { render } from "ink";
import { App } from "./App.js";
import { tryRun } from "./exec.js";
import { loadRepo } from "./repo.js";
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

let repo;
try {
  repo = await loadRepo(process.cwd());
} catch {
  console.error("grove: not inside a git repository");
  process.exit(1);
}

writeClaudeSettings();
const app = render(<App repo={repo} />);
await app.waitUntilExit();
