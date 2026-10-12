import type { Dispatch, SetStateAction } from "react";

import type { BrowserNavState, MirroredBrowserTab } from "./browser-mockup-chrome";
import type { BrowserStreamMessage } from "./browser-viewport";
import { browserSourceKey } from "./browser-presentation";

/** A dialog the mirrored page raised, as the takeover overlay renders it. */
export interface PageDialogState {
  kind: string;
  message: string;
  defaultPrompt: string;
}

/** A CSS-pixel size, either the page's own or the painted frame's. */
export interface StreamViewport {
  width: number;
  height: number;
}

export type StreamHealth = "connected" | "connecting" | "unavailable";

/**
 * Where each kind of message lands. Everything the live stream can say about
 * the browser it mirrors ends in one of these, so the dispatch below stays a
 * pure function of the message and the pane keeps the state.
 */
interface BrowserStreamSinks {
  setTransportConnected: (connected: boolean) => void;
  setSourceConnected: (connected: boolean, sourceKey: string | null) => void;
  setNavState: (navState: BrowserNavState) => void;
  setControlGranted: (granted: boolean) => void;
  setControlDenied: (reason: string | null) => void;
  setPageDialog: (dialog: PageDialogState | null) => void;
  setDialogPromptText: (text: string) => void;
  setFileChooserOpen: (open: boolean) => void;
  setDownloadNote: (note: string) => void;
  setStreamViewport: Dispatch<SetStateAction<StreamViewport | null>>;
  setCurrentAddress: (address: string) => void;
  setPageTitle: (title: string) => void;
  setFaviconUrl: (faviconUrl: string) => void;
  setMirroredTabs: (tabs: MirroredBrowserTab[]) => void;
  markFramePending: (tabId: string | null, url: string) => void;
}

/** Bounded parse of the runner's nav_state broadcast. */
function navStateFrom(message: BrowserStreamMessage): BrowserNavState {
  return {
    canGoBack: message.canGoBack === true,
    canGoForward: message.canGoForward === true,
    loading: message.loading === true,
  };
}

/**
 * Any non-null object, arrays included. `isRecord` would be narrower here: it
 * turns arrays away.
 */
function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function applyControlState(message: BrowserStreamMessage, sinks: BrowserStreamSinks): void {
  const granted = message.controller === true;
  sinks.setControlGranted(granted);
  sinks.setControlDenied(!granted && typeof message.reason === "string" && message.reason !== "released"
    ? message.reason
    : null);
}

function applyPageDialog(message: BrowserStreamMessage, sinks: BrowserStreamSinks): void {
  sinks.setPageDialog({
    kind: typeof message.kind === "string" ? message.kind : "alert",
    message: typeof message.message === "string" ? message.message : "",
    defaultPrompt: typeof message.defaultPrompt === "string" ? message.defaultPrompt : "",
  });
  sinks.setDialogPromptText(typeof message.defaultPrompt === "string" ? message.defaultPrompt : "");
}

/** The page's own CSS size, which the pointer overlay maps its coordinates through. */
function applyReportedViewport(message: BrowserStreamMessage, sinks: BrowserStreamSinks): void {
  const width = Number(message.viewportWidth);
  const height = Number(message.viewportHeight);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    sinks.setStreamViewport((current) => (
      current?.width === width && current.height === height ? current : { width, height }
    ));
  }
}

function tabFaviconUrl(tab: Record<string, unknown>): string | null {
  for (const key of ["faviconDataUrl", "faviconUrl", "favIconUrl", "favicon"]) {
    const value = tab[key];
    if (typeof value === "string" && value.length <= 24_000 && /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon|ico);base64,/iu.test(value)) return value;
  }
  return null;
}

function downloadNoteFor(message: BrowserStreamMessage): string {
  const name = typeof message.suggestedFilename === "string" && message.suggestedFilename
    ? message.suggestedFilename
    : "a file";
  return `The browser downloaded ${name} inside the sandbox.`;
}

/** The first tab that says it is active, or none if no entry claims it. */
function activeTabOf(tabs: readonly unknown[]): Record<string, unknown> | undefined {
  for (const candidate of tabs) {
    if (isObjectLike(candidate) && candidate.active === true) return candidate;
  }
  return undefined;
}

function applyMirroredTabs(tabs: readonly unknown[], sinks: BrowserStreamSinks): void {
  const activeTab = activeTabOf(tabs);
  if (typeof activeTab?.url === "string") {
    sinks.setCurrentAddress(activeTab.url);
    sinks.markFramePending(typeof activeTab.tabId === "string" ? activeTab.tabId : null, activeTab.url);
  }
  if (typeof activeTab?.title === "string" && activeTab.title.trim()) sinks.setPageTitle(activeTab.title);
  const activeTabFavicon = activeTab ? tabFaviconUrl(activeTab) : null;
  if (activeTabFavicon) sinks.setFaviconUrl(activeTabFavicon);
  sinks.setMirroredTabs(tabs.flatMap((candidate) => {
    if (!isObjectLike(candidate)) return [];
    if (typeof candidate.tabId !== "string") return [];
    return [{
      id: candidate.tabId,
      title: typeof candidate.title === "string" ? candidate.title : "",
      url: typeof candidate.url === "string" ? candidate.url : "",
      active: candidate.active === true,
      faviconUrl: tabFaviconUrl(candidate),
    }];
  }));
}

/**
 * The connection's own messages: gateway health, navigation, the control lease
 * and the dialog / file chooser / download side channels. Returns true when it
 * took the message, which ends the dispatch for that message.
 */
function applyConnectionMessage(message: BrowserStreamMessage, sinks: BrowserStreamSinks): boolean {
  if (message.type === "gateway_status") {
    sinks.setTransportConnected(message.upstream === "connected");
    return true;
  }
  if (message.type === "nav_state") {
    sinks.setNavState(navStateFrom(message));
    return true;
  }
  if (message.type === "control_state") {
    applyControlState(message, sinks);
    return true;
  }
  if (message.type === "page_dialog") {
    applyPageDialog(message, sinks);
    return true;
  }
  if (message.type === "page_dialog_closed") {
    sinks.setPageDialog(null);
    return true;
  }
  if (message.type === "file_chooser") {
    sinks.setFileChooserOpen(true);
    return true;
  }
  if (message.type === "download") {
    sinks.setDownloadNote(downloadNoteFor(message));
    return true;
  }
  return false;
}

/** What the mirrored page reports about itself: its size, address and tabs. */
function applyMirrorMessage(message: BrowserStreamMessage, sinks: BrowserStreamSinks): void {
  if (message.type === "status") {
    sinks.setSourceConnected(message.connected === true, browserSourceKey(message));
    applyReportedViewport(message, sinks);
  }
  if (message.type === "url" && typeof message.url === "string") {
    sinks.setCurrentAddress(message.url);
    sinks.markFramePending(null, message.url);
  }
  if (message.type === "tabs" && Array.isArray(message.tabs)) applyMirroredTabs(message.tabs, sinks);
}

/**
 * One message off the live stream, applied to the pane. The connection's own
 * messages are taken first and end there; anything left is offered to the
 * mirrored page's three reports in turn.
 */
export function applyBrowserStreamMessage(
  message: BrowserStreamMessage,
  sinks: BrowserStreamSinks,
): void {
  if (applyConnectionMessage(message, sinks)) return;
  applyMirrorMessage(message, sinks);
}
