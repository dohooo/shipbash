# shipbash

The command line for [ShipBash](https://shipbash.dev), open-source AI QA that tests your web app or CLI on production from plain-language user journeys. It does what the console does with journeys, hooks and verifications, from a terminal or from a coding agent: have ShipBash find the journeys that matter, change them (ShipBash walks each change on the live product before you keep it), set when they run or run them now, read the results, and pull the evidence of a run, a walk or a Discovery for an agent to read.

```
npx shipbash login
npx shipbash projects
npx shipbash journeys --project <project>
```

Run it with `npx shipbash`, or install it with `npm install -g shipbash`. Node 20.17, 22.13 or 23.5 and newer; no runtime dependencies.

For coding agents: `npx skills add dohooo/shipbash-skills` installs the ShipBash skill, which tells the agent how to work with this CLI.

## Commands

- `login`, `logout`, `status`, `teams`, `projects`: sign in, pick the team, and pick or add the project.
- `journeys`: list and show journeys, add or edit them through a walk, keep or discard what a walk left, remove them, set the schedule, run them now.
- `hooks`: the setup and cleanup that run around the journeys.
- `verifications`, `evidence`: read results, and pull the evidence of a journey of a run, a walk or a Discovery, whatever the outcome.

`npx shipbash help` lists every command, and `npx shipbash <command> --help` explains one, including whether it takes effect at once and how it waits. `login` keeps its token and the team in use under `~/.config/shipbash/`, readable by you alone.

## Agent mode

In a terminal the CLI asks and prints text. Under a coding agent, in CI or in a pipe it never asks, prints one JSON object on stdout (with `nextSteps` when something must happen next), and returns from long waits after 90 s with exit 3; `--json` or `SHIPBASH_AGENT=1` forces agent mode and `SHIPBASH_AGENT=0` forces text. Exit codes: 0 done, 1 failed, 2 the user must act or decide, 3 still running.
