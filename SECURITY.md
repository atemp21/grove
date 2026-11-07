# Security

## Reporting a vulnerability

Please don't open a public issue. Report it privately through
[GitHub's security advisories](https://github.com/atemp21/grove/security/advisories/new) instead.
I'll reply within a week.

## What grove trusts

grove runs commands in the repos you open, so the main things to protect are:

- **Repo config.** A repo's `.grove.json` can set `setup` and `test` shell commands and extra `claude` flags.
  The install and test commands grove guesses run the repo's own scripts. None of these run until you approve
  them at startup, and grove asks again if they change. Approvals are stored in `~/.grove/trusted.json`.
- **Shell strings.** Only the tmux window command is built as a shell string, and every value in it is
  single-quoted. Everything else is run with an argument list, never through a shell.
- **Hook output.** Session activity comes from Claude's hook payloads. grove strips control characters from it
  before showing it, so it can't send escape sequences to your terminal.
- **Local state.** `~/.grove` is kept at mode 700, because the status files can contain commands Claude ran.
