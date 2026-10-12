import { BrandEye } from "./brand-eye";

/**
 * The browser stage with nothing painted: brand paper, the static brand eye, a
 * title and one line. At rest it is the shared empty state of every reused
 * browser frame — nothing is running or connecting behind it, so there is no
 * motion. `working` is the same stage while a browser is genuinely being
 * opened (or a finished run's last picture kept): only the title takes the
 * shine, so rest and work read as one picture told apart by that one line.
 * The reconnect banner (`.browser-stream-health`) is different again: a
 * painted frame whose socket wobbled keeps its frame under a slim pill.
 *
 * The copy is the caller's, because the reason a frame is empty changes with
 * the surface: nothing asked for a browser, a sandbox is waking, a finished
 * run captured no picture. It sits inside a `position: relative`
 * `.browser-frame` and is click-through, so a stream that arrives paints
 * straight over it.
 */
export function BrowserIdlePlaceholder({
  title = "Nothing open yet",
  copy,
  working = false,
  covered = false,
}: {
  title?: string | undefined;
  copy: string | null;
  working?: boolean;
  /** Under a picture that speaks for the stage once it shows, so it announces nothing. */
  covered?: boolean;
}) {
  return (
    <div
      className={working ? "browser-idle brand-paper working" : "browser-idle brand-paper"}
      role="status"
      aria-hidden={covered || undefined}
    >
      <div className="idle-char"><BrandEye /></div>
      <div className="idle-copy">
        <strong>{title}</strong>
        {copy === null ? null : <p>{copy}</p>}
      </div>
    </div>
  );
}
