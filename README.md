# grove

A terminal dashboard for running Claude Code sessions side by side, each in its own git worktree.

```
cd ~/dev/some-repo
grove
```

| Key | Action |
|---|---|
| `n` | New worktree + branch (or check out an existing branch), copy env files, run setup, start Claude |
| `enter` | Attach to the session (relaunches with `--continue` if Claude exited). `ctrl-b d` returns |
| `d` | Diff against the base branch |
| `m` | Merge the branch into the base in your main checkout |
| `p` | Push and open a PR with `gh pr create --fill` |
| `x` / `X` | Remove the worktree / force-remove, discarding uncommitted changes |
| `j`/`k`, arrows | Move |
| `q` | Quit (sessions keep running in tmux) |

## How it works

- Worktrees live in `~/.grove/worktrees/<repo>/<branch>`.
- Each Claude session runs in a window of the tmux session `grove-<repo>`.
- Claude is launched with `--settings ~/.grove/claude-settings.json`, which adds hooks that write the session's
  state (working / needs you / idle) and current activity (the file being edited, the command running, the
  permission being asked for) to `~/.grove/status/`. Your own settings are untouched.

## Config

Optional `.grove.json` in the repo root:

```json
{
  "base": "main",
  "copy": ["**/.env*", ".claude/settings.local.json"],
  "setup": "pnpm install",
  "claudeArgs": ["--model", "opus"]
}
```

Defaults: `base` is `origin/HEAD` or the current branch, `copy` copies gitignored `.env*` files and
`.claude/settings.local.json`, and `setup` is guessed from the lockfile (pnpm/yarn/bun/npm/uv).

## Development

```
npm install
npm run build   # or npm run dev
npm link        # puts `grove` on your PATH
```
