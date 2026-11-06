import { execFile, spawnSync } from "node:child_process";

export class ExecError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/** Run a command and resolve with trimmed stdout. Rejects with stderr on non-zero exit. */
export function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr.trim() || err.message;
        reject(new ExecError(`${cmd} ${args.join(" ")}: ${msg}`, stderr));
      } else {
        resolve(stdout.trimEnd());
      }
    });
  });
}

/** Like run, but returns null instead of rejecting. */
export async function tryRun(cmd: string, args: string[], cwd?: string): Promise<string | null> {
  try {
    return await run(cmd, args, cwd);
  } catch {
    return null;
  }
}

/** Run a command attached to the user's terminal. Returns the exit code. */
export function runInteractive(cmd: string, args: string[], cwd?: string): number {
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  return res.status ?? 1;
}

export function pressEnterToContinue(): void {
  process.stdout.write("\nPress enter to return to grove...");
  spawnSync("sh", ["-c", "read _"], { stdio: "inherit" });
}
