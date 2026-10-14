// The pages a product's knowledge already knows (product_knowledge page
// entries, which Discovery and walks write): title, URL and purpose, handed to
// a Suite Run beside its case openings (control-plane agent-data/opening.ts),
// so Jev can open a known page a step is after instead of finding its way
// there (runner jev-known-pages.mjs).

export const KNOWN_PAGES_FILE = "known-pages.json";

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "once", "then", "open", "page", "click", "verify", "show",
  "shows", "still", "after", "before", "which", "not", "its", "their", "your", "all", "any", "are", "was", "has", "have",
]);

/** A text's content words, lower case, a plural's ending folded. */
function contentWords(text) {
  const words = String(text).toLowerCase().match(/[a-z0-9]{3,}/gu) ?? [];
  return new Set(words.filter((word) => !STOP_WORDS.has(word)).map((word) => word.replace(/ies$/u, "y").replace(/s$/u, "")));
}

/**
 * The known pages whose title shares the most content words with a text, best first, at most `limit`.
 * @param {import("./known-pages.d.mts").KnownPage[]} pages
 * @param {string} text
 * @param {number} limit
 */
export function pagesFor(pages, text, limit) {
  const wanted = contentWords(text);
  return pages
    .map((page) => ({ page, shared: [...contentWords(page.title)].filter((word) => wanted.has(word)).length }))
    .filter((entry) => entry.shared > 0)
    .sort((left, right) => right.shared - left.shared)
    .slice(0, limit)
    .map((entry) => entry.page);
}
