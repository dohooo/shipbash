"use client";

/**
 * The two layers a phone draws over the workspace (≤760px, `mobile.css`): the
 * rail as a drawer, and the Settings panes as a bottom sheet. Their controls
 * are always in the page and hidden above 760px, so the desktop never sees
 * them.
 *
 * One layer is open at a time, and it belongs to the address it was opened
 * on: leaving that address, by any link or gesture, closes it. The open layer is written on
 * `<html>` (`data-m-drawer`, `data-m-sheet`) because that is where the scroll
 * lock goes, and the drawer and the sheet sit in subtrees that share nothing
 * nearer.
 */
import { usePathname } from "next/navigation";
import { createContext, Suspense, use, useEffect, useState, type ReactNode } from "react";

type Layer = "drawer" | "sheet";

interface MobileLayersValue {
  open: Layer | null;
  show: (layer: Layer) => void;
  close: () => void;
}

const MobileLayersContext = createContext<MobileLayersValue | null>(null);

/** The open layer and the way to change it; null outside the workspace frame. */
export function useMobileLayers(): MobileLayersValue | null {
  return use(MobileLayersContext);
}

/**
 * Tells the layers which address is on screen. It has a boundary of its own
 * because the frame awaits nothing and is prerendered, while the address is
 * known only once a request names it.
 */
function Address({ onChange }: { onChange: (pathname: string) => void }) {
  const pathname = usePathname();
  useEffect(() => {
    onChange(pathname);
  }, [onChange, pathname]);
  return null;
}

export function MobileLayers({ children }: Readonly<{ children: ReactNode }>) {
  const [address, setAddress] = useState<string | null>(null);
  const [shown, setShown] = useState<{ layer: Layer; at: string | null } | null>(null);
  const open = shown?.at === address ? shown.layer : null;
  const close = () => setShown(null);

  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const key = open === "drawer" ? "mDrawer" : "mSheet";
    root.dataset[key] = "open";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShown(null);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      delete root.dataset[key];
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <MobileLayersContext value={{ open, show: (layer) => setShown({ layer, at: address }), close }}>
      {children}
      {/* Pointer-only: Escape and each layer's own close button are the keyboard's way out. */}
      <div className="m-scrim" aria-hidden="true" onClick={close} />
      <Suspense fallback={null}><Address onChange={setAddress} /></Suspense>
    </MobileLayersContext>
  );
}

export function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

/** The header's way into the drawer. */
export function DrawerOpenButton() {
  const layers = useMobileLayers();
  if (!layers) return null;
  return (
    <button
      className="m-menu"
      type="button"
      aria-label="Open navigation"
      aria-controls="primary-navigation"
      aria-expanded={layers.open === "drawer"}
      onClick={() => layers.show("drawer")}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
        <path d="M4 7h16M4 12h16M4 17h16" />
      </svg>
    </button>
  );
}

/** The drawer's own way out, in the switcher's row. */
export function DrawerCloseButton() {
  const layers = useMobileLayers();
  if (!layers) return null;
  return (
    <button className="m-drawer-close" type="button" aria-label="Close navigation" onClick={layers.close}>
      <CloseIcon />
    </button>
  );
}
