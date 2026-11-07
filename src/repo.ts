import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { run, tryRun } from "./exec.js";

export const GROVE_HOME = process.env.GROVE_HOME ?? join(homedir(), ".grove");

/** Optional per-repo config, read from `.grove.json` in the main checkout. */
export type GroveConfig = {
  /** Branch new worktrees start from and diffs compare against. */
  base?: string;
  /** Git pathspec globs of untracked/ignored files to copy into new worktrees. */
  copy?: string[];
  /** Shell command run in the new worktree before Claude starts. */
  setup?: string;
  /** Extra arguments passed to `claude`. */
  claudeArgs?: string[];
  /** Shell command that runs the tests, used to compare fan-out candidates. */
  test?: string;
};

export type Repo = {
  root: string;
  name: string;
  /** Names this repo's worktrees, tmux session and state files; the name, unless another repo has it. */
  key: string;
  base: string;
  config: GroveConfig;
  worktreesDir: string;
  tmuxSession: string;
  /** Whether the user approved the commands this repo runs (see repoCommands). */
  trusted: boolean;
};

const DEFAULT_COPY = [":(glob)**/.env*", ":(glob).claude/settings.local.json"];

export async function loadRepo(cwd: string): Promise<Repo> {
  const porcelain = await run("git", ["worktree", "list", "--porcelain"], cwd);
  // The first entry is always the main worktree, even when run from inside a linked one.
  const root = porcelain.split("\n")[0].replace(/^worktree /, "");
  const name = basename(root);
  // Status files hold hook payloads, which can include commands with secrets in them.
  mkdirSync(GROVE_HOME, { recursive: true, mode: 0o700 });
  chmodSync(GROVE_HOME, 0o700);
  const key = claimKey(root, name);

  const configPath = join(root, ".grove.json");
  const config: GroveConfig = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf8"))
    : {};

  const repo: Repo = {
    root,
    name,
    key,
    base: config.base ?? (await detectBase(root)),
    config,
    worktreesDir: join(GROVE_HOME, "worktrees", key),
    tmuxSession: `grove-${key}`.replace(/[.:]/g, "_"),
    trusted: false,
  };
  repo.trusted = isTrusted(repo);
  return repo;
}

const readJson = <T>(file: string, fallback: T): T => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback);

/**
 * The first repo seen with a given folder name keeps it as its key, so existing
 * worktrees and tmux sessions stay where they are; later repos with the same
 * name get a suffix from their path.
 */
function claimKey(root: string, name: string): string {
  const file = join(GROVE_HOME, "repos.json");
  const owners = readJson<Record<string, string>>(file, {});
  const owned = Object.entries(owners).find(([, r]) => r === root)?.[0];
  if (owned) return owned;
  const key = owners[name] === undefined ? name : `${name}-${createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
  writeFileSync(file, JSON.stringify({ ...owners, [key]: root }, null, 2));
  return key;
}

async function detectBase(root: string): Promise<string> {
  const originHead = await tryRun("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root);
  if (originHead) return originHead.replace(/^origin\//, "");
  return (await run("git", ["branch", "--show-current"], root)) || "main";
}

export function copyPatterns(repo: Repo): string[] {
  return repo.config.copy?.map((p) => (p.startsWith(":") ? p : `:(glob)${p}`)) ?? DEFAULT_COPY;
}

/** The setup command from config, or one guessed from lockfiles in the repo root. */
function configuredSetup(repo: Repo): string | undefined {
  if (repo.config.setup !== undefined) return repo.config.setup || undefined;
  const has = (f: string) => existsSync(join(repo.root, f));
  if (has("pnpm-lock.yaml")) return "pnpm install";
  if (has("yarn.lock")) return "yarn install";
  if (has("bun.lock") || has("bun.lockb")) return "bun install";
  if (has("package-lock.json")) return "npm install";
  if (has("uv.lock")) return "uv sync";
  return undefined;
}

/** The test command from config, or the package.json `test` script run with the repo's package manager. */
function configuredTest(repo: Repo): string | undefined {
  if (repo.config.test !== undefined) return repo.config.test || undefined;
  const pkgPath = join(repo.root, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
  if (!pkg.scripts?.test) return undefined;
  const install = configuredSetup(repo);
  const pm = install?.match(/^(pnpm|yarn|bun) /)?.[1] ?? "npm";
  return pm === "bun" ? "bun run test" : `${pm} test`;
}

export const setupCommand = (repo: Repo) => (repo.trusted ? configuredSetup(repo) : undefined);
export const testCommand = (repo: Repo) => (repo.trusted ? configuredTest(repo) : undefined);
export const claudeArgs = (repo: Repo) => (repo.trusted ? (repo.config.claudeArgs ?? []) : []);

/**
 * What a repo makes grove run: shell commands and `claude` flags from its
 * `.grove.json`, and installs and tests that run its own scripts. A cloned repo
 * could put anything here, so none of it runs until the user approves it.
 */
export function repoCommands(repo: Repo): { setup?: string; test?: string; claudeArgs: string[] } {
  return { setup: configuredSetup(repo), test: configuredTest(repo), claudeArgs: repo.config.claudeArgs ?? [] };
}

/** `claude` flags that loosen permissions or load other config; called out when asking for trust. */
const RISKY_FLAGS = [
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--permission-mode",
  "--allowedTools",
  "--allowed-tools",
  "--mcp-config",
  "--settings",
  "--add-dir",
  "--plugin-dir",
];
export const isRiskyFlag = (arg: string) => RISKY_FLAGS.some((f) => arg === f || arg.startsWith(`${f}=`));

const TRUST_FILE = join(GROVE_HOME, "trusted.json");
const commandsHash = (repo: Repo) => createHash("sha256").update(JSON.stringify(repoCommands(repo))).digest("hex");
const hasCommands = (repo: Repo) => {
  const c = repoCommands(repo);
  return Boolean(c.setup || c.test || c.claudeArgs.length);
};

/** Trusted when there's nothing to run, or the user approved exactly these commands. */
function isTrusted(repo: Repo): boolean {
  return !hasCommands(repo) || readJson<Record<string, string>>(TRUST_FILE, {})[repo.root] === commandsHash(repo);
}

/** Remember that the user approved this repo's current commands; any change to them asks again. */
export function trustRepo(repo: Repo): void {
  const trusted = readJson<Record<string, string>>(TRUST_FILE, {});
  writeFileSync(TRUST_FILE, JSON.stringify({ ...trusted, [repo.root]: commandsHash(repo) }, null, 2), { mode: 0o600 });
  repo.trusted = true;
}
