/**
 * The client-safe value surface `app/` components may use from `src/`.
 *
 * Everything here must be importable by a browser bundle: pure constants and
 * pure functions only, no transitive reach into postgres, node built-ins, or
 * process state. Server-only values live in `lib/server-contracts.ts`, whose
 * `server-only` guard makes a client import fail at compile time instead of
 * shipping a page that 500s.
 */
export { deriveBrowserRecordingChapters } from "@shipbash/contracts/runtime/recording-timeline.mjs";
export {
  safeBrowserStreamUrl,
  safeBrowserViewerUrl,
} from "@shipbash/contracts/browser-connection-url";
