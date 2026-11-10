# Changelog

## 0.1.2

- `d` opens a diff screen: the changed files beside the selected file's patch, refreshing while the agent works.
  Files that changed since you last looked are marked `●`, and `s` shows only those changes
- `D` shows the whole patch in git's pager, as `d` used to
- The key bar shows only the everyday keys; `?` opens a help screen explaining every key
- New sessions open straight into Claude; `ctrl-b d` brings you back with the new one selected
- The newest session is listed first, and the selection stays on the same session as others come and go
- Branch names use the width the terminal has instead of stopping at 40 characters; names that still
  don't fit are cut in the middle, so both the prefix and the end stay visible
- The base branch stays in sync with its remote: grove fetches every 2 minutes (or on `u`) and fast-forwards it,
  so new sessions start from the latest code. The header shows whether it's in sync, has unpushed commits,
  or couldn't be updated and why
- Fix: diffs left out files the agent had created but not committed

## 0.1.1

- Quieter tmux status bar inside a session: it sits on the terminal's background instead of tmux's
  bright green, shows grove's session tabs, and reminds you how to get back to the dashboard

## 0.1.0

First public release.

- Dashboard for Claude Code sessions, each in its own git worktree and tmux window, with live state and
  activity from Claude's hooks
- Merge conflicts predicted between worktrees, uncommitted changes included
- Fan-out: run one task in several worktrees, compare them, and keep the best
- Integration preview: one checkout with every worktree's work merged
- Asks before running a repo's setup, test and `claude` arguments
