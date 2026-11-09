import { run, runInteractive, tryRun } from "./exec.js";

const exact = (session: string, window?: string) =>
  window === undefined ? `=${session}` : `=${session}:=${window}`;

export async function listWindows(session: string): Promise<Set<string>> {
  const out = await tryRun("tmux", ["list-windows", "-t", exact(session), "-F", "#{window_name}"]);
  return new Set(out ? out.split("\n") : []);
}

export async function startWindow(opts: {
  session: string;
  window: string;
  cwd: string;
  command: string;
  env: Record<string, string>;
}): Promise<void> {
  const envArgs = Object.entries(opts.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const hasSession = (await tryRun("tmux", ["has-session", "-t", exact(opts.session)])) !== null;
  const args = hasSession
    ? ["new-window", "-d", "-t", `${exact(opts.session)}:`]
    : ["new-session", "-d", "-s", opts.session];
  await run("tmux", [...args, "-n", opts.window, "-c", opts.cwd, ...envArgs, opts.command]);
  await styleSession(opts.session);
}

/**
 * Replace tmux's default bright-green status bar with a quiet one that sits on
 * the terminal's own background. Session-scoped, so the user's other tmux
 * sessions and config are untouched.
 */
const STATUS_LINE = [
  "#[align=left,bg=default]",
  " #[fg=colour108]●#[fg=colour245] grove #[fg=colour238]│",
  "#{W:#[fg=colour243] #W ,#[fg=colour223 bold] #W #[nobold]}",
  "#[align=right]#[fg=colour240]ctrl-b d  back to grove ",
].join("");

const SESSION_STYLE: [string, string][] = [
  ["status-style", "bg=default,fg=colour243"],
  ["status-format[0]", STATUS_LINE],
  ["message-style", "bg=colour236,fg=colour250"],
  ["message-command-style", "bg=colour236,fg=colour250"],
];

async function styleSession(session: string): Promise<void> {
  for (const [option, value] of SESSION_STYLE) {
    await tryRun("tmux", ["set-option", "-t", `${exact(session)}:`, option, value]);
  }
}

export async function killWindow(session: string, window: string): Promise<void> {
  await tryRun("tmux", ["kill-window", "-t", exact(session, window)]);
}

/**
 * Show a session's window. Outside tmux this blocks until the user detaches;
 * inside tmux it switches the current client and returns immediately.
 */
export async function attach(session: string, window: string): Promise<"blocked" | "switched"> {
  await styleSession(session); // also restyles sessions started by older grove versions
  await run("tmux", ["select-window", "-t", exact(session, window)]);
  if (process.env.TMUX) {
    await run("tmux", ["switch-client", "-t", exact(session, window)]);
    return "switched";
  }
  runInteractive("tmux", ["attach-session", "-t", exact(session)]);
  // Erase tmux's "[detached (from session ...)]" line so it doesn't pile up in the log.
  process.stdout.write("\x1b[1A\x1b[2K");
  return "blocked";
}
