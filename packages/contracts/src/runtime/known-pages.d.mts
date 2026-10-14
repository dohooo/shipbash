export interface KnownPage {
  title: string;
  url: string;
  purpose: string;
}
export declare const KNOWN_PAGES_FILE: "known-pages.json";
export declare function pagesFor(pages: readonly KnownPage[], text: string, limit: number): KnownPage[];
