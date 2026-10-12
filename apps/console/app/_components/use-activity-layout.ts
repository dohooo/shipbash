"use client";

import type { ActivityKind } from "@shipbash/contracts/database-contract-types";
import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";

import {
  type ActivityLayout,
  documentActivityLayouts,
  type StoredActivityLayouts,
  writeActivityLayout,
} from "../_lib/activity-layout";

/**
 * The Activity page's two layouts: the stage alone, or the stage beside its
 * conversation. A walk opens on the stage — a link to one, mostly from Slack,
 * is a link to what happened — and every other kind beside its conversation,
 * which a Discovery is talked through. Switching remembers the reader's choice
 * for that kind in a cookie, so the kind only decides until they choose.
 */
function kindLayout(kind: ActivityKind | undefined): ActivityLayout {
  return kind === "walk" ? "stage" : "split";
}

/**
 * Nothing notifies a page of a choice made elsewhere: a tab's layout changes
 * only by its reader's own switch, and its next render reads the cookie anyway.
 */
const subscribeToNothing = () => () => {};

export interface ActivityLayoutState {
  layout: ActivityLayout;
  /** Whether the reader has switched on this page: only their own switch animates. */
  layoutSwitched: boolean;
  chooseLayout: (next: ActivityLayout) => void;
}

/**
 * The layout of an Activity of `kind`, unknown until the Activity has loaded;
 * ⌘. or Ctrl+. toggles it. `serverStored` is what the request's cookies held
 * (the route reads them), so the server's frame and hydration draw the
 * reader's layout; after that the browser reads the cookie itself, which a
 * page drawn from the router's cache or shown again also does.
 */
export function useActivityLayout(kind: ActivityKind | undefined, serverStored: StoredActivityLayouts): ActivityLayoutState {
  // The reader's choice on this page, over the one stored for the kind, over
  // the kind's own.
  const [choice, setChoice] = useState<ActivityLayout | null>(null);
  const stored = useSyncExternalStore(
    subscribeToNothing,
    () => (kind ? documentActivityLayouts()[kind] ?? null : null),
    () => (kind ? serverStored[kind] ?? null : null),
  );
  const layout = choice ?? stored ?? kindLayout(kind);
  const chooseLayout = (next: ActivityLayout) => {
    if (next === layout) return;
    setChoice(next);
    if (!kind) return;
    writeActivityLayout(kind, next);
  };
  const toggle = useEffectEvent(() => chooseLayout(layout === "split" ? "stage" : "split"));
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== ".") return;
      event.preventDefault();
      toggle();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  return { layout, layoutSwitched: choice !== null, chooseLayout };
}
