"use client";

import { BrowserIdlePlaceholder } from "./browser-idle-placeholder";
import { BrowserMockupChrome } from "./browser-mockup-chrome";
import { TakeoverVeil } from "./takeover-veil";
import type { useNoVncControl } from "./use-novnc-control";

export function TakeoverWorkbench({
  host,
  address,
  viewerUrl,
  viewer,
  phase,
  snapshot,
  pending,
  errorMessage,
  onCancel,
  onHandback,
  onRetry,
}: {
  host: string | null;
  address: string;
  viewerUrl: string | null;
  viewer: ReturnType<typeof useNoVncControl>;
  phase: "claiming" | "controlling" | "releasing" | "error";
  snapshot: string | null;
  pending: boolean;
  errorMessage: string | null;
  onCancel: () => void;
  onHandback: () => void;
  onRetry: () => void;
}) {
  return (
    <section className="workbench" aria-label="Takeover workspace">
      <header className="workbench-head">
        <fieldset className="activity-filters" aria-label="Session view">
          <button type="button" aria-pressed="true">
            Browser
          </button>
        </fieldset>
        <span className="workbench-status">
          <span className={`status-pill ${phase === "controlling" ? "warning" : "neutral"}`}>
            <span className="dot warning" aria-hidden="true" />
            {phase === "controlling" ? "Human control" : "Browser handoff"}
          </span>
        </span>
      </header>
      <div className="workbench-body" data-tab="browser">
        <section
          className="activity-browser browser-mockup"
          aria-label="Browser under human control"
        >
          <BrowserMockupChrome
            address={address}
            title={host ? `Sign in · ${host}` : "Sign in"}
          />
          <div className="browser-stage">
            {/* The viewer container is still starting: the working placeholder
                stands in until it answers — a browser is genuinely being
                opened here, so the title shines. */}
            <TakeoverBrowserFrame viewerUrl={viewerUrl} viewer={viewer} phase={phase}
              snapshot={snapshot} />
          </div>
        </section>
      </div>
      <footer className="workbench-foot">
        {errorMessage ? (
          <p className="inline-error" role="alert">
            {errorMessage}
          </p>
        ) : null}
        <div className="workbench-actions">
          {phase === "error" ? <button className="button" type="button" onClick={onRetry}>Retry</button> : null}
          {phase === "error" ? <button className="button" type="button" onClick={onCancel}>Cancel takeover</button> : null}
          <button
            className="button primary takeover-toggle"
            type="button"
            data-takeover-phase={phase}
            aria-busy={phase === "claiming" || phase === "releasing"}
            aria-disabled={phase !== "controlling"}
            onClick={onHandback}
          >
            <span className="takeover-toggle-label">{phase === "claiming" ? "Getting the keys…"
              : pending ? "Handing back…" : "I’m done"}</span>
          </button>
        </div>
      </footer>
    </section>
  );
}

function TakeoverBrowserFrame({ viewerUrl, viewer, phase, snapshot }: {
  viewerUrl: string | null;
  viewer: ReturnType<typeof useNoVncControl>;
  phase: "claiming" | "controlling" | "releasing" | "error";
  snapshot: string | null;
}) {
  return (
            <div className="browser-frame" data-takeover-active={String(phase === "controlling")}>
              {!viewerUrl || (phase === "claiming" && !snapshot) ? (
                <BrowserIdlePlaceholder working title="Connecting browser…" copy="The private sign-in browser is starting." />
              ) : null}
              <iframe
                className="browser-auth-viewer"
                id="takeover-auth-viewer"
                title="ShipBash sign-in browser"
                allow="clipboard-read; clipboard-write"
                referrerPolicy="no-referrer"
                sandbox="allow-downloads allow-forms allow-modals allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
                ref={viewer.frameRef}
                data-ready={String(phase === "controlling")}
                aria-hidden={phase !== "controlling"}
                tabIndex={phase === "controlling" ? 0 : -1}
                inert={phase !== "controlling"}
                style={{ visibility: phase === "controlling" ? "visible" : "hidden",
                  opacity: phase === "controlling" ? 1 : 0, pointerEvents: phase === "controlling" ? "auto" : "none" }}
              />
              {snapshot ? (
                // biome-ignore lint/performance/noImgElement: ephemeral in-memory JPEG.
                <img className="stage-picture takeover-snapshot" src={snapshot} alt="Browser at handback" />
              ) : null}
              <TakeoverVeil active={phase === "claiming" || phase === "releasing"} />
            </div>
  );
}
