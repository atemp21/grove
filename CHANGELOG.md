# Changelog

## 0.1.0

First public release.

- Dashboard for Claude Code sessions, each in its own git worktree and tmux window, with live state and
  activity from Claude's hooks
- Merge conflicts predicted between worktrees, uncommitted changes included
- Fan-out: run one task in several worktrees, compare them, and keep the best
- Integration preview: one checkout with every worktree's work merged
- Asks before running a repo's setup, test and `claude` arguments
