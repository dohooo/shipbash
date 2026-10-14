// The pages the Project's knowledge knows (contracts runtime/known-pages.mjs)
// that the step a walk is on is after, offered to Jev as opens: a proficient
// user opens the page they know rather than finding their way to it. Only a
// page on the walk's own origin, never the one it is on; on a page Jev must
// not act on, an open is all it is offered (it leaves without touching it).
import { pagesFor } from "@shipbash/contracts/runtime/known-pages.mjs";
import { browserOption } from "./jev-target.mjs";

const OFFERED = 3;

/**
 * This page's options with up to three known pages the step is after.
 * @param {Array<{ ref: string, description: string, tool: string, args: Record<string, any> }> | null} options
 * @param {{ url: string }} state
 * @param {import("@shipbash/contracts/runtime/known-pages.mjs").KnownPage[]} pages
 * @param {string | undefined} stepText the instruction of the step the walk is on
 */
export function withKnownPages(options, state, pages, stepText) {
  if (!pages?.length || !stepText) return options;
  const here = new URL(state.url);
  const elsewhere = pages.filter((page) => {
    try {
      const url = new URL(page.url);
      return url.origin === here.origin && url.href !== here.href;
    } catch {
      return false;
    }
  });
  const opens = pagesFor(elsewhere, stepText, OFFERED).map((page, index) =>
    browserOption(`known_open_${index}`, `Open the known page ${JSON.stringify(page.title)}: ${page.purpose}`, "agent_browser_open", { url: page.url }),
  );
  if (!opens.length) return options;
  return options ? [...options, ...opens] : opens;
}

