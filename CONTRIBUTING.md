# Contributing

Bug reports, ideas and pull requests are welcome.

## Setup

```
npm install
npm run dev     # rebuild on change
npm link        # puts `grove` on your PATH
npm test
```

You'll need Node 22 or later, git, tmux and Claude Code to try grove for real. The tests only need git.

## Pull requests

- Keep each PR to one change, and say what it's for in the description.
- Add or update tests in `test/` for behavior you change. They run against the built `dist/` with `node:test`.
- `npm run typecheck` and `npm test` should pass. CI runs both on macOS and Linux.
- To release, bump the version in `package.json`, add it to `CHANGELOG.md`, and push a `vX.Y.Z` tag. The
  release workflow runs the tests and attaches the built `grove.tgz` to a GitHub release.
- Anything that runs commands, builds shell strings or reads repo config needs a careful look. See
  [SECURITY.md](SECURITY.md) for why.
