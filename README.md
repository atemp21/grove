# grove

A terminal dashboard for running Claude Code sessions side by side, each in its own git worktree.

```
cd ~/dev/some-repo
grove
```

| Key | Action |
|---|---|
| `n` | New worktree + branch (or check out an existing branch), copy env files, run setup, start Claude |
| `f` | Fan out: start one task in 2–5 worktrees at once (`tab` changes the count) to compare the results |
| `c` | Compare a fan-out's candidates side by side |
| `enter` | Attach to the session (relaunches with `--continue` if Claude exited). `ctrl-b d` returns |
| `d` | Diff against the base branch |
| `m` | Merge the branch into the base in your main checkout |
| `p` | Push and open a PR with `gh pr create --fill` |
| `x` / `X` | Remove the worktree / force-remove, discarding uncommitted changes |
| `j`/`k`, arrows | Move |
| `t` / `w` | In compare: run the tests in every candidate / keep the selected candidate and delete the others |
| `q` | Quit (sessions keep running in tmux) |

## How it works

- Worktrees live in `~/.grove/worktrees/<repo>/<branch>`.
- Each Claude session runs in a window of the tmux session `grove-<repo>`.
- Claude is launched with `--settings ~/.grove/claude-settings.json`, which adds hooks that write the session's
  state (working / needs you / idle) and current activity (the file being edited, the command running, the
  permission being asked for) to `~/.grove/status/`. Your own settings are untouched.
- Every couple of seconds grove snapshots each worktree as it is on disk (uncommitted and untracked files
  included, using a throwaway index) and runs `git merge-tree` on each pair, and on each worktree against the
  base, to flag merge conflicts before anyone merges. Worktrees, indexes and refs are never touched.

## Config

Optional `.grove.json` in the repo root:

```json
{
  "base": "main",
  "copy": ["**/.env*", ".claude/settings.local.json"],
  "setup": "pnpm install",
  "claudeArgs": ["--model", "opus"],
  "test": "pnpm test"
}
```

Defaults: `base` is `origin/HEAD` or the current branch, `copy` copies gitignored `.env*` files and
`.claude/settings.local.json`, `setup` is guessed from the lockfile (pnpm/yarn/bun/npm/uv), and `test`
defaults to the `package.json` test script.

## Fan-out

`f` asks for a task and starts Claude on it in several fresh worktrees (`<task>-a`, `-b`, …), grouped under
the task in the list. The compare view shows each candidate's lines and files changed, commits, test result
and conflicts, and marks the smallest change whose tests pass with ★. `w` keeps the candidate you pick and
deletes the other worktrees and their branches. Candidates of one fan-out aren't flagged as conflicting
with each other, since they're alternatives.

## Development

```
npm install
npm run build   # or npm run dev
npm link        # puts `grove` on your PATH
```
