// The bound repository on GitHub for the run's agents (github-source.mjs), the
// case agent's and the code-evidence inspector's: one token for the whole run,
// masked before anything holds it, and one warning when a session's server
// cannot be connected.
import { mintRepositoryToken } from "../task-api.mjs";
import { githubAccess } from "../github-source.mjs";
import { registerSecret } from "./redaction.mjs";
import { emit } from "./state.mjs";

const github = githubAccess({
  mint: mintRepositoryToken,
  registerSecret,
  onUnavailable: (reason) => emit("infrastructure", "github_tools_unavailable", {
    message: `The agents cannot read the repository on GitHub in this run: ${reason}`,
  }),
});

/**
 * The bound repository on GitHub for one agent of the run, or null when the
 * run names none. Its tools wait behind tool_search: no session of a run
 * resumes a transcript.
 * @param {{ repository?: { owner: string, name: string } | null }} suite
 */
export function caseGitHub(suite) {
  return github.source(suite.repository, "deferred");
}
