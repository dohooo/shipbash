"use client";

import { ArrowLeft, ArrowRight, Globe, MoreVertical, RotateCw, X } from "lucide-react";

export interface MirroredBrowserTab {
  id: string;
  title: string;
  url: string;
  active: boolean;
  faviconUrl: string | null;
}

/** The real page's navigation state, mirrored from the runner's nav_state. */
export interface BrowserNavState {
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

type BrowserNavAction = "nav_back" | "nav_forward" | "nav_reload" | "nav_stop";

export function BrowserMockupChrome({
  address,
  title,
  faviconUrl,
  onFaviconError,
  tabs = null,
  onSelectTab = null,
  navState = null,
  controlling = false,
  onNav = null,
}: {
  address: string;
  title: string;
  faviconUrl?: string | null;
  onFaviconError?: () => void;
  /**
   * Live mirror of the real browser's tabs. When present, the strip renders
   * one mockup tab per real tab; without it, the single summary tab remains.
   */
  tabs?: MirroredBrowserTab[] | null;
  /** Present only while the user holds takeover control: clicks switch the real tab. */
  onSelectTab?: ((tabId: string) => void) | null;
  /**
   * nav_state mirror from the stream. Absent on surfaces without live
   * navigation (run replays, recordings): the three buttons stay disabled.
   */
  navState?: BrowserNavState | null;
  /** The viewer holds the control lease; navigation may only act then. */
  controlling?: boolean;
  /** Sends one nav_* message over the stream socket, lease-gated runner-side. */
  onNav?: ((action: BrowserNavAction) => void) | null;
}) {
  const mirroredTabs = tabs?.length ? tabs : null;
  return (
    <header className="activity-browser-chrome browser-mockup-chrome">
      <div className="browser-tab-strip">
        <span className="browser-window-controls" aria-hidden="true"><span /><span /><span /></span>
        {mirroredTabs ? mirroredTabs.map((tab) => {
          const label = tab.title.trim() || tabHostname(tab.url) || "New tab";
          // No close affordance: users hold no tab rights in the sandbox
          // browser — only the agent creates and closes tabs.
          return onSelectTab ? (
            <button
              key={tab.id}
              type="button"
              className={`browser-tab${tab.active ? " active" : ""} selectable`}
              aria-pressed={tab.active}
              onClick={() => {
                if (!tab.active) onSelectTab(tab.id);
              }}
            >
              <TabFavicon faviconUrl={tab.faviconUrl} />
              <span className="browser-tab-title">{label}</span>
            </button>
          ) : (
            <div key={tab.id} className={`browser-tab${tab.active ? " active" : ""}`}>
              <TabFavicon faviconUrl={tab.faviconUrl} />
              <span className="browser-tab-title">{label}</span>
            </div>
          );
        }) : (
          <div className="browser-tab active">
            <TabFavicon faviconUrl={faviconUrl ?? null} onError={onFaviconError} />
            <span className="browser-tab-title">{title}</span>
          </div>
        )}
      </div>
      <div className="browser-toolbar">
        <BrowserNavTools navState={navState} controlling={controlling} onNav={onNav} />
        <div className="browser-address">
          <span className="mono">{address}</span>
        </div>
        <MoreVertical className="browser-overflow" aria-hidden="true" />
      </div>
      {navState?.loading ? (
        // The only loading indicator: a 1px progress line under the toolbar.
        // The stage below keeps its last frame — no spinner, no blanking.
        <div className="loadline"><span /></div>
      ) : null}
    </header>
  );
}

function BrowserNavTools({
  navState,
  controlling,
  onNav,
}: {
  navState: BrowserNavState | null;
  controlling: boolean;
  onNav: ((action: BrowserNavAction) => void) | null;
}) {
  // Buttons act only while the viewer holds the lease AND the runner reported
  // real history — the chrome never guesses navigability from the frontend.
  const liveNav = controlling && onNav && navState ? { state: navState, send: onNav } : null;
  return (
    <nav
      className="browser-tools"
      aria-label="Browser controls"
      // Disabled-while-the-agent-drives hover tip; live surfaces only.
      {...(navState && !controlling ? { "data-tip": "Take control to navigate" } : {})}
    >
      <button
        className="browser-tool"
        type="button"
        aria-label="Go back"
        disabled={!liveNav?.state.canGoBack}
        onClick={liveNav ? () => liveNav.send("nav_back") : undefined}
      >
        <ArrowLeft />
      </button>
      <button
        className="browser-tool"
        type="button"
        aria-label="Go forward"
        disabled={!liveNav?.state.canGoForward}
        onClick={liveNav ? () => liveNav.send("nav_forward") : undefined}
      >
        <ArrowRight />
      </button>
      {liveNav?.state.loading ? (
        <button
          className="browser-tool"
          type="button"
          aria-label="Stop loading"
          onClick={() => liveNav.send("nav_stop")}
        >
          <X />
        </button>
      ) : (
        <button
          className="browser-tool"
          type="button"
          aria-label="Reload page"
          disabled={!liveNav}
          onClick={liveNav ? () => liveNav.send("nav_reload") : undefined}
        >
          <RotateCw />
        </button>
      )}
    </nav>
  );
}

function TabFavicon({ faviconUrl, onError }: { faviconUrl: string | null; onError?: (() => void) | undefined }) {
  return (
    <span className="browser-tab-favicon" aria-hidden="true">
      {/* biome-ignore lint/performance/noImgElement: a data: URI favicon mirrored from the sandbox — tabFaviconUrl accepts no other
          scheme — drawn at 11px by CSS, with onError falling back to the globe. */}
      {faviconUrl ? <img src={faviconUrl} alt="" onError={onError} /> : <Globe />}
    </span>
  );
}

function tabHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
