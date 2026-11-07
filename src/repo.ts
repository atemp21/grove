import { existsSync, readFileSync } from "node:fs";
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
  base: string;
  config: GroveConfig;
  worktreesDir: string;
  tmuxSession: string;
};

const DEFAULT_COPY = [":(glob)**/.env*", ":(glob).claude/settings.local.json"];

export async function loadRepo(cwd: string): Promise<Repo> {
  const porcelain = await run("git", ["worktree", "list", "--porcelain"], cwd);
  // The first entry is always the main worktree, even when run from inside a linked one.
  const root = porcelain.split("\n")[0].replace(/^worktree /, "");
  const name = basename(root);

  const configPath = join(root, ".grove.json");
  const config: GroveConfig = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf8"))
    : {};

  return {
    root,
    name,
    base: config.base ?? (await detectBase(root)),
    config,
    worktreesDir: join(GROVE_HOME, "worktrees", name),
    tmuxSession: `grove-${name}`.replace(/[.:]/g, "_"),
  };
}

async function detectBase(root: string): Promise<string> {
  const originHead = await tryRun("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root);
  if (originHead) return originHead.replace(/^origin\//, "");
  return (await run("git", ["branch", "--show-current"], root)) || "main";
}

export function copyPatterns(repo: Repo): string[] {
  return repo.config.copy?.map((p) => (p.startsWith(":") ? p : `:(glob)${p}`)) ?? DEFAULT_COPY;
}

/** Guess an install command from lockfiles in the repo root. */
export function setupCommand(repo: Repo): string | undefined {
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
export function testCommand(repo: Repo): string | undefined {
  if (repo.config.test !== undefined) return repo.config.test || undefined;
  const pkgPath = join(repo.root, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
  if (!pkg.scripts?.test) return undefined;
  const install = setupCommand(repo);
  const pm = install?.match(/^(pnpm|yarn|bun) /)?.[1] ?? "npm";
  return pm === "bun" ? "bun run test" : `${pm} test`;
}
