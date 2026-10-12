/**
 * The single source of the Runner image reference, so a version bump cannot
 * miss a copy and leave a host silently launching last release's container.
 * The tag is the
 * product version, so every release is a new local image.
 */
import { SHIPBASH_VERSION } from "@shipbash/contracts/version";

export const RUNNER_IMAGE_VERSION = SHIPBASH_VERSION;
export const RUNNER_IMAGE = `shipbash-runner:${RUNNER_IMAGE_VERSION}`;
