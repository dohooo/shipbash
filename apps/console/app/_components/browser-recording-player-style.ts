/** The replay player's own stylesheet, injected with the player. */

export const STYLE = `
/* Wherever the player is mounted — the run page's column, a journey's history
   card — its bar, its stage and its strip stack, and the stage takes whatever
   height the host gives it. */
.replay-player { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--color-soft); }
.replay-player > .workbench-body { flex: 1; }
/* The bar is the player's own, the same height on every host: the run page's
   41px row with its content centred. */
.replay-player > .workbench-head { height: 41px; min-height: 41px; padding-block: 0; overflow: hidden; }
/* The cinema starts at the window's width-driven height (video aspect +
   chrome) and never grows past it. A host — or a fullscreen — shorter than
   that shrinks the cinema to fit and the window letterboxes inside it, so the
   whole frame, caption included, is always above the strip. */
.replay-stage { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.replay-unavailable { margin: 0; padding: 24px; color: var(--faint); font: 500 var(--text-xs)/1.4 var(--sans); text-align: center; }
/* One row the cinema's height bounds: the width-sized ghost never stretches it,
   so the window centres in the box the reader sees. */
.qrp-cinema { position: relative; flex: 0 1 auto; min-height: 0; display: grid; grid-template-rows: minmax(0, 1fr); place-items: center; background: #16161a; cursor: pointer; overflow: hidden; }
.qrp-ghost { grid-area: 1 / 1; width: 100%; visibility: hidden; }
.qrp-ghost-header { height: var(--browser-mockup-chrome-height); }
.qrp-window { grid-area: 1 / 1; width: 100%; max-width: 100%; max-height: 100%; display: flex; flex-direction: column; overflow: hidden; }
.qrp-window > * { flex: 0 0 auto; }
.qrp-frame { position: relative; width: 100%; }
.qrp-frame video { display: block; width: 100%; height: 100%; object-fit: fill; }
.qrp-caption { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); width: max-content; max-width: 92%; padding: 6px 12px; border-radius: 6px; background: rgba(10, 10, 12, 0.6); color: #fff; font: 500 13px/1.45 var(--sans); text-align: center; pointer-events: none; z-index: 5; }
.qrp-caption-chapter { display: inline-block; margin-right: 8px; padding: 1px 6px; border-radius: 4px; background: rgba(245, 78, 0, 0.9); font: 600 11px/1.45 var(--mono); letter-spacing: 0.01em; vertical-align: 1px; }
.qrp-ff { position: absolute; top: 10px; right: 10px; padding: 3px 8px; border-radius: 5px; background: rgba(10, 10, 12, 0.66); color: #fff; font: 600 11px/1.4 var(--mono); letter-spacing: 0.02em; pointer-events: none; z-index: 5; }
/* The strip sits under both panes, outside the cinema, and is its own
   inline-size container: the narrow-window rule below resolves against the
   strip's own width. */
.qrp-chrome { flex: 0 0 auto; background: #fff; border-top: 1px solid #ecece6; container-type: inline-size; }
.qrp-timeline { position: relative; height: 28px; cursor: pointer; touch-action: none; }
.qrp-events { position: absolute; top: 3px; left: 0; right: 0; height: 14px; }
.qrp-mark { position: absolute; top: 0; width: 3px; height: 10px; transform: translateX(-50%); border: 0; padding: 0; border-radius: 1px; background: #26261f; opacity: 0.7; cursor: pointer; transition: height 0.1s ease, background 0.1s ease, opacity 0.1s ease; }
.qrp-mark:hover, .qrp-mark:focus-visible { opacity: 1; height: 14px; background: #f54e00; }
.qrp-terminal-mark { height: 14px; background: #f54e00; opacity: 0.5; }
/* A chapter divider crosses the whole scrubber, including the track, so the
   reader sees where the recording changes subject without playing it. */
.qrp-chapter-mark { width: 2px; height: 22px; border-radius: 0; background: #26261f; opacity: 0.3; z-index: 2; }
.qrp-chapter-mark:hover, .qrp-chapter-mark:focus-visible { height: 22px; background: #26261f; opacity: 0.75; }
.qrp-track { position: absolute; left: 0; right: 0; bottom: 4px; height: 5px; background: #ebebe6; overflow: hidden; }
.qrp-static { position: absolute; top: 0; bottom: 0; background: repeating-linear-gradient(-45deg, #d7d7d1 0 3px, #ebebe6 3px 6px); }
.qrp-fill { position: absolute; left: 0; top: 0; bottom: 0; background: #3c3c35; }
.qrp-thumb { position: absolute; bottom: 0.5px; width: 12px; height: 12px; transform: translateX(-50%); border-radius: 999px; background: #f54e00; box-shadow: 0 0 0 2px #fff; z-index: 3; pointer-events: none; }
.qrp-controls { display: flex; align-items: center; gap: 2px; padding: 2px 10px 8px; }
.qrp-button { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: 0; border-radius: 7px; background: transparent; color: #26261f; cursor: pointer; position: relative; transition: background-color 0.15s ease, opacity 0.2s ease, transform 0.12s ease; }
.qrp-button:hover:not(:disabled) { background: #f0f0eb; }
.qrp-button:active:not(:disabled) { transform: scale(0.92); }
.qrp-button:disabled { opacity: 0.32; cursor: default; }
.qrp-button:disabled:hover::after { opacity: 0; }
.qrp-button:focus-visible { outline: 2px solid #26261f; outline-offset: 1px; }
.qrp-button svg { width: 17px; height: 17px; }
.qrp-button .qrp-badge { position: absolute; top: 52%; left: 50%; transform: translate(-50%, -50%); font: 700 6px/1 var(--mono); color: #26261f; pointer-events: none; }
.qrp-time { display: inline-flex; align-items: center; gap: 6px; margin-left: 8px; font: 500 13px/1 var(--mono); color: #b3b3aa; white-space: nowrap; font-variant-numeric: tabular-nums; }
.qrp-time svg { width: 14px; height: 14px; color: #b3b3aa; }
.qrp-spacer { flex: 1; }
.qrp-rate { position: relative; min-width: 38px; height: 26px; margin-right: 4px; border: 0; border-radius: 6px; background: transparent; text-align: center; font: 600 12px/1 var(--mono); color: #26261f; font-variant-numeric: tabular-nums; cursor: pointer; transition: background-color 0.15s ease, transform 0.12s ease; }
.qrp-rate:hover { background: #f0f0eb; }
.qrp-rate:active { transform: scale(0.94); }
.qrp-rate:focus-visible { outline: 2px solid #26261f; outline-offset: 1px; }
.qrp-tip::after { content: attr(data-tip); position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%); padding: 6px 9px; border-radius: 6px; background: #26261f; color: #fff; font: 500 11px/1.2 var(--sans); white-space: nowrap; opacity: 0; pointer-events: none; transition: opacity 0.12s ease 0.15s; z-index: 20; }
.qrp-tip:hover::after, .qrp-tip:focus-visible::after { opacity: 1; }
.qrp-controls .qrp-tip:first-child::after { left: 0; transform: none; }
.qrp-controls .qrp-tip:last-child::after { left: auto; right: 0; transform: none; }
@container (max-width: 390px) { .qrp-rate { display: none; } }
`;
