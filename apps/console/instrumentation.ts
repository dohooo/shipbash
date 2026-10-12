import { PHASE_PRODUCTION_BUILD } from "next/constants";

/**
 * A server started with an incomplete configuration says so once, as it
 * starts, naming every variable it lacks (configuration.ts), rather than on
 * the first request each route serves. A build has no deployment to read.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD) return;
  const { configuration } = await import("@shipbash/control-plane/configuration");
  configuration();
}
