// The "Shipped" table at the top of a GitHub Release: what this tag put
// into production, one row per part. release.yml runs it after the deploy
// with the job results in the environment and prepends the output to
// changelogithub's notes.
import { readFileSync } from "node:fs";

const env = process.env;
const tag = env.GITHUB_REF_NAME ?? "";
const previous = env.PREVIOUS_TAG ?? "";
const migrations = (env.MIGRATIONS ?? "").split(/\s+/u).filter(Boolean);
const runnerImage = (env.RUNNER_IMAGE ?? "").trim();
const runtimeVersion = (env.RUNNER_RUNTIME ?? "").trim();
const cliVersion = JSON.parse(readFileSync("packages/cli/package.json", "utf8")).version;

const database = migrations.length === 0
  ? "no migrations"
  : `${migrations.length} migration${migrations.length === 1 ? "" : "s"} · applied<br>${migrations.map((name) => `\`${name}\``).join("<br>")}`;
const image = runnerImage
  ? `\`${runnerImage.replace(/^.*\//u, "")}\` · rebuilt`
  : "unchanged";
const marketing = env.MARKETING === "success" ? "deployed" : "unchanged";
const compare = previous
  ? `\n**Full changelog**: [${previous}...${tag}](https://github.com/dohooo/shipbash/compare/${previous}...${tag})\n`
  : "";

process.stdout.write(`## Shipped

| Surface | Status |
|---|---|
| Console | [app.shipbash.dev](https://app.shipbash.dev) · deployed |
| Marketing | [shipbash.dev](https://shipbash.dev) · ${marketing} |
| Database | ${database} |
| Runner image | ${image} |
| Runner runtime | ${runtimeVersion ? `\`${runtimeVersion}\` · installed into every project on its next run` : "unchanged"} |
| CLI | \`shipbash@${cliVersion}\` on npm |
${compare}
`);
