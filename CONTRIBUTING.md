# Contributing to ShipBash

Pull requests are welcome. For a large change, open an issue first so we can
agree on the approach before you write it.

## Set up

Follow [Develop locally](README.md#develop-locally) in the README: Node.js 22
or later, the Bun version that package.json's `packageManager` names, Docker,
`bun install`, and a `.env` and `.env.local` filled in from `.env.example` and
`.env.local.example`. `bun run dev:doctor` checks the setup and `bun run dev`
starts the local stack. Bun installs the dependencies and runs the scripts;
the code itself runs on Node.

## Before you open a pull request

Run the checks CI runs (`.github/workflows/gates.yml` has the exact steps; it
also type-checks the runner's pi files):

```bash
bun run lint
bun run typecheck
bun run typecheck:marketing
bun run build
bun run build:marketing
bun run contracts:check   # needs Docker
```

`bun run lint` lints the files you changed and enforces the code limits:

- a file stays under 400 lines and a function under 100 lines;
- cyclomatic complexity is at most 15;
- no `as` type assertions.

Older code that breaks a limit is recorded in
`config/lint-discipline-baseline.json`. That list only shrinks: new code adds
nothing to it, and touching a file means clearing its recorded warnings.

The repository keeps no test suite. Verify a change by running the behaviour it
changes: the page in a browser, the CLI command, a run on the local stack. Say
in the pull request what you ran and what you saw. Tests that help you write
the change can stay on your machine as `*.local.test.ts`, which git ignores.

Changes to the console UI follow [DESIGN.md](DESIGN.md).

## Commits and the CLI

Write commit messages as [Conventional Commits](https://www.conventionalcommits.org)
(`feat:`, `fix:`, `docs:`, `refactor:` …): the release notes are generated from
them.

`packages/cli` is the public npm package `shipbash`, released on its own. A
change to it comes with a changeset: run `bunx changeset` and commit the file it
writes to `.changeset/`. The CLI is a single bundled file and imports nothing
from the rest of the repository.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
