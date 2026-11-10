import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useWindowSize } from "ink";
import { findConflicts, snapshotAll, type Conflict } from "./conflicts.js";
import {
  keepCandidate,
  liveFanouts,
  loadFanouts,
  runTests,
  startFanout,
  type Fanout,
  type TestResult,
} from "./fanout.js";
import {
  createPreview,
  loadPicks,
  wanted,
  openPreview,
  previewExists,
  previewPath,
  removePreview,
  togglePick,
  updatePreview,
  type PreviewResult,
} from "./preview.js";
import { loadDiff, markSeen, showDiff, type SessionDiff } from "./diff.js";
import { HelpView } from "./HelpView.js";
import { DiffView, patchHeight, selectedIndex, shownFiles, type DiffViewState } from "./DiffView.js";
import type { Repo } from "./repo.js";
import { syncBase, type BaseSync } from "./sync.js";
import {
  attachSession,
  createSession,
  listSessions,
  mergeSession,
  openPullRequest,
  openSession,
  refreshStates,
  removeSession,
  type ClaudeState,
  type Session,
} from "./sessions.js";

type Mode =
  | { kind: "list" }
  | { kind: "new"; text: string }
  | { kind: "fanout"; text: string; count: number }
  | { kind: "compare"; id: string; index: number }
  | ({ kind: "diff"; back: Mode } & DiffViewState)
  | { kind: "confirm"; prompt: string; action: () => Promise<string | void>; back?: Mode }
  | { kind: "help"; back: Mode };

const FANOUT_COUNTS = [2, 3, 4, 5];
/** How often the base branch is fetched and fast-forwarded in the background. */
const SYNC_EVERY_MS = 2 * 60_000;

/** Typed or pasted text for a one-line input: newlines become spaces, other control characters are dropped. */
const typed = (input: string) => input.replace(/[\r\n]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "");

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

function seconds(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

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

function SyncStatus({ sync, syncing }: { sync: BaseSync | null; syncing: boolean }) {
  if (syncing && (!sync || sync.kind !== "error")) return <Text dimColor> · syncing…</Text>;
  if (!sync || sync.kind === "no-upstream") return null;
  if (sync.kind === "error") return <Text color="yellow"> · ⚠ not updated: {sync.message} (u retries)</Text>;
  if (sync.kind === "diverged") {
    return <Text color="yellow"> · ⚠ diverged from {sync.upstream} (↑{sync.ahead} ↓{sync.behind}), left as is</Text>;
  }
  return (
    <Text dimColor>
      {" "}· {sync.ahead > 0 ? `↑${sync.ahead} not pushed to ${sync.upstream}` : `✓ in sync with ${sync.upstream}`}
    </Text>
  );
}

export function App({ repo }: { repo: Repo }) {
  const { exit, suspendTerminal } = useApp();
  const { columns, rows } = useWindowSize();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Selection follows a session, not a row, so new sessions appearing on top don't move it.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [log, setLog] = useState<LogEntry[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [frame, setFrame] = useState(0);
  const [conflicts, setConflicts] = useState<Map<string, Conflict[]>>(new Map());
  const [fanouts, setFanouts] = useState<Fanout[]>(() => loadFanouts(repo));
  const [tests, setTests] = useState<Map<string, TestResult>>(new Map());
  const [hasPreview, setHasPreview] = useState(() => previewExists(repo));
  const [picks, setPicks] = useState(() => loadPicks(repo));
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [diff, setDiff] = useState<{ id: string; data: SessionDiff | null; error: string | null } | null>(null);
  const [baseSync, setBaseSync] = useState<BaseSync | null>(null);
  const [syncing, setSyncing] = useState(false);
  const syncingRef = useRef(false);
  const refreshing = useRef(false);
  const checkingConflicts = useRef(false);
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
      const nextFanouts = loadFanouts(repo);
      setFanouts(nextFanouts);
      const withPreview = previewExists(repo);
      setHasPreview(withPreview);
      setLoaded(true);
      if (!checkingConflicts.current) {
        checkingConflicts.current = true;
        // One snapshot per worktree feeds both the conflict check and the preview.
        snapshotAll(next)
          .then((snaps) =>
            Promise.all([
              findConflicts(repo, next, snaps).then(setConflicts),
              withPreview &&
                updatePreview(repo, next, snaps, loadPicks(repo), liveFanouts(nextFanouts, next)).then(
                  setPreview,
                  (e) => setHint(`preview: ${(e as Error).message}`),
                ),
            ]),
          )
          .catch(() => {})
          .finally(() => (checkingConflicts.current = false));
      }
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

  /** Bring the local base up to date with its remote; `manual` reports even when nothing changed. */
  const sync = useCallback(
    async (manual = false) => {
      if (syncingRef.current) return;
      syncingRef.current = true;
      setSyncing(true);
      try {
        const result = await syncBase(repo);
        setBaseSync(result);
        if (result.kind === "synced" && result.pulled > 0) {
          print(`updated ${repo.base}: ${result.pulled} new commit${result.pulled === 1 ? "" : "s"} from ${result.upstream}`);
          void refresh();
        } else if (manual) {
          if (result.kind === "no-upstream") setHint(`${repo.base} doesn't track a remote branch, so there's nothing to update from`);
          else if (result.kind === "synced") setHint(`${repo.base} is up to date with ${result.upstream}`);
        }
      } finally {
        syncingRef.current = false;
        setSyncing(false);
      }
    },
    [repo, print, refresh],
  );

  useEffect(() => {
    void sync();
    const timer = setInterval(() => void sync(), SYNC_EVERY_MS);
    return () => clearInterval(timer);
  }, [sync]);

  // Hook state changes with every tool call, so poll it faster than the git stats.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!refreshing.current) setSessions((ss) => refreshStates(repo, ss));
    }, 400);
    return () => clearInterval(timer);
  }, [repo]);

  const anyBusy =
    sessions.some((s) => s.running && s.state === "busy") ||
    [...tests.values()].some((t) => t.status === "running");
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

  // Fan-out candidates are listed together under their task, where the first of them would be.
  const groups = liveFanouts(fanouts, sessions);
  const groupOf = new Map(groups.flatMap((g) => g.members.map((m) => [m, g] as const)));
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const ordered: Session[] = [];
  for (const s of sessions) {
    if (ordered.includes(s)) continue;
    const g = groupOf.get(s.id);
    ordered.push(...(g ? g.members.map((m) => byId.get(m)!) : [s]));
  }

  // Candidates of one fan-out are alternatives and are expected to clash with each other; only other clashes matter.
  const clashesOf = (id: string) =>
    (conflicts.get(id) ?? []).filter((c) => !groupOf.get(id)?.members.includes(c.with));

  const selected = Math.max(0, ordered.findIndex((s) => s.id === selectedId));
  const current = ordered[selected] as Session | undefined;
  const select = (i: number) => setSelectedId(ordered[Math.max(0, Math.min(ordered.length - 1, i))]?.id ?? null);
  // A confirm prompt raised from the compare view keeps showing it.
  const view = mode.kind === "confirm" && mode.back ? mode.back : mode;
  const comparing = view.kind === "compare" ? groups.find((g) => g.id === view.id) : undefined;
  const candidates = comparing ? comparing.members.map((m) => byId.get(m)!) : [];
  const candidate = view.kind === "compare" ? candidates[Math.min(view.index, candidates.length - 1)] : undefined;
  const target = mode.kind === "compare" ? candidate : current;

  // A compare view whose fan-out is gone (a winner kept, or candidates removed) falls back to the list.
  useEffect(() => {
    if (mode.kind === "compare" && loaded && !comparing) setMode({ kind: "list" });
  }, [mode, loaded, comparing]);

  // The diff screen reloads while it's open, so an agent's edits show up as it makes them.
  const diffId = mode.kind === "diff" ? mode.id : null;
  const diffPath = diffId ? byId.get(diffId)?.path : undefined;
  useEffect(() => {
    if (!diffId || !diffPath) return;
    let cancelled = false;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const data = await loadDiff(repo, diffPath, diffId);
        if (!cancelled) setDiff({ id: diffId, data, error: null });
      } catch (e) {
        if (!cancelled) setDiff({ id: diffId, data: null, error: (e as Error).message });
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [repo, diffId, diffPath]);

  // A diff screen whose session is gone falls back to where it was opened from.
  useEffect(() => {
    if (mode.kind === "diff" && loaded && !byId.has(mode.id)) setMode(mode.back);
  }, [mode, loaded, byId]);

  const diffData = mode.kind === "diff" && diff?.id === mode.id ? diff : null;

  const openDiff = (s: Session) => {
    setDiff(null);
    setMode({ kind: "diff", id: s.id, file: null, scroll: 0, since: false, back: mode });
  };

  /** Leave the diff screen, remembering what was on it as the last look. */
  const closeDiff = () => {
    if (mode.kind !== "diff") return;
    if (diffData?.data) markSeen(repo, mode.id, diffData.data.commit);
    setMode(mode.back);
  };

  const attach = (s: Session) =>
    void act(async () => {
      const how = { value: "blocked" as "blocked" | "switched" };
      await suspendTerminal(async () => {
        how.value = await openSession(repo, s);
      });
      if (how.value === "switched") setHint(`switched to ${s.id}; switch back to this tmux window to return`);
    });

  const testAll = (members: Session[]) => {
    for (const s of members) {
      setTests((t) => new Map(t).set(s.id, { status: "running" }));
      runTests(repo, s).then(
        (r) => setTests((t) => new Map(t).set(s.id, r)),
        (e) => {
          setTests((t) => {
            const next = new Map(t);
            next.delete(s.id);
            return next;
          });
          setHint((e as Error).message);
        },
      );
    }
  };

  useInput((input, key) => {
    if (busy || exiting) return;

    if (mode.kind === "new") {
      if (key.escape) return setMode({ kind: "list" });
      if (key.return) {
        const branch = mode.text.trim();
        setMode({ kind: "list" });
        if (branch) {
          // Go straight into the new session's Claude; it's selected when you come back.
          void act(async () => {
            const id = await createSession(repo, branch);
            setSelectedId(id);
            const how = { value: "blocked" as "blocked" | "switched" };
            await suspendTerminal(async () => {
              how.value = await attachSession(repo, id);
            });
            if (how.value === "switched") setHint(`switched to ${id}; switch back to this tmux window to return`);
            return `created ${id}`;
          });
        }
        return;
      }
      if (key.backspace || key.delete) return setMode({ kind: "new", text: mode.text.slice(0, -1) });
      if (input && !key.ctrl && !key.meta) setMode({ kind: "new", text: mode.text + typed(input) });
      return;
    }

    if (mode.kind === "fanout") {
      if (key.escape) return setMode({ kind: "list" });
      // Tabs can arrive inside a pasted or buffered chunk, so count them rather than relying on key.tab.
      const tabs = key.tab ? 1 : (input.match(/\t/g)?.length ?? 0);
      const count = FANOUT_COUNTS[(FANOUT_COUNTS.indexOf(mode.count) + tabs) % FANOUT_COUNTS.length];
      if (key.return) {
        const task = mode.text.trim();
        setMode({ kind: "list" });
        if (task) {
          void act(async () => {
            const f = await startFanout(repo, task, mode.count);
            // Load the new candidates before switching, or the compare view would find none and close.
            setSessions(await listSessions(repo));
            setFanouts(loadFanouts(repo));
            setMode({ kind: "compare", id: f.id, index: 0 });
            return `fanned out to ${f.members.join(", ")}`;
          });
        }
        return;
      }
      if (key.backspace || key.delete) return setMode({ ...mode, count, text: mode.text.slice(0, -1) });
      if (key.tab) return setMode({ ...mode, count });
      if (input && !key.ctrl && !key.meta) setMode({ ...mode, count, text: mode.text + typed(input) });
      return;
    }

    if (mode.kind === "confirm") {
      setMode(mode.back ?? { kind: "list" });
      if (input === "y") void act(mode.action);
      return;
    }

    setHint(null);

    if (mode.kind === "diff") {
      if (key.escape || key.leftArrow || input === "q" || input === "d") return closeDiff();
      const s = byId.get(mode.id);
      if (key.return && s) return attach(s);
      if (input === "D" && s) return void act(() => suspendTerminal(() => showDiff(repo, s.path)));
      const data = diffData?.data;
      if (!data) return;
      if (input === "s") {
        if (!mode.since && data.since === null) return setHint("no earlier look to compare with yet");
        return setMode({ ...mode, since: !mode.since, scroll: 0 });
      }
      const files = shownFiles(data, mode.since);
      if (!files.length) return;
      const sel = selectedIndex(files, mode.file);
      const pick = (i: number) => setMode({ ...mode, file: files[i].path, scroll: 0 });
      if (key.downArrow || input === "j") return pick(Math.min(files.length - 1, sel + 1));
      if (key.upArrow || input === "k") return pick(Math.max(0, sel - 1));
      const page = patchHeight(rows, columns, files.length);
      const maxScroll = Math.max(0, files[sel].lines.length - page);
      const scrollTo = (n: number) => setMode({ ...mode, file: files[sel].path, scroll: Math.max(0, Math.min(maxScroll, n)) });
      const scroll = Math.min(mode.scroll, maxScroll);
      if (input === "J") return scrollTo(scroll + 1);
      if (input === "K") return scrollTo(scroll - 1);
      if (input === " " || key.pageDown || (key.ctrl && input === "d")) return scrollTo(scroll + page - 2);
      if (input === "b" || key.pageUp || (key.ctrl && input === "u")) return scrollTo(scroll - page + 2);
      if (input === "g") return scrollTo(0);
      if (input === "G") return scrollTo(maxScroll);
      return;
    }

    if (mode.kind === "help") {
      if (key.escape || input === "?" || input === "q") setMode(mode.back);
      return;
    }
    if (input === "?") return setMode({ kind: "help", back: mode });

    if (input === "q") return setExiting(true);

    if (mode.kind === "compare") {
      if (key.escape || input === "c") {
        // Return to the list with the candidate that was being looked at still selected.
        if (candidate) setSelectedId(candidate.id);
        return setMode({ kind: "list" });
      }
      const last = candidates.length - 1;
      if (key.upArrow || input === "k") return setMode({ ...mode, index: Math.max(0, mode.index - 1) });
      if (key.downArrow || input === "j") return setMode({ ...mode, index: Math.min(last, mode.index + 1) });
      if (input === "t") return testAll(candidates);
      if (input === "w" && comparing && candidate) {
        const others = candidates.length - 1;
        return setMode({
          kind: "confirm",
          prompt: `Keep ${candidate.id} and DELETE the other ${others} worktree${others === 1 ? "" : "s"} and branch${others === 1 ? "" : "es"}?`,
          action: () => keepCandidate(repo, comparing, candidate, sessions),
          back: mode,
        });
      }
    } else {
      if (key.upArrow || input === "k") return select(selected - 1);
      if (key.downArrow || input === "j") return select(selected + 1);
      if (input === "n") return setMode({ kind: "new", text: "" });
      if (input === "f") return setMode({ kind: "fanout", text: "", count: 3 });
      if (input === "r") return void refresh();
      if (input === "u") return void sync(true);
      if (input === "v") {
        if (!hasPreview) return void act(() => createPreview(repo, sessions, groups));
        return void act(async () => {
          const how = { value: "blocked" as "blocked" | "switched" };
          await suspendTerminal(async () => {
            how.value = await openPreview(repo);
          });
          if (how.value === "switched") setHint("switched to the preview; switch back to this tmux window to return");
        });
      }
      if (input === "V") {
        if (!hasPreview) return setHint("no preview · press v to create one");
        return setMode({
          kind: "confirm",
          prompt: `Remove the preview at ${previewPath(repo)}? Your worktrees are untouched.`,
          action: () => removePreview(repo),
        });
      }
      if (input === " " && current) {
        // The list shows the new pick at once; the preview's files follow on the next poll.
        return setPicks(togglePick(repo, current.id, groupOf.get(current.id)));
      }
      if (input === "c") {
        const g = current && groupOf.get(current.id);
        if (!g) return setHint("not part of a fan-out · press f to start one");
        return setMode({ kind: "compare", id: g.id, index: g.members.indexOf(current.id) });
      }
    }
    if (!target) return;

    if (key.return) {
      attach(target);
    } else if (input === "d") {
      openDiff(target);
    } else if (input === "D") {
      void act(() => suspendTerminal(() => showDiff(repo, target.path)));
    } else if (input === "p") {
      void act(() => suspendTerminal(() => openPullRequest(target)));
    } else if (input === "m") {
      setMode({
        kind: "confirm",
        prompt: `Merge ${target.branch} into ${repo.base}?`,
        action: () => mergeSession(repo, target),
        back: mode,
      });
    } else if ((input === "x" || input === "X") && mode.kind === "list") {
      const force = input === "X";
      if (target.dirty && !force) {
        return setHint(`${target.id} has uncommitted changes; X force-removes and discards them`);
      }
      setMode({
        kind: "confirm",
        prompt: `Remove worktree ${target.id}${force ? " and DISCARD its uncommitted changes" : ""}?`,
        action: () => removeSession(repo, target, force),
      });
    }
  });

  const conflicted = sessions.filter((s) => clashesOf(s.id).length > 0).length;
  const previewConflicts = new Map(preview?.conflicting.map((c) => [c.id, c.files]));
  const inPreview = (s: Session) =>
    hasPreview && wanted(picks, s.id, groupOf.get(s.id)) && !previewConflicts.has(s.id);
  // Names get the room the other columns leave (state, age, lines, and at least "N commits").
  // Long names are cut in the middle, keeping both the prefix and the distinctive end visible.
  const longestName = Math.max(0, ...sessions.map((s) => s.id.length + 2));
  const nameWidth = Math.max(12, Math.min(longestName, columns - 4 - 13 - 5 - 18 - 12));
  const compareNameWidth = Math.max(12, Math.min(longestName, columns - 6 - 13 - 14 - 7 - 9 - 11 - 10));
  const stateCell = (s: Session) => {
    const style = STATE_STYLE[s.running ? s.state : "stopped"];
    const icon = s.running && s.state === "busy" ? SPINNER[frame] : style.icon;
    return <Text color={style.color}>{icon} {style.label}</Text>;
  };
  const activityOf = (s: Session) => (s.running && (s.state === "busy" || s.state === "waiting") ? s.activity : null);

  const list = ordered.map((s, i) => {
    const isSel = i === selected;
    const clashes = clashesOf(s.id);
    const activity = activityOf(s);
    const g = groupOf.get(s.id);
    const leftOut = hasPreview && wanted(picks, s.id, g) ? previewConflicts.get(s.id) : undefined;
    return (
      <Box key={s.path} flexDirection="column">
        {g && g.members[0] === s.id && (
          <Text wrap="truncate-end">
            <Text color="magenta">⑂ </Text>
            <Text italic>“{g.task}”</Text>
            <Text dimColor>  {g.members.length} candidates · c compare</Text>
          </Text>
        )}
        <Box>
          <Box width={2} flexShrink={0}>
            <Text color="green">{isSel ? "❯" : " "}</Text>
          </Box>
          <Box width={nameWidth} flexShrink={0} paddingRight={2}>
            <Text bold={isSel} dimColor={!isSel} wrap="truncate-middle">{s.id}</Text>
          </Box>
          <Box width={13} flexShrink={0}>{stateCell(s)}</Box>
          <Box width={5} flexShrink={0}>
            <Text dimColor>{s.running ? ago(s.stateSince) : ""}</Text>
          </Box>
          <Box width={18} flexShrink={0}>
            <Text>
              <Text color="green">+{s.added}</Text> <Text color="red">-{s.deleted}</Text>
              {s.untracked > 0 && <Text dimColor> {s.untracked} new</Text>}
            </Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text dimColor wrap="truncate-end">
              {s.ahead} commit{s.ahead === 1 ? "" : "s"}
              {s.dirty ? " · uncommitted" : ""}
              {inPreview(s) && <Text color="cyan" dimColor={false}> ◧ preview</Text>}
            </Text>
          </Box>
        </Box>
        {activity && (
          <Box paddingLeft={4}>
            <Text color={s.state === "waiting" ? "magenta" : undefined} dimColor={s.state !== "waiting"} wrap="truncate-end">
              └ {activity}
            </Text>
          </Box>
        )}
        {clashes.map((c) => (
          <Box key={c.with} paddingLeft={4}>
            <Text color="red" wrap="truncate-end">
              ⚠ conflicts with {c.with} in {c.files.slice(0, 2).join(", ")}
              {c.files.length > 2 && <Text dimColor> +{c.files.length - 2} more</Text>}
            </Text>
          </Box>
        ))}
        {leftOut && (
          <Box paddingLeft={4}>
            <Text color="yellow" wrap="truncate-end">
              ⊘ left out of preview: conflicts in {leftOut.slice(0, 2).join(", ")}
              {leftOut.length > 2 && <Text dimColor> +{leftOut.length - 2} more</Text>}
            </Text>
          </Box>
        )}
      </Box>
    );
  });

  // The suggested pick: the smallest change among candidates whose tests pass.
  const passing = candidates.filter((s) => tests.get(s.id)?.status === "pass");
  const suggested = passing.length
    ? passing.reduce((a, b) => (b.added + b.deleted < a.added + a.deleted ? b : a))
    : undefined;

  const compare = comparing && (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text color="magenta">⑂ </Text>
        <Text italic>“{comparing.task}”</Text>
      </Text>
      <Box marginTop={1}>
        <Box width={compareNameWidth + 4} flexShrink={0}><Text dimColor>  candidate</Text></Box>
        <Box width={13} flexShrink={0}><Text dimColor>state</Text></Box>
        <Box width={14} flexShrink={0}><Text dimColor>lines</Text></Box>
        <Box width={7} flexShrink={0}><Text dimColor>files</Text></Box>
        <Box width={9} flexShrink={0}><Text dimColor>commits</Text></Box>
        <Box width={11} flexShrink={0}><Text dimColor>tests</Text></Box>
        <Text dimColor>conflicts</Text>
      </Box>
      {candidates.map((s) => {
        const isSel = s === candidate;
        const t = tests.get(s.id);
        const clashes = clashesOf(s.id);
        return (
          <Box key={s.path}>
            <Box width={2} flexShrink={0}><Text color="green">{isSel ? "❯" : " "}</Text></Box>
            <Box width={compareNameWidth + 2} flexShrink={0} paddingRight={2}>
              <Text bold={isSel} dimColor={!isSel} wrap="truncate-middle">
                {s.id}
                {s === suggested && <Text color="yellow"> ★</Text>}
              </Text>
            </Box>
            <Box width={13} flexShrink={0}>{stateCell(s)}</Box>
            <Box width={14} flexShrink={0}>
              <Text>
                <Text color="green">+{s.added}</Text> <Text color="red">-{s.deleted}</Text>
              </Text>
            </Box>
            <Box width={7} flexShrink={0}><Text>{s.files.length}</Text></Box>
            <Box width={9} flexShrink={0}><Text>{s.ahead}{s.dirty ? <Text dimColor>+wip</Text> : ""}</Text></Box>
            <Box width={11} flexShrink={0}>
              {!t ? (
                <Text dimColor>–</Text>
              ) : t.status === "running" ? (
                <Text color="yellow">{SPINNER[frame]} running</Text>
              ) : (
                <Text color={t.status === "pass" ? "green" : "red"}>
                  {t.status === "pass" ? "✓" : "✗"} {seconds(t.ms)}
                </Text>
              )}
            </Box>
            <Text color={clashes.length ? "red" : undefined} dimColor={!clashes.length} wrap="truncate-end">
              {clashes.length ? clashes.map((c) => c.with).join(", ") : "none"}
            </Text>
          </Box>
        );
      })}
      {candidate && (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          <Text wrap="truncate-end">
            <Text dimColor>files </Text>
            {candidate.files.length ? candidate.files.slice(0, 6).join(", ") : <Text dimColor>no changes yet</Text>}
            {candidate.files.length > 6 && <Text dimColor> +{candidate.files.length - 6} more</Text>}
          </Text>
          {activityOf(candidate) && (
            <Text dimColor wrap="truncate-end">└ {activityOf(candidate)}</Text>
          )}
          {(() => {
            const t = tests.get(candidate.id);
            return t && t.status !== "running" && t.tail ? (
              <Text color={t.status === "pass" ? undefined : "red"} dimColor={t.status === "pass"} wrap="truncate-end">
                tests: {t.tail}
              </Text>
            ) : null;
          })()}
        </Box>
      )}
    </Box>
  );

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
              <SyncStatus sync={baseSync} syncing={syncing} />
              {conflicted > 0 && <Text color="red">  ⚠ {conflicted} conflicting</Text>}
              {hasPreview && (
                <Text color="cyan">
                  {"  "}◧ preview {sessions.filter(inPreview).length} in
                  {previewConflicts.size > 0 && <Text color="yellow"> · {previewConflicts.size} left out</Text>}
                </Text>
              )}
            </Text>

            {!loaded ? (
              <Text dimColor>loading…</Text>
            ) : mode.kind === "help" ? (
              <HelpView />
            ) : mode.kind === "diff" ? (
              <DiffView
                state={mode}
                data={diffData?.data ?? null}
                error={diffData?.error ?? null}
                base={repo.base}
                rows={rows}
                columns={columns}
              />
            ) : compare ? (
              compare
            ) : sessions.length === 0 ? (
              <Text dimColor>no worktrees yet · press n to start one, or f to fan a task out</Text>
            ) : (
              list
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
            ) : mode.kind === "fanout" ? (
              <Text>
                <Text color="magenta">⑂ </Text>
                <Text dimColor>task ×{mode.count} </Text>
                {mode.text}
                <Text inverse> </Text>
                <Text dimColor>   enter start · tab count · esc cancel</Text>
              </Text>
            ) : mode.kind === "confirm" ? (
              <Text color="yellow">
                {mode.prompt} <Text dimColor>y/n</Text>
              </Text>
            ) : busy ? (
              <Text dimColor>working…</Text>
            ) : hint ? (
              <Text color="yellow" wrap="truncate-end">{hint}</Text>
            ) : mode.kind === "help" ? (
              <Text>
                <Key k="esc" label="close" />
              </Text>
            ) : mode.kind === "diff" ? (
              <Text wrap="truncate-end">
                <Key k="j/k" label="file" />  <Key k="space/b" label="page" />  <Key k="J/K" label="line" />{"  "}
                <Key k="s" label={mode.since ? "show everything" : "since last look"} />  <Key k="D" label="full patch" />{"  "}
                <Key k="enter" label="attach" />  <Key k="esc" label="back" />
              </Text>
            ) : compare ? (
              <Text wrap="truncate-end">
                <Key k="enter" label="attach" />  <Key k="d" label="diff" />  <Key k="t" label="test all" />{"  "}
                <Key k="w" label="keep this one" />  <Key k="?" label="more" />  <Key k="esc" label="back" />
              </Text>
            ) : (
              <Text wrap="truncate-end">
                <Key k="n" label="new" />  <Key k="enter" label="attach" />  <Key k="d" label="diff" />{"  "}
                <Key k="m" label="merge" />  <Key k="x" label="remove" />{"  "}
                {hasPreview && <><Key k="space" label="in/out of preview" />{"  "}</>}
                <Key k="?" label="more" />  <Key k="q" label="quit" />
              </Text>
            )}
          </Box>
        </Box>
      )}
    </>
  );
}
