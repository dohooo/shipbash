import { PageTitle, SectionLoading } from "./shell";

/**
 * What a workspace page draws while its server reads are in flight (the
 * `fallback` a page gives WorkspacePage): the page's own frame and heading,
 * and the shimmer in the shape of what will fill it (see SectionLoading). It
 * is the one placeholder a page has, and it renders before the workspace is
 * known, so it names no team or product; a line that will carry one is held
 * open instead, so the page replaces the placeholder in place.
 */
export function PageSkeleton({ className = "page", title, titleHidden = false, eyebrow = false, body, shape, rows }: {
  className?: string;
  /** The page's heading, when it has one that does not depend on data. */
  title?: string;
  titleHidden?: boolean;
  /** The page's eyebrow names the team: hold its line. */
  eyebrow?: boolean;
  body?: string;
  shape?: "lines" | "rows" | "record";
  rows?: number;
}) {
  return (
    <div className={className}>
      {title ? (
        // A no-break space keeps the eyebrow's line the height the name will have.
        <PageTitle eyebrow={eyebrow ? "\u00a0" : undefined} title={title} titleHidden={titleHidden} body={body} />
      ) : null}
      <SectionLoading shape={shape} rows={rows} />
    </div>
  );
}
