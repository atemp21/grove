import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useWindowSize } from "ink";
import type { Repo } from "./repo.js";
import {
  createSession,
  listSessions,
  mergeSession,
  openPullRequest,
  openSession,
  refreshStates,
  removeSession,
  showDiff,
  type ClaudeState,
  type Session,
} from "./sessions.js";

type Mode =
  | { kind: "list" }
  | { kind: "new"; text: string }
  | { kind: "confirm"; prompt: string; action: () => Promise<string | void> };

/** A line printed above the live view; it scrolls up like a transcript. */
type LogEntry = { id: number; text: string; error?: boolean };

const STATE_STYLE: Record<ClaudeState | "stopped", { label: string; color: string; icon: string }> = {
  busy: { label: "working", color: "yellow", icon: "●" },
  waiting: { label: "needs you", color: "magenta", icon: "◆" },
  idle: { label: "idle", color: "green", icon: "○" },
  ended: { label: "stopped", color: "gray", icon: "·" },
  unknown: { label: "starting", color: "gray", icon: "○" },
  stopped: { label: "stopped", color: "gray", icon: "·" },
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function ago(d: Date | null): string {
  if (!d) return "";
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const Key = ({ k, label }: { k: string; label: string }) => (
  <Text>
    <Text color="white">{k}</Text>
    <Text dimColor> {label}</Text>
  </Text>
);

export function App({ repo }: { repo: Repo }) {
  const { exit, suspendTerminal } = useApp();
  const { columns } = useWindowSize();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [log, setLog] = useState<LogEntry[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [frame, setFrame] = useState(0);
  const refreshing = useRef(false);
  const nextLogId = useRef(0);

  const print = useCallback((text: string, error?: boolean) => {
    setLog((l) => [...l, { id: nextLogId.current++, text, error }]);
  }, []);

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const next = await listSessions(repo);
      setSessions(next);
      setSelected((i) => Math.min(i, Math.max(0, next.length - 1)));
      setLoaded(true);
    } catch (e) {
      setHint((e as Error).message);
    } finally {
      refreshing.current = false;
    }
  }, [repo]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  // Hook state changes with every tool call, so poll it faster than the git stats.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!refreshing.current) setSessions((ss) => refreshStates(repo, ss));
    }, 400);
    return () => clearInterval(timer);
  }, [repo]);

  const anyBusy = sessions.some((s) => s.running && s.state === "busy");
  useEffect(() => {
    if (!anyBusy) return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 80);
    return () => clearInterval(timer);
  }, [anyBusy]);

  // Clear the live view before exiting so only the log stays in scrollback.
  useEffect(() => {
    if (exiting) exit();
  }, [exiting, exit]);

  /** Run an action, printing its result or error above the live view. */
  const act = useCallback(
    async (fn: () => Promise<string | void>) => {
      setBusy(true);
      setHint(null);
      try {
        const result = await fn();
        if (result) print(result);
      } catch (e) {
        print((e as Error).message, true);
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [print, refresh],
  );

  const current = sessions[selected] as Session | undefined;

  useInput((input, key) => {
    if (busy || exiting) return;

    if (mode.kind === "new") {
      if (key.escape) return setMode({ kind: "list" });
      if (key.return) {
        const branch = mode.text.trim();
        setMode({ kind: "list" });
        if (branch) void act(async () => `created ${await createSession(repo, branch)}`);
        return;
      }
      if (key.backspace || key.delete) return setMode({ kind: "new", text: mode.text.slice(0, -1) });
      if (input && !key.ctrl && !key.meta) setMode({ kind: "new", text: mode.text + input });
      return;
    }

    if (mode.kind === "confirm") {
      setMode({ kind: "list" });
      if (input === "y") void act(mode.action);
      return;
    }

    setHint(null);
    if (input === "q") return setExiting(true);
    if (key.upArrow || input === "k") return setSelected((i) => Math.max(0, i - 1));
    if (key.downArrow || input === "j") return setSelected((i) => Math.min(sessions.length - 1, i + 1));
    if (input === "n") return setMode({ kind: "new", text: "" });
    if (input === "r") return void refresh();
    if (!current) return;

    if (key.return) {
      void act(async () => {
        const how = { value: "blocked" as "blocked" | "switched" };
        await suspendTerminal(async () => {
          how.value = await openSession(repo, current);
        });
        if (how.value === "switched") setHint(`switched to ${current.id}; switch back to this tmux window to return`);
      });
    } else if (input === "d") {
      void act(() => suspendTerminal(() => showDiff(repo, current)));
    } else if (input === "p") {
      void act(() => suspendTerminal(() => openPullRequest(current)));
    } else if (input === "m") {
      setMode({
        kind: "confirm",
        prompt: `Merge ${current.branch} into ${repo.base}?`,
        action: () => mergeSession(repo, current),
      });
    } else if (input === "x" || input === "X") {
      const force = input === "X";
      if (current.dirty && !force) {
        return setHint(`${current.id} has uncommitted changes; X force-removes and discards them`);
      }
      setMode({
        kind: "confirm",
        prompt: `Remove worktree ${current.id}${force ? " and DISCARD its uncommitted changes" : ""}?`,
        action: () => removeSession(repo, current, force),
      });
    }
  });

  const nameWidth = Math.max(12, Math.min(40, ...sessions.map((s) => s.id.length + 2)));

  return (
    <>
      <Static items={log}>
        {(entry) => (
          <Text key={entry.id} color={entry.error ? "red" : undefined}>
            <Text color={entry.error ? "red" : "green"}>{entry.error ? "✗" : "✓"}</Text> {entry.text}
          </Text>
        )}
      </Static>

      {!exiting && (
        <Box flexDirection="column" width={columns}>
          <Text dimColor>{"─".repeat(Math.max(0, columns))}</Text>
          <Box paddingX={1} flexDirection="column">
            <Text>
              <Text bold color="green">grove</Text>
              <Text dimColor> {repo.name} · base {repo.base}</Text>
            </Text>

            {!loaded ? (
              <Text dimColor>loading…</Text>
            ) : sessions.length === 0 ? (
              <Text dimColor>no worktrees yet · press n to start one</Text>
            ) : (
              sessions.map((s, i) => {
                const style = STATE_STYLE[s.running ? s.state : "stopped"];
                const isSel = i === selected;
                const icon = s.running && s.state === "busy" ? SPINNER[frame] : style.icon;
                const activity = s.running && (s.state === "busy" || s.state === "waiting") ? s.activity : null;
                return (
                  <Box key={s.path} flexDirection="column">
                    <Box>
                      <Text color="green">{isSel ? "❯ " : "  "}</Text>
                      <Box width={nameWidth}>
                        <Text bold={isSel} dimColor={!isSel} wrap="truncate-end">{s.id}</Text>
                      </Box>
                      <Box width={13}>
                        <Text color={style.color}>{icon} {style.label}</Text>
                      </Box>
                      <Box width={5}>
                        <Text dimColor>{s.running ? ago(s.stateSince) : ""}</Text>
                      </Box>
                      <Box width={18}>
                        <Text>
                          <Text color="green">+{s.added}</Text> <Text color="red">-{s.deleted}</Text>
                          {s.untracked > 0 && <Text dimColor> {s.untracked} new</Text>}
                        </Text>
                      </Box>
                      <Text dimColor>
                        {s.ahead} commit{s.ahead === 1 ? "" : "s"}
                        {s.dirty ? " · uncommitted" : ""}
                      </Text>
                    </Box>
                    {activity && (
                      <Box paddingLeft={4}>
                        <Text color={s.state === "waiting" ? "magenta" : undefined} dimColor={s.state !== "waiting"} wrap="truncate-end">
                          └ {activity}
                        </Text>
                      </Box>
                    )}
                  </Box>
                );
              })
            )}
          </Box>

          <Box paddingX={1} marginTop={1}>
            {mode.kind === "new" ? (
              <Text>
                <Text color="green">› </Text>
                <Text dimColor>branch </Text>
                {mode.text}
                <Text inverse> </Text>
                <Text dimColor>   enter create · esc cancel</Text>
              </Text>
            ) : mode.kind === "confirm" ? (
              <Text color="yellow">
                {mode.prompt} <Text dimColor>y/n</Text>
              </Text>
            ) : busy ? (
              <Text dimColor>working…</Text>
            ) : hint ? (
              <Text color="yellow" wrap="truncate-end">{hint}</Text>
            ) : (
              <Text wrap="truncate-end">
                <Key k="n" label="new" />  <Key k="enter" label="attach" />  <Key k="d" label="diff" />{"  "}
                <Key k="m" label="merge" />  <Key k="p" label="PR" />  <Key k="x" label="remove" />{"  "}
                <Key k="q" label="quit" />
                {!process.env.TMUX && <Text dimColor>  · ctrl-b d returns from a session</Text>}
              </Text>
            )}
          </Box>
        </Box>
      )}
    </>
  );
}
