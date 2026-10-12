import type { z } from "zod";

import { runMessageFrameSchema } from "@shipbash/contracts/api/streams";

export type RunStreamMessage = z.output<typeof runMessageFrameSchema>;

export function parseRunStreamMessage(data: string) {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = runMessageFrameSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
