// Thin entry for the suite runner, which lives in ./suite-runner/. This path
// is the container contract — the Dockerfile ENTRYPOINT delegation,
// src/docker-runtime.ts, src/init-browser-control.ts, src/init-browser-verify.ts,
// lib/production-human-auth.ts and runtime/vercel-dispatch-runner.mjs all invoke
// /shipbash/runtime/suite-runner.mjs by path — so it stays, dispatching to the
// directory's main.
import { pathToFileURL } from "node:url";

import { main } from "./suite-runner/main.mjs";
import { nameUnlistedUid } from "./uid-name.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await nameUnlistedUid();
  await main();
}
