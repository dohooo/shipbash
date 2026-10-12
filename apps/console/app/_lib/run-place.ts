import type { RunPageView } from "@shipbash/contracts/api/view-types";

/**
 * Where a reader is on a settled run, as a link carries it:
 * `?journey=<id>&t=<seconds>`. The journey is named in the id space of the
 * page the link opens, and `t` is whole seconds into that journey's
 * recording, as a video link's is.
 */
export interface RunPlace {
  journey: string | null;
  /** Milliseconds into the journey's recording; null without one to place. */
  atMs: number | null;
}

/** The link's query for a place: none without a journey, and no `t` at the start. */
export function placeSearch({ journey, atMs }: RunPlace): string {
  if (!journey) return "";
  const params = new URLSearchParams({ journey });
  const seconds = Math.floor((atMs ?? 0) / 1_000);
  if (seconds > 0) params.set("t", String(seconds));
  return `?${params.toString()}`;
}

/**
 * The place a link names, kept only where the run has it: a journey the run
 * does not show is no place, and a time the journey's recording does not
 * reach is its start.
 */
export function linkedPlace(
  search: Pick<URLSearchParams, "get">,
  cases: RunPageView["cases"],
): RunPlace {
  const entry = cases.find((item) => item.id === search.get("journey"));
  if (!entry) return { journey: null, atMs: null };
  const t = search.get("t");
  const atMs = t && /^\d+$/u.test(t) ? Number(t) * 1_000 : 0;
  const durationMs = entry.detail.recording?.durationMs ?? 0;
  return { journey: entry.id, atMs: atMs > 0 && atMs < durationMs ? atMs : null };
}

/**
 * The view with the linked journey's recording opening at the linked time: a
 * media fragment (`#t=`), so the video loads there, paused, and the player
 * reads its playhead off the element as it does after any seek.
 */
export function openedAt(view: RunPageView, { journey, atMs }: RunPlace): RunPageView {
  if (!journey || atMs === null) return view;
  return {
    ...view,
    cases: view.cases.map((entry) => {
      const { recording } = entry.detail;
      if (entry.id !== journey || !recording) return entry;
      const contentUrl = `${recording.contentUrl}#t=${String(atMs / 1_000)}`;
      return { ...entry, detail: { ...entry.detail, recording: { ...recording, contentUrl } } };
    }),
  };
}
