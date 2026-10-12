// The bound repository on GitHub for the leg's agent (github-source.mjs): one
// token for every session of the leg, masked before anything holds it, and
// one warning when a session's server cannot be connected.
import { mintRepositoryToken } from "../task-api.mjs";
import { githubAccess } from "../github-source.mjs";
import { registerSecret } from "./redaction.mjs";
import { emit } from "./state.mjs";

const github = githubAccess({
  mint: mintRepositoryToken,
  registerSecret,
  onUnavailable: (reason) => emit("warning", "The agent cannot read the repository on GitHub in this run", {
    safeData: { event: "github_tools_unavailable", reason },
  }),
});

/**
 * The bound repository on GitHub, or null when the leg names none: named
 * whenever the project's binding is ready, checked out or not. Its tools are
 * declared directly, since the leg's session resumes its transcript.
 * @param {{ repository?: { owner: string, name: string } | null }} activity
 */
export function activityGitHub(activity) {
  return github.source(activity.repository, "direct");
}
