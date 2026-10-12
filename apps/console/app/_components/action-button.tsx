import type { ComponentProps } from "react";

/**
 * A button that sends a request — starts a run, cancels one, takes the
 * browser — drawn as its own form's submit button, with what it does as the
 * form's action.
 *
 * The page is on screen before its code has run, and a press on a plain
 * button's `onClick` in that stretch is lost: nothing is listening yet. A
 * form's submit is not. With a function as the action, React's server HTML
 * carries a script that holds each submit from the first paint, and React
 * replays it once the form is hydrated (React 19 form actions). So a press is
 * kept from the moment the button can be seen; a slow network or a slow phone
 * makes that stretch last seconds, and every release starts it afresh.
 *
 * The replay does not know `disabled`: before the page's code runs nothing
 * sets it, so every press is replayed, and the action must be idempotent. The
 * action runs in a transition: one that returns a promise keeps it pending
 * until the promise settles, and a rejection reaches the route's error
 * boundary (`error.tsx`), so an action that can fail handles its own failure,
 * as a mutation's `mutate` does.
 *
 * The form lays nothing out (`.action-form`), so the button sits in its row as
 * a plain one would; `aria-*` and `data-*` attributes pass through to it. What
 * moves the reader elsewhere is a Link, not this.
 */
export function ActionButton({ action, ...button }: Readonly<
  Pick<ComponentProps<"button">, "className" | "id" | "disabled" | "hidden" | "children"> & { action: () => void }
>) {
  return (
    <form className="action-form" action={action}>
      <button {...button} type="submit" />
    </form>
  );
}
