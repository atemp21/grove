import { ExecError, run, tryRun } from "./exec.js";
import type { Repo } from "./repo.js";

/** How the local base branch stands against the remote branch it tracks. */
export type BaseSync =
  | { kind: "no-upstream" }
  | {
      kind: "synced";
      upstream: string;
      /** Local commits not on the remote yet, e.g. from merging a session. */
      ahead: number;
      /** Commits fast-forwarded in by this sync. */
      pulled: number;
      at: Date;
    }
  | { kind: "diverged"; upstream: string; ahead: number; behind: number; at: Date }
  | { kind: "error"; upstream: string | null; message: string; at: Date };

// A background fetch must never sit waiting for a password or passphrase nobody can see.
function quietEnv(): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  if (!process.env.GIT_SSH_COMMAND && !process.env.GIT_SSH) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  return env;
}

/** The worktree that has `branch` checked out, if any. */
async function checkedOutAt(repo: Repo, branch: string): Promise<string | null> {
  const out = await run("git", ["worktree", "list", "--porcelain"], repo.root);
  for (const block of out.split("\n\n")) {
    if (block.split("\n").includes(`branch refs/heads/${branch}`)) {
      return block.match(/^worktree (.+)$/m)?.[1] ?? null;
    }
  }
  return null;
}

const firstLine = (e: unknown) =>
  ((e instanceof ExecError ? e.stderr.trim() : "") || (e as Error).message).split("\n")[0].replace(/^(fatal|error): /, "");

/**
 * Fetch the base branch's upstream and fast-forward the local base to it.
 * Only ever fast-forwards: a base with local commits the remote doesn't have is
 * left alone, and nothing is merged, rebased or pushed.
 */
export async function syncBase(repo: Repo): Promise<BaseSync> {
  const base = repo.base;
  const upstream = await tryRun("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${base}@{upstream}`], repo.root);
  if (!upstream) return { kind: "no-upstream" };
  const at = new Date();
  try {
    const remote = await run("git", ["config", `branch.${base}.remote`], repo.root);
    const mergeRef = await run("git", ["config", `branch.${base}.merge`], repo.root);
    // A local upstream ("."), e.g. tracking another local branch, needs no fetch.
    if (remote !== ".") await run("git", ["fetch", "--quiet", "--no-tags", remote, mergeRef], repo.root, quietEnv());

    const counts = await run("git", ["rev-list", "--left-right", "--count", `${base}...${upstream}`], repo.root);
    const [ahead, behind] = counts.split(/\s+/).map(Number);
    if (behind === 0) return { kind: "synced", upstream, ahead, pulled: 0, at };
    if (ahead > 0) return { kind: "diverged", upstream, ahead, behind, at };

    const where = await checkedOutAt(repo, base);
    if (where) {
      // Checked out: the files have to move with it. Git refuses if local edits are in the way.
      await run("git", ["merge", "--ff-only", "--quiet", upstream], where);
    } else {
      const [from, to] = await Promise.all([
        run("git", ["rev-parse", `refs/heads/${base}`], repo.root),
        run("git", ["rev-parse", upstream], repo.root),
      ]);
      // With the old value given, this fails rather than clobbering a base that moved meanwhile.
      await run("git", ["update-ref", `refs/heads/${base}`, to, from], repo.root);
    }
    return { kind: "synced", upstream, ahead: 0, pulled: behind, at };
  } catch (e) {
    const message = /local changes|untracked working tree files/.test(firstLine(e))
      ? `uncommitted changes in your ${base} checkout are in the way`
      : firstLine(e);
    return { kind: "error", upstream, message, at };
  }
}
