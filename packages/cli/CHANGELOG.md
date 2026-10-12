# shipbash

## 0.0.15

### Patch Changes

- Describe ShipBash as open-source AI QA for a web app or CLI in the package description and README.

## 0.0.14

### Patch Changes

- The CLI is now licensed under Apache-2.0 instead of MIT; versions 0.0.13 and earlier stay MIT. The package ships its `LICENSE` and, in `dist/THIRD_PARTY_LICENSES.md`, the licenses of the dependencies bundled into it.

- `shipbash evidence <id>` also takes the id of a walk or a Discovery. It pulls the walk's or the Discovery's conversation, its outcome and closing words, and the screenshots, screen recordings and terminal logs of each part it ran in, in the same bundle format as a journey's: README.md, evidence.json, then the files. `verifications show` and `wait` now offer the evidence command under every journey walked, passed ones too, and in agent mode give every journey's `caseRunId`. The command's JSON result names the pulled id as `id`.

## 0.0.13

### Patch Changes

- `shipbash evidence` takes the id of one walk (`case_run_…`, in the failure report's prompt) instead of a URL and `--project`. The bundle holds the run's overview and every attempt of that journey, with a README that names the command for the run's other failed journeys; `--out` of a second pull adds to the same folder.

## 0.0.12

### Patch Changes

- `shipbash evidence` in agent mode reports how many files it wrote, not the name of each: a long run's bundle held over a thousand.

## 0.0.11

### Patch Changes

- `shipbash evidence` downloads a verification's evidence as one zip and unpacks it, instead of fetching every file on its own.

## 0.0.10

### Patch Changes

- Keep and discard the drafts of a walk a Slack conversation started (activity kind `walk`) like any walk's; a conversation itself no longer walks.

- Set ShipBash up from a coding agent. `projects add <production URL>` adds a project to the team in use. In agent mode `login` returns a new pairing code and its approval URL at once (exit 3), and the next `login` waits for it. An agent waiting for a walk also gets the walk's page in the console as `url`.

## 0.0.9

### Patch Changes

- `journeys keep`, `journeys discard` and the walk commands accept a conversation (an Activity started from a chat with ShipBash) as a walk, so its drafts are kept or discarded like any walk's.

- `journeys keep` says "No run walks what was kept, so there is nothing to verify." when the drafts kept change no journey a run walks (only removals, or only journeys walked once), instead of "The verification did not start."; its help says the verification covers the scheduled journeys the drafts add or change.

## 0.0.8

### Patch Changes

- An account signed in to ShipBash with Google alone is named by its email in `login` and `status`, where a GitHub account keeps its `@login`.

## 0.0.7

### Patch Changes

- A request that fails on the way to ShipBash (the connection dropped or reset, no answer within 30 s, or a 502, 503 or 504 from a gateway in front of ShipBash) no longer ends a wait: `journeys run`, `verifications wait`, the walk waits and `login` look again at the next poll, printing one line on stderr when the connection is lost and one when it is back, and still return at their limit with `STILL_RUNNING` (exit 3) and the command that keeps waiting. Outside a wait it fails with `NETWORK` (exit 1) and the step to run the same command again, instead of `UNEXPECTED` with no step. A 503 in which ShipBash names its own error code is still reported with that code.

## 0.0.6

### Patch Changes

- The package README and npm description cover the whole command set (account, journeys, hooks, verifications and evidence) and agent mode, and point coding agents to the ShipBash skill: `npx skills add dohooo/shipbash-skills`.

- The evidence bundle's README names a walk's recording `case-replay.mp4`: the replay is now H.264 in MP4, sped through its idle stretches, with its chapters, the agent's actions and its narration drawn on it.

- The CLI works in two modes with one command set. In a terminal it asks and prints text; under a coding agent (detected with `@vercel/detect-agent`), in CI or in a pipe it never asks, prints exactly one JSON object on stdout, and returns from long waits after 90 s with exit 3. `--json` or `SHIPBASH_AGENT=1` forces agent mode and `SHIPBASH_AGENT=0` forces text. Exit codes are 0 done, 1 failed, 2 the user must act or decide (now also `TOKEN_REVOKED` and `WRONG_ORIGIN`), 3 still running.
  
  `login` ends by choosing the team commands use, stored in `config.json`; an agent gets `TEAM_CHOICE_REQUIRED` with the choices when there are several. A pairing not yet approved is kept in `login.json`, so running `login` again keeps waiting for the same code, and `login --timeout <seconds>` bounds the wait. New commands: `teams`, `teams switch [<team>]` and `projects`. `status` shows the team in use and the mode; `logout` also forgets the team and any pending pairing. Every command has its own `--help`, and an option a command does not take is refused. Needs Node 20.17, 22.13 or 23.5 and newer.

- Journeys and hooks from the terminal, each command with `--project <project>`. `journeys` lists the project's journeys with their latest verdict and state, and what is waiting for you: staged edits, drafts a walk left to keep or discard, and explorations still under way. `journeys show <ref>` prints one journey's script, and `journeys rm <ref>` stops guarding it, together with the hooks scoped to it. `hooks`, `hooks show <ref>`, `hooks add --file <path>`, `hooks edit <ref> --file <path>` and `hooks rm <ref>` read and write the hooks directly; the file is what `hooks show <ref> --json` prints, and ShipBash derives a hook's category from its slot. A ref is an id or any unique prefix of it; text shows the first 8 characters and JSON the full id. A journey's ref given to a hooks command, or the reverse, fails with `WRONG_KIND`. Removals ask in a terminal; in agent mode they stop with `CONFIRMATION_REQUIRED` (exit 2) unless `--yes` is given, and nothing is written before that. A write made against a revision the journeys have since moved past fails with `REVISION_CONFLICT` (exit 1), writes nothing, and says how to start again.

- Schedule, run now, history and evidence by id, each command with `--project <project>`. `journeys schedule` prints when the journeys run on their own, and `journeys schedule set daily <HH:MM> | cron "<expr>" [--timezone <tz>]` or `set off` changes it at once; without `--timezone` the saved schedule's time zone is kept, else this machine's is used, and `off` is how a schedule is cleared. `journeys run` starts a verification of every journey (or joins the one already running) and waits for it, printing each journey's verdict as it lands and then the result: a failed verdict is a result, so the command exits 0 with the verdict in the output. `verifications` lists the recent verifications, `verifications show <verification>` prints one's result (each journey's ref, verdict and duration, and for a journey that did not pass its failed checkpoints and reason, with the evidence command and the console link; a journey that failed once and passed on an immediate re-run is flaky, not failed), and `verifications wait <verification>` keeps waiting for one. A verification is named by the first characters of its id's hex part, with or without `suite_run_`, or by its full id. A wait returns after 90 s in agent mode (or after `--timeout`), aborting any read still in flight, with `STILL_RUNNING` (exit 3) and the command that keeps waiting; a run that reaches a sign-in page stops with `SIGN_IN_NEEDED` (exit 2) and the page where the user signs the browser in. `evidence` also takes a verification's id or prefix with `--project`; the URL from a failure report still works, on its own.

- The rest of what the console does with walks, each command with `--project <project>`. `journeys revise <walk> "<change>"` asks a walk for a change: a walk under way takes it as it goes and a finished discovery wakes to walk it, while the drafts a finished walk left are revised by a new walk; it then waits and ends in the same decision as `journeys add`. On a finished edit walk it points to `journeys edit <ref>` and `journeys discard <ref>` instead. `journeys stop <walk>` asks ShipBash to stop the walk and prints how it stopped it: a discovery at work wraps up (it keeps what it found and delivers it), anything else is canceled. `journeys retry <walk>` walks a failed, stopped or superseded walk again as a new walk and waits for it, and refuses any other walk with `ACTIVITY_NOT_RETRYABLE` before sending anything. `journeys discard` also takes the ref of a journey with edits staged, and then discards all the staged edits, walked or not, after a person confirms the list. It refuses what was already kept or discarded before sending anything; `journeys revise` does the same for drafts already decided or still being walked. Keeping an edit walk still under way now stops with `WALK_NOT_FINISHED` before anything is sent. A walk command given the id of an activity that is not a walk answers `UNKNOWN_REF`.

- Walks from the terminal, each command with `--project <project>`: journey content changes only through a walk, and the CLI completes it without the console. `journeys add` has ShipBash explore the product on its own (how a project starts) or, given `"<path>"`, walk the path you describe; `journeys edit <ref> "<change>" [--file <path>]` stages a change to a journey (after the instruction already staged for it) and has ShipBash walk it, and `journeys edit <ref>` with no change walks the staged edits again. Both wait for the walk, printing what the agent reports as it goes. A question the walk stops on is asked at the terminal; in agent mode it stops with `QUESTION` (exit 2) and is answered with `journeys answer <walk> "<answer>"`. When the walk ends, a terminal asks which drafts to keep, or whether to keep the proved edit; in agent mode it stops with `DECISION_REQUIRED` (exit 2) and the review, decided with `journeys keep <walk> [<draft>…]` or `journeys discard <walk>`. Kept drafts join the schedule and the output links the verification ShipBash started of them; a kept edit replaces the live journey. `journeys wait <walk>` keeps waiting and ends in the same decision. A wait returns after 90 s in agent mode (or after `--timeout`) with `STILL_RUNNING` (exit 3) and the command that keeps waiting; a walk at a sign-in page stops with `SIGN_IN_NEEDED` (exit 2) and the walk's page. Edits staged while a walk verifies earlier ones are refused with `EDITS_BEING_VERIFIED` and the walk to finish first. When the journeys moved while an edit walked (`SUPERSEDED`), or the walk proved none of the staged edits (`NOTHING_PROVED`), nothing is kept: a terminal offers to walk the staged edits again, and in agent mode the next steps name the command that does. What a keep reports as kept is what ShipBash says landed; a keep sent again is told the drafts or edits were already decided.

## 0.0.5

### Patch Changes

- `shipbash evidence` no longer copies each journey's file list into run.json. The service now lists every file a walk kept on the run, step screenshots included, and evidence.json already lists every file.

## 0.0.4

### Patch Changes

- `shipbash evidence` no longer leaves out, without a word, an artifact file it could not download. It fails with `EVIDENCE_INCOMPLETE`, naming each file and why (an HTTP status, a timeout or a network error); with `--json` the error carries `directory` and `missing`. The files it did download stay in place, and evidence.json records the `missing` list, so a bundle handed on later says it is incomplete.

## 0.0.3

### Patch Changes

- `shipbash evidence` writes run.json (checkpoints and the execution log) and a README beside evidence.json; a missing sign-in now tells the agent what to do next, and `login --no-browser` skips opening one.
