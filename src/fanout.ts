import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExecError, run, tryRun } from "./exec.js";
import { GROVE_HOME, testCommand, type Repo } from "./repo.js";
import { createSession, removeSession, slug, type Session } from "./sessions.js";

/** One task started in several worktrees at once, to pick the best result. */
export type Fanout = { id: string; task: string; members: string[]; created: string };

export type TestResult = { status: "running" } | { status: "pass" | "fail"; ms: number; tail: string };

const fanoutsFile = (repo: Repo) => join(GROVE_HOME, "fanouts", `${slug(repo.key)}.json`);

export function loadFanouts(repo: Repo): Fanout[] {
  const file = fanoutsFile(repo);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Fanout[]) : [];
}

function saveFanouts(repo: Repo, fanouts: Fanout[]): void {
  mkdirSync(join(GROVE_HOME, "fanouts"), { recursive: true });
  writeFileSync(fanoutsFile(repo), JSON.stringify(fanouts, null, 2));
}

/** Fan-outs with their members narrowed to worktrees that still exist; ones with fewer than two are dropped. */
export function liveFanouts(fanouts: Fanout[], sessions: Session[]): Fanout[] {
  const ids = new Set(sessions.map((s) => s.id));
  return fanouts
    .map((f) => ({ ...f, members: f.members.filter((m) => ids.has(m)) }))
    .filter((f) => f.members.length >= 2);
}

/** A short branch prefix from the task's first few words, e.g. "fix-the-login-redirect". */
function taskSlug(task: string): string {
  const words = task.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return slug(words.slice(0, 4).join("-").slice(0, 30)) || "fanout";
}

async function branchTaken(repo: Repo, name: string): Promise<boolean> {
  const ref = await tryRun("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], repo.root);
  return ref !== null || existsSync(join(repo.worktreesDir, name));
}

/** Create `count` worktrees from the base, each with Claude started on `task`. */
export async function startFanout(repo: Repo, task: string, count: number): Promise<Fanout> {
  const letters = "abcdefghij".slice(0, count).split("");
  const base = taskSlug(task);
  let prefix = base;
  for (let n = 2; (await Promise.all(letters.map((l) => branchTaken(repo, `${prefix}-${l}`)))).some(Boolean); n++) {
    prefix = `${base}-${n}`;
  }

  const fanout: Fanout = { id: prefix, task, members: [], created: new Date().toISOString() };
  try {
    // One at a time: concurrent `git worktree add` calls can race on the repo's locks.
    for (const l of letters) fanout.members.push(await createSession(repo, `${prefix}-${l}`, task));
  } finally {
    if (fanout.members.length > 0) saveFanouts(repo, [...loadFanouts(repo), fanout]);
  }
  return fanout;
}

/** Keep `winner` and remove the other candidates, deleting their worktrees and branches. */
export async function keepCandidate(repo: Repo, fanout: Fanout, winner: Session, sessions: Session[]): Promise<string> {
  const losers = sessions.filter((s) => s.id !== winner.id && fanout.members.includes(s.id));
  for (const s of losers) await removeSession(repo, s, true, true);
  saveFanouts(repo, loadFanouts(repo).filter((f) => f.id !== fanout.id));
  return `kept ${winner.id}; removed ${losers.map((s) => s.id).join(", ")}`;
}

/** Run the repo's test command in a candidate's worktree. */
export async function runTests(repo: Repo, s: Session): Promise<TestResult> {
  const cmd = testCommand(repo);
  if (!cmd) throw new Error(repo.trusted ? 'no test command: add "test" to .grove.json' : "tests are off: restart grove and trust this repo's commands");
  const started = Date.now();
  const lastLine = (out: string) => out.trim().split("\n").at(-1) ?? "";
  try {
    const out = await run("sh", ["-c", `${cmd} 2>&1`], s.path, { CI: "1" });
    return { status: "pass", ms: Date.now() - started, tail: lastLine(out) };
  } catch (e) {
    const out = e instanceof ExecError ? e.stdout || e.stderr : (e as Error).message;
    return { status: "fail", ms: Date.now() - started, tail: lastLine(out) };
  }
}
