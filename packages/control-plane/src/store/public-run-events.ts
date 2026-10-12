import type { PublicEvent } from "@shipbash/contracts/api/public-verifications";

/** Categories come from a fixed vocabulary, never event payloads, commands or model text. */
export function publicEventCategory(type: string, verdict: string | null): Pick<PublicEvent, "kind" | "level"> {
  if (type === "case_completed" || type === "suite_completed") {
    return { kind: "result", level: verdict === "failed" || verdict === "error" ? "error" : verdict === "blocked" ? "warning" : "info" };
  }
  if (type === "waiting_for_auth" || type === "browser_recording_unavailable") return { kind: "system", level: "warning" };
  if (type === "case_started" || type === "case_checklist_updated") return { kind: "action", level: "info" };
  return { kind: "system", level: "info" };
}
