import { Box, Text } from "ink";
import type { FileDiff, FileStatus, SessionDiff } from "./diff.js";

const STATUS: Record<FileStatus, { letter: string; color: string; label: string }> = {
  added: { letter: "A", color: "green", label: "new file" },
  modified: { letter: "M", color: "yellow", label: "modified" },
  deleted: { letter: "D", color: "red", label: "deleted" },
  renamed: { letter: "R", color: "cyan", label: "renamed" },
};

/** Below this width the file list sits above the patch instead of beside it. */
const SIDE_BY_SIDE = 100;

export type DiffViewState = {
  id: string;
  /** The selected file's path; it stays selected while files come and go. */
  file: string | null;
  scroll: number;
  /** Show only what changed since the last look. */
  since: boolean;
};

/** The files the view lists: everything against the base, or only what changed since the last look. */
export const shownFiles = (data: SessionDiff, since: boolean): FileDiff[] => (since ? (data.since ?? []) : data.files);

export const selectedIndex = (files: FileDiff[], file: string | null) =>
  Math.max(0, files.findIndex((f) => f.path === file));

/** Rows the patch pane shows, so paging scrolls by what's on screen. */
export function patchHeight(rows: number, columns: number, fileCount: number): number {
  const pane = Math.max(6, rows - 7);
  return columns >= SIDE_BY_SIDE ? pane - 1 : pane - 2 - Math.min(fileCount, 5);
}

function lineColor(line: string): string | undefined {
  if (line.startsWith("@@")) return "cyan";
  if (line.startsWith("+")) return "green";
  if (line.startsWith("-")) return "red";
  return undefined;
}

/** A window of `size` items around `index`. */
function windowAround(count: number, index: number, size: number): [number, number] {
  const start = Math.max(0, Math.min(index - Math.floor(size / 2), count - size));
  return [start, Math.min(count, start + size)];
}

export function DiffView({
  state,
  data,
  error,
  base,
  rows,
  columns,
}: {
  state: DiffViewState;
  data: SessionDiff | null;
  error: string | null;
  base: string;
  rows: number;
  columns: number;
}) {
  const width = columns - 2; // the screen's horizontal padding
  if (error) return <Text color="red" wrap="truncate-end">{error}</Text>;
  if (!data) return <Text dimColor>loading diff…</Text>;

  const files = shownFiles(data, state.since);
  const sinceSet = new Set(data.since?.map((f) => f.path));
  const sel = selectedIndex(files, state.file);
  const file = files[sel] as FileDiff | undefined;
  const sideBySide = columns >= SIDE_BY_SIDE;
  const height = patchHeight(rows, columns, files.length);
  const added = files.reduce((n, f) => n + f.added, 0);
  const deleted = files.reduce((n, f) => n + f.deleted, 0);

  const summary = (
    <Text wrap="truncate-end">
      <Text bold>{state.id}</Text>
      <Text dimColor>{state.since ? " · since your last look" : ` vs ${base}`} · </Text>
      {files.length} file{files.length === 1 ? "" : "s"}{" "}
      <Text color="green">+{added}</Text> <Text color="red">-{deleted}</Text>
      {!state.since && data.since === null && <Text dimColor>  · first look</Text>}
      {!state.since && data.since !== null && sinceSet.size > 0 && (
        <Text color="yellow">  ● {sinceSet.size} changed since your last look</Text>
      )}
    </Text>
  );

  if (!file) {
    return (
      <Box flexDirection="column">
        {summary}
        <Text dimColor>
          {state.since
            ? data.since === null
              ? "no earlier look to compare with · press s to see everything"
              : "nothing has changed since your last look · press s to see everything"
            : "no changes yet"}
        </Text>
      </Box>
    );
  }

  const listWidth = sideBySide ? Math.min(48, Math.floor(width * 0.35)) : width;
  const listRows = sideBySide ? height + 1 : Math.min(files.length, 5);
  const [from, to] = windowAround(files.length, sel, listRows);
  const fileList = (
    <Box flexDirection="column" width={listWidth} flexShrink={0}>
      {files.slice(from, to).map((f, i) => {
        const isSel = from + i === sel;
        const st = STATUS[f.status];
        return (
          <Box key={f.path}>
            <Text color="green">{isSel ? "❯" : " "}</Text>
            <Text color="yellow">{!state.since && sinceSet.has(f.path) ? "●" : " "}</Text>
            <Text color={st.color}>{st.letter} </Text>
            <Box flexGrow={1} flexShrink={1}>
              <Text bold={isSel} dimColor={!isSel} wrap="truncate-start">{f.path}</Text>
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              {f.binary ? (
                <Text dimColor>bin</Text>
              ) : (
                <Text>
                  <Text color="green">+{f.added}</Text> <Text color="red">-{f.deleted}</Text>
                </Text>
              )}
            </Box>
          </Box>
        );
      })}
    </Box>
  );

  const scroll = Math.min(state.scroll, Math.max(0, file.lines.length - height));
  const st = STATUS[file.status];
  const patchWidth = sideBySide ? width - listWidth - 2 : width;
  const patch = (
    <Box flexDirection="column" width={patchWidth} flexShrink={0}>
      <Text wrap="truncate-start">
        <Text color={st.color}>{st.label} </Text>
        {file.oldPath && <Text dimColor>{file.oldPath} → </Text>}
        <Text bold>{file.path}</Text>
        {file.lines.length > height && (
          <Text dimColor>  {scroll + 1}–{Math.min(file.lines.length, scroll + height)} of {file.lines.length}</Text>
        )}
      </Text>
      {file.binary ? (
        <Text dimColor>binary file, not shown</Text>
      ) : file.lines.length === 0 ? (
        <Text dimColor>{file.status === "renamed" ? "renamed without changes" : "no content changes (mode only)"}</Text>
      ) : (
        file.lines.slice(scroll, scroll + height).map((line, i) => (
          <Text key={scroll + i} color={lineColor(line)} wrap="truncate-end">
            {line || " "}
          </Text>
        ))
      )}
    </Box>
  );

  return (
    <Box flexDirection="column">
      {summary}
      {sideBySide ? (
        <Box marginTop={1}>
          {fileList}
          <Box width={2} flexShrink={0} />
          {patch}
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {fileList}
          <Box marginTop={1}>{patch}</Box>
        </Box>
      )}
    </Box>
  );
}
