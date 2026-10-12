/**
 * The registries the task lanes start and stop sessions through, so close()
 * drains all of them from one place. This record simply gives those former
 * closure variables a name the lane modules can share.
 */

import type { HumanAuthSession } from "../../human-auth.ts";
import { shortDigest } from "../short-digest.ts";

export interface AuthSessionState {
  /** Live sessions by id; routes read viewer URLs, close() drains it. */
  sessions: Map<string, HumanAuthSession>;
  /** In-flight session starts; close() awaits them before teardown. */
  starts: Map<string, Promise<HumanAuthSession>>;
}

export function createAuthSessionState(): AuthSessionState {
  return {
    sessions: new Map(),
    starts: new Map(),
  };
}

/**
 * The landing URL a takeover container opens: the production URL with its
 * query and fragment stripped, so a one-time token in the link the operator
 * followed never reaches the browser profile.
 */
export function authLandingUrl(value: string): string {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** A stable per-target session id, so a repeated takeover finds its own container. */
export function taskAuthSessionId(
  projectId: string,
  targetKind: "run" | "activity",
  targetId: string,
): string {
  return `task-${targetKind}-${shortDigest(`${projectId}\0${targetId}`)}`;
}
