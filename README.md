# grove

A terminal dashboard for running Claude Code sessions side by side, each in its own git worktree.

## Install

You'll need Node 22 or later, git, [tmux](https://github.com/tmux/tmux) and
[Claude Code](https://docs.claude.com/en/docs/claude-code). `p` (open a PR) also needs the
[GitHub CLI](https://cli.github.com). grove runs on macOS and Linux.

```
npm install -g https://github.com/atemp21/grove/releases/latest/download/grove.tgz
```

Or from source: clone the repo, then `npm install && npm run build && npm link`.

Then run it from any git repo:

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
| `v` | Create the integration preview, or open a shell in it |
| `space` | Put the selected worktree into the preview or take it out |
| `V` | Remove the preview |
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

## Preview

`v` creates `~/.grove/worktrees/<repo>/_preview`, a checkout of everyone's work merged together, uncommitted
and untracked files included, and opens a shell there that first runs `setup`. Run your dev server in it to try
all the branches at once. Every couple of seconds grove merges the base and each worktree in the preview, in
name order, and writes the result into it with `git read-tree -u --reset`. Only changed files are rewritten, so
hot reload picks them up. A worktree that would conflict with the ones merged before it is left out and marked
`⊘` in the list, so the preview never has conflict markers. HEAD stays on the base, so `git diff --cached` in
the preview shows the combined change.

Every worktree is in the preview by default; `space` takes it out. Candidates of a fan-out are out by default,
and choosing one with `space` drops its siblings. The preview is read-only: edits made in it are overwritten on
the next update (gitignored files like `node_modules` and build output are left alone). Make changes in a
worktree instead.

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

`setup`, `test` and `claudeArgs` let a repo run commands on your machine, and so do the guessed install and
test commands (they run the repo's own scripts). The first time grove opens a repo with any of them, it shows
them and asks before running them. It asks again if they change. Approvals are kept in
`~/.grove/trusted.json`. If you say no, grove still works, but without setup, tests or extra `claude` args.

## Fan-out

`f` asks for a task and starts Claude on it in several fresh worktrees (`<task>-a`, `-b`, …), grouped under
the task in the list. The compare view shows each candidate's lines and files changed, commits, test result
and conflicts, and marks the smallest change whose tests pass with ★. `w` keeps the candidate you pick and
deletes the other worktrees and their branches. Candidates of one fan-out aren't flagged as conflicting
with each other, since they're alternatives.

## Security

grove runs commands on your machine on a repo's behalf, so it asks before running anything a repo sets. See
[Config](#config) and [SECURITY.md](SECURITY.md).

## Development

```
npm install
npm run build   # or npm run dev
npm link        # puts `grove` on your PATH
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
