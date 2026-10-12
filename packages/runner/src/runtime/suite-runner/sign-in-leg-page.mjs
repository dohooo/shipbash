// The page a sign-in leg reads, over the suite runner's own browser client.
//
// This exists because the two agent-browser clients in this repository answer
// in different shapes and only one of them is what the frame readers expect.
// The Activity runner's client is built with `unwrapJson`, so a command
// answers `{ success, data }` — which is what first-frame.mjs reads. The suite
// runner's client keeps the whole process result and puts the parsed reply
// under `json`, so `response.data` on it is undefined.
//
// Handed through unchanged, that difference is silent and total: every frame
// comes back with no URL and no snapshot, captureFirstFrame answers null, and
// the leg reports "no login page found" for a product whose login page was
// on screen the whole time. So the unwrapping happens
// here, once, and both sign-in legs read their frames through it.

/**
 * The suite runner's client, in the shape the first-frame reader expects.
 *
 * @param {(args: string[], env: object, options?: object) => Promise<any>} client
 */
export function firstFrameClient(client) {
  // Errors pass straight through: settleSignIn reads the diagnostics off a
  // thrown agent-browser failure to tell a redirect from a real fault.
  return async (args, env, options) => (await client(args, env, options))?.json ?? null;
}
