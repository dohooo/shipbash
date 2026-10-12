"use client";

import { useQuery } from "@tanstack/react-query";

import { type ConsoleLine, formatConsoleLines, parseConsoleLines } from "../_lib/evidence";
import { queryKeys } from "../../lib/query-keys";

/**
 * The page's own console output, read from the walk's console file only once
 * the reader asks for it. The file is served by the same signed artifact route as
 * the screenshots, so a plain fetch carries the session cookie.
 */
async function readConsole(url: string | null): Promise<string> {
  // The query is enabled only with a url present; the guard states that
  // invariant where the type cannot narrow across the enabled option.
  if (url === null) throw new Error("The console output could not be read.");
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error("The console output could not be read.");
  return response.text();
}

export function useEvidenceConsole(url: string | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.evidenceConsole(url),
    queryFn: async () => formatConsoleLines(await readConsole(url)),
    enabled: enabled && Boolean(url),
  });
}

/** The same file as rows, for the drawer that prints a level and a clock. */
export function useEvidenceConsoleLines(url: string | null, enabled: boolean) {
  return useQuery<ConsoleLine[]>({
    queryKey: queryKeys.evidenceConsoleLines(url),
    queryFn: async () => parseConsoleLines(await readConsole(url)),
    enabled: enabled && Boolean(url),
  });
}

export function consoleFoldText(query: ReturnType<typeof useEvidenceConsole>): string {
  if (query.isPending) return "Reading the console output…";
  if (query.isLoadingError) return "The console output could not be read.";
  return query.data || "The page logged nothing during this walk.";
}
