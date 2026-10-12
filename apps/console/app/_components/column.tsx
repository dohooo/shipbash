import type { ReactNode } from "react";

/**
 * The element a page's column is: what heads it, then the page's `main`. The
 * page's layout rules (globals.css) ask this element what its `main` holds,
 * never an ancestor the page shares with other pages: Next keeps a page the
 * reader left in the document, hidden, and an ancestor asking would still
 * find it there under the page that came next.
 */
export function Column({ head, children }: Readonly<{ head: ReactNode; children: ReactNode }>) {
  return (
    <div className="page-column">
      {head}
      <main>{children}</main>
    </div>
  );
}
