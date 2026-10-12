import { isDirectInvocation } from "./direct-invocation.ts";
import { ensureRunnerImage } from "./runner-image-identity.ts";

export async function buildRunnerImage(): Promise<void> {
  await ensureRunnerImage();
  process.stdout.write("ShipBash runner image is current.\n");
}

if (isDirectInvocation(process.argv[1], import.meta.url)) {
  await buildRunnerImage();
}
