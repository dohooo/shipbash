"use client";

import { type Dispatch, type SetStateAction, useEffect, useState } from "react";

import { fallbackTitleFor } from "./activity-browser-panes";
import type { PaintedBrowserFrame } from "./browser-presentation";
import type { MirroredBrowserTab } from "./browser-mockup-chrome";

/**
 * The page the Activity pane says it is showing: address, title, favicon and
 * tab strip. The stream reports all four as it browses, and the props report
 * them again from the persisted activity, so both write here.
 */
export interface ActivityBrowserMirror {
  currentAddress: string;
  pageTitle: string;
  faviconUrl: string | null;
  mirroredTabs: MirroredBrowserTab[];
  setCurrentAddress: Dispatch<SetStateAction<string>>;
  setPageTitle: Dispatch<SetStateAction<string>>;
  setFaviconUrl: Dispatch<SetStateAction<string | null>>;
  setMirroredTabs: Dispatch<SetStateAction<MirroredBrowserTab[]>>;
  setDisplayedFrame: (frame: PaintedBrowserFrame) => void;
}

/**
 * The mirrored page starts from what the activity recorded and is overwritten
 * by whatever the live stream says next. Fresh props win outright: a pane
 * re-pointed at another activity must not keep the last one's address.
 */
export function useActivityBrowserMirror({ address, reportedTitle, reportedFaviconUrl }: {
  address: string;
  reportedTitle: string | null | undefined;
  reportedFaviconUrl: string | null | undefined;
}): ActivityBrowserMirror {
  const fallbackTitle = fallbackTitleFor(address);
  const [pendingAddress, setCurrentAddress] = useState(address);
  const [pendingTitle, setPageTitle] = useState(reportedTitle?.trim() || fallbackTitle);
  const [faviconUrl, setFaviconUrl] = useState(() => reportedFaviconUrl ?? null);
  const [mirroredTabs, setMirroredTabs] = useState<MirroredBrowserTab[]>([]);
  const [displayedFrame, setDisplayedFrame] = useState<PaintedBrowserFrame | null>(null);
  useEffect(() => {
    setCurrentAddress(address);
    setPageTitle(reportedTitle?.trim() || fallbackTitle);
    setFaviconUrl(reportedFaviconUrl ?? null);
  }, [address, fallbackTitle, reportedFaviconUrl, reportedTitle]);
  return {
    currentAddress: displayedFrame ? displayedFrame.url : pendingAddress,
    pageTitle: displayedFrame ? displayedFrame.title || fallbackTitleFor(displayedFrame.url) : pendingTitle,
    faviconUrl,
    mirroredTabs: displayedFrame?.tabId
      ? mirroredTabs.map((tab) => tab.id === displayedFrame.tabId
        ? { ...tab, active: true, url: displayedFrame.url, title: displayedFrame.title || fallbackTitleFor(displayedFrame.url) }
        : { ...tab, active: false })
      : mirroredTabs,
    setCurrentAddress,
    setPageTitle,
    setFaviconUrl,
    setMirroredTabs,
    setDisplayedFrame,
  };
}
