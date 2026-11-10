# Changelog

## Unreleased

- `d` opens a diff screen: the changed files beside the selected file's patch, refreshing while the agent works.
  Files that changed since you last looked are marked `●`, and `s` shows only those changes
- `D` shows the whole patch in git's pager, as `d` used to
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
