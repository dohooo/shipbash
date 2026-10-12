// `bun run release <patch|minor|major>`: the one way a release starts.
// Bumps the root version on a clean, current main, pushes the commit and
// its v* tag, and release.yml takes it from there.
import { execFileSync } from "node:child_process";

const level = process.argv[2];
if (!["patch", "minor", "major"].includes(level ?? "")) {
  console.error("Usage: bun run release <patch|minor|major>");
  process.exit(2);
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (git("branch", "--show-current") !== "main") fail("Release from main.");
if (git("status", "--porcelain")) fail("The working tree has changes; commit or stash them first.");
// --force: the runner-image tag moves with every image build, and a fetch
// that refuses to clobber the local copy would refuse the release.
git("fetch", "--quiet", "--force", "origin", "main", "--tags");
if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) fail("main is not at origin/main; pull first.");

execFileSync("bun", ["pm", "version", level, "--message", "release: v%s"], { stdio: "inherit" });
const tag = `v${JSON.parse(git("show", "HEAD:package.json")).version}`;
// The tag goes up on its own: GitHub runs no workflow for a push that
// carries more than three tags, and --follow-tags would send every local one.
execFileSync("git", ["push", "origin", "main"], { stdio: "inherit" });
execFileSync("git", ["push", "origin", `refs/tags/${tag}`], { stdio: "inherit" });
console.log(`\n${tag} pushed. Watch it ship: https://github.com/dohooo/shipbash/actions/workflows/release.yml`);
