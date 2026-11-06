import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import type { Repo } from "./repo.js";
import {
  createSession,
  listSessions,
  mergeSession,
  openPullRequest,
  openSession,
  removeSession,
  showDiff,
  type ClaudeState,
  type Session,
} from "./sessions.js";

type Mode =
  | { kind: "list" }
  | { kind: "new"; text: string }
  | { kind: "confirm"; prompt: string; action: () => Promise<string | void> };

type Message = { text: string; error?: boolean };

const STATE_STYLE: Record<ClaudeState | "stopped", { label: string; color: string; icon: string }> = {
  busy: { label: "working", color: "yellow", icon: "●" },
  waiting: { label: "needs you", color: "magenta", icon: "◆" },
  idle: { label: "idle", color: "green", icon: "○" },
  ended: { label: "stopped", color: "gray", icon: "·" },
  unknown: { label: "starting", color: "gray", icon: "○" },
  stopped: { label: "stopped", color: "gray", icon: "·" },
};

function ago(d: Date | null): string {
  if (!d) return "";
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function App({ repo }: { repo: Repo }) {
  const { exit, suspendTerminal } = useApp();
  const { columns } = useWindowSize();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const refreshing = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const next = await listSessions(repo);
      setSessions(next);
      setSelected((i) => Math.min(i, Math.max(0, next.length - 1)));
      setLoaded(true);
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    } finally {
      refreshing.current = false;
    }
  }, [repo]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  /** Run an action, reporting its result or error in the message line. */
  const act = useCallback(
    async (fn: () => Promise<string | void>) => {
      setBusy(true);
      setMessage(null);
      try {
        const result = await fn();
        if (result) setMessage({ text: result });
      } catch (e) {
        setMessage({ text: (e as Error).message, error: true });
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [refresh],
  );

  const current = sessions[selected] as Session | undefined;

  useInput((input, key) => {
    if (busy) return;

    if (mode.kind === "new") {
      if (key.escape) return setMode({ kind: "list" });
      if (key.return) {
        const branch = mode.text.trim();
        setMode({ kind: "list" });
        if (branch) void act(async () => `created ${await createSession(repo, branch)}; press enter to attach`);
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

    if (input === "q") return exit();
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
        if (how.value === "switched") return `switched to ${current.id}; switch back to this tmux session to return`;
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
        return setMessage({ text: `${current.id} has uncommitted changes; X force-removes and discards them`, error: true });
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
    <Box flexDirection="column" width={columns}>
      <Box borderStyle="round" borderColor="green" paddingX={1} flexDirection="column">
        <Text>
          <Text bold color="green">grove</Text>
          <Text dimColor>  {repo.name} · base {repo.base} · {sessions.length} worktree{sessions.length === 1 ? "" : "s"}</Text>
        </Text>
        <Box marginTop={1} flexDirection="column">
          {!loaded ? (
            <Text dimColor>loading…</Text>
          ) : sessions.length === 0 ? (
            <Text dimColor>No worktrees yet. Press n to create one and start Claude in it.</Text>
          ) : (
            sessions.map((s, i) => {
              const style = STATE_STYLE[s.running ? s.state : "stopped"];
              const isSel = i === selected;
              return (
                <Box key={s.path}>
                  <Text color={isSel ? "green" : undefined}>{isSel ? "❯ " : "  "}</Text>
                  <Box width={nameWidth}>
                    <Text bold={isSel} wrap="truncate-end">{s.id}</Text>
                  </Box>
                  <Box width={14}>
                    <Text color={style.color}>{style.icon} {style.label}</Text>
                  </Box>
                  <Box width={6}>
                    <Text dimColor>{s.running ? ago(s.stateSince) : ""}</Text>
                  </Box>
                  <Box width={20}>
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
              );
            })
          )}
        </Box>
      </Box>

      <Box paddingX={1}>
        {mode.kind === "new" ? (
          <Text>
            <Text color="green">new branch: </Text>
            {mode.text}
            <Text inverse> </Text>
            <Text dimColor>   enter create · esc cancel</Text>
          </Text>
        ) : mode.kind === "confirm" ? (
          <Text color="yellow">{mode.prompt} <Text dimColor>(y/n)</Text></Text>
        ) : busy ? (
          <Text dimColor>working…</Text>
        ) : message ? (
          <Text color={message.error ? "red" : "cyan"} wrap="truncate-end">{message.text}</Text>
        ) : (
          <Text dimColor>
            {process.env.TMUX ? "" : "inside a session, ctrl-b d returns here"}
          </Text>
        )}
      </Box>

      <Box paddingX={1}>
        <Text dimColor>
          <Text color="white">n</Text> new  <Text color="white">enter</Text> attach  <Text color="white">d</Text> diff  <Text color="white">m</Text> merge  <Text color="white">p</Text> PR  <Text color="white">x</Text> remove  <Text color="white">j/k</Text> move  <Text color="white">q</Text> quit
        </Text>
      </Box>
    </Box>
  );
}
