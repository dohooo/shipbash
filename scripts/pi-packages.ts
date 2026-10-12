// The pi packages the runner image installs, read from the one place they are
// pinned: `ARG PI_PACKAGES` in packages/runner/Dockerfile, which both of the
// image's installs use. The pi lanes install the same set from here, the
// pre-push gate (gate-prepush.ts) and the checks job (.github/workflows/gates.yml):
//
//   tsx scripts/pi-packages.ts    prints the set, space-separated
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const EXACT_PIN = /^@earendil-works\/[a-z0-9-]+@\d+\.\d+\.\d+$/u;

/** The exact `@earendil-works` pins in a Dockerfile's `ARG PI_PACKAGES="…"`. */
export function piPackages(dockerfile: string): string[] {
  const value = /^ARG PI_PACKAGES="([^"]*)"/mu.exec(dockerfile)?.[1];
  if (value === undefined) throw new Error("packages/runner/Dockerfile declares no ARG PI_PACKAGES value.");
  const pins = value.replaceAll("\\\n", " ").split(/\s+/u).filter(Boolean);
  const loose = pins.filter((pin) => !EXACT_PIN.test(pin));
  if (loose.length > 0) throw new Error(`PI_PACKAGES must hold exact @earendil-works pins, not ${loose.join(", ")}.`);
  if (!pins.some((pin) => pin.startsWith("@earendil-works/pi-coding-agent@"))) {
    throw new Error("PI_PACKAGES does not pin @earendil-works/pi-coding-agent.");
  }
  return pins;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(piPackages(readFileSync("packages/runner/Dockerfile", "utf8")).join(" "));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
