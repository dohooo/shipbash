const NAV_ITEMS = ["Dashboard", "Customers", "Invoices", "Reports", "Settings"];
const ROWS = ["row-1", "row-2", "row-3", "row-4", "row-5", "row-6"];

/**
 * A stand-in for a recorded frame: a made-up invoicing app whose page follows
 * the chapter, so scrubbing the preview changes the picture as well as the
 * overlay.
 */
export function SyntheticPage({ page }: { page: { nav: string; heading: string; action: string } }) {
  return (
    <div className="rov-page" aria-hidden="true">
      <div className="rov-page-top">
        <span className="rov-page-logo" />
        <span className="rov-page-brand">Acme Invoices</span>
        <span className="rov-page-search" />
        <span className="rov-page-avatar" />
      </div>
      <nav className="rov-page-nav">
        {NAV_ITEMS.map((item) => (
          <span data-active={item === page.nav ? "" : undefined} key={item}>{item}</span>
        ))}
      </nav>
      <main className="rov-page-main">
        <h2>{page.heading}</h2>
        <div className="rov-page-card">
          {ROWS.map((row) => (
            <div className="rov-page-row" key={row}>
              <i />
              <i />
              <i />
            </div>
          ))}
          <span className="rov-page-button">{page.action}</span>
        </div>
      </main>
    </div>
  );
}
