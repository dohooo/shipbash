import type { ReactNode } from "react";

import { StaticEye } from "../static-eye";
import styles from "./hero-demo.module.css";
import { CUE, easeBack, lerp, span, typed } from "./timeline";

/**
 * The walk as ShipBash's console shows it, cut down to the part that tells the
 * story: the workbench with its Browser and Terminal tabs and the live view
 * under them, styled after apps/console (tab control, status pill, the
 * browser mockup chrome, the sandbox terminal's colours).
 */

interface TermLine {
  at: number;
  kind: "command" | "output" | "studied";
  text: string;
  /** Seconds the command takes to type. */
  typing?: number;
  stamp?: string;
  /** Inside the marker that puts the two timestamps side by side. */
  marked?: boolean;
}

const [onAt, onOut, execAt, runningAt, endedAt, offAt] = CUE.termLines;

const LINES: readonly TermLine[] = [
  { at: onAt, kind: "command", text: "acme knowledge incognito on codex", typing: 0.45 },
  { at: onOut, kind: "output", text: "Codex is incognito: its sessions will not be studied" },
  { at: execAt, kind: "command", text: 'codex exec "tidy the release notes"', typing: 0.5 },
  { at: runningAt, kind: "output", text: "session a1f3 running…" },
  { at: endedAt, kind: "output", text: "session a1f3 ended", stamp: "15:04:12.004", marked: true },
  { at: offAt, kind: "command", text: "acme knowledge incognito off codex", typing: 0.3, stamp: "15:04:12.019", marked: true },
  { at: CUE.sync, kind: "command", text: "acme knowledge sync --status", typing: 0.4 },
  { at: CUE.studied, kind: "studied", text: "studied   codex/a1f3" },
];

function Prompt() {
  return (
    <span>
      <span className={styles.termUser}>agent@sandbox</span>:<span className={styles.termDir}>~/work</span>${" "}
    </span>
  );
}

function Line({ line, t }: { line: TermLine; t: number }) {
  const typing = line.typing ?? 0;
  const text = line.kind === "command" ? typed(line.text, t, line.at, line.at + typing) : line.text;
  const done = t >= line.at + typing;
  const kind = line.kind === "studied" ? styles.termStudied : line.kind === "output" ? styles.termOutput : undefined;
  return (
    <div className={`${styles.termLine} ${kind ?? ""}`}>
      {line.kind === "command" ? <Prompt /> : null}
      {text}
      {line.kind === "command" && !done ? <span className={styles.termCaret} /> : null}
      {line.stamp && done ? <span className={styles.termStamp}>{line.stamp}</span> : null}
    </div>
  );
}

/** The sandbox terminal, read-only as the console shows it, with the two timestamps marked while they matter. */
function Terminal({ t }: { t: number }) {
  const shown = LINES.filter((line) => t >= line.at);
  const plain = (line: TermLine) => <Line key={line.text} line={line} t={t} />;
  const marked = shown.filter((line) => line.marked);
  const highlight = t < CUE.browserClick.at;
  const last = shown[shown.length - 1];
  const idle = last === undefined || t >= last.at + (last.typing ?? 0) + 0.2;
  return (
    <div className={styles.term} data-target="terminal">
      {shown.filter((line) => line.at < endedAt).map(plain)}
      {marked.length > 0 ? (
        <div className={highlight ? styles.marker : undefined} data-target="stamps">
          {marked.map(plain)}
          {highlight && t >= CUE.gap ? (
            <span className={styles.markerBadge} style={{ transform: `rotate(-4deg) scale(${easeBack(span(t, CUE.gap, CUE.gap + 0.3))})` }}>+15 ms</span>
          ) : null}
        </div>
      ) : null}
      {shown.filter((line) => line.at > offAt).map(plain)}
      {idle ? <div className={styles.termLine}><Prompt /><span className={styles.termCaret} /></div> : null}
    </div>
  );
}

/** A browser window as the console's mockup chrome draws it: traffic lights, one tab, the address bar. */
function BrowserChrome({ title, address, icon }: { title: string; address: ReactNode; icon: "eye" | "globe" }) {
  return (
    <div className={styles.chrome}>
      <div className={styles.chromeTabs}>
        <span className={styles.lights}><i /><i /><i /></span>
        <span className={styles.chromeTab}>
          {icon === "eye" ? <span className={styles.favicon}><StaticEye compact /></span> : <span className={styles.globe}>◍</span>}
          {title}
        </span>
      </div>
      <div className={styles.chromeBar}>
        <span className={styles.chromeNav}>←&nbsp;→&nbsp;↻</span>
        <span className={styles.address}>{address}</span>
        <span>⋮</span>
      </div>
    </div>
  );
}

const ROWS = [
  { id: "a1f3 · 15:04", agent: "codex", status: "Studied", target: "rowA" },
  { id: "9e01 · 14:51", agent: "codex", status: "Skipped" },
  { id: "77d4 · 14:20", agent: "claude", status: "Studied" },
] as const;

/** The product under test, Acme's web app on its Sessions page, inside the sandbox browser. */
export function SandboxBrowser({ hit }: { hit: boolean }) {
  return (
    <div className={styles.sandbox}>
      <BrowserChrome title="Sessions · Acme" icon="globe" address={<>app.acme.example<span className={styles.dim}>/sessions</span></>} />
      <div className={styles.acme}>
        <nav className={styles.acmeNav}>
          <b><i />Acme</b>
          <span>Library</span>
          <span className={styles.acmeNavActive}>Sessions</span>
          <span>Agents</span>
          <span>Settings</span>
        </nav>
        <div className={styles.acmeMain}>
          <h5>Sessions</h5>
          <div className={styles.sessionTable}>
            <div className={styles.sessionHead}><span>Session</span><span>Agent</span><span>Status</span></div>
            {ROWS.map((row) => (
              <div key={row.id} className={`${styles.sessionRow} ${hit && "target" in row ? styles.sessionRowHit : ""}`}>
                <span>{row.id}</span>
                <span>{row.agent}</span>
                <span className={row.status === "Studied" ? styles.badgeStudied : styles.badgeSkipped} data-target={"target" in row ? row.target : undefined}>{row.status}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function activeTab(t: number): "browser" | "terminal" {
  if (t >= CUE.backClick.at) return "terminal";
  if (t >= CUE.browserClick.at) return "browser";
  return t >= CUE.terminalClick.at ? "terminal" : "browser";
}

/** The console's presence eye: it fades out of the tab it leaves and into the one it lands on. */
function Eye({ t }: { t: number }) {
  const clicks = [CUE.terminalClick.at, CUE.browserClick.at, CUE.backClick.at];
  const near = clicks.map((at) => Math.abs(t - at)).reduce((a, b) => Math.min(a, b), 1);
  return <span className={styles.eye} style={{ opacity: lerp(0, 1, Math.min(1, near / 0.15)) }}><StaticEye compact /></span>;
}

function Tab({ name, label, t }: { name: "browser" | "terminal"; label: string; t: number }) {
  const on = activeTab(t) === name;
  return (
    <span className={`${styles.tab} ${on ? styles.tabOn : ""}`} data-target={`tab-${name}`}>
      {on ? <Eye t={t} /> : null}
      {label}
    </span>
  );
}

/** The verdict lands like a rubber stamp over the workbench. */
function Stamp({ t }: { t: number }) {
  if (t < CUE.stamp) return null;
  const land = easeBack(span(t, CUE.stamp, CUE.stamp + 0.28));
  return <div className={styles.stamp} style={{ opacity: Math.min(1, land * 2), transform: `rotate(-8deg) scale(${lerp(1.7, 1, land)})` }}>Reproduced</div>;
}

/** The ShipBash window the walk link opens: the console's workbench, Browser and Terminal tabs over the live view. */
export function WalkWindow({ t }: { t: number }) {
  const finished = t >= CUE.finished;
  return (
    <div className={styles.walkWindow}>
      <BrowserChrome title="Exploring · ShipBash" icon="eye" address={<>app.shipbash.dev<span className={styles.dim}>/acme/acme-cli/activities/713a3e5f</span></>} />
      <div className={styles.walkStage}>
        <section className={styles.workbench} data-target="workbench">
          <header className={styles.workbenchHead}>
            <span className={styles.tabs}>
              <Tab name="browser" label="Browser" t={t} />
              <Tab name="terminal" label="Terminal" t={t} />
            </span>
            <span className={`${styles.pill} ${finished ? styles.pillDone : styles.pillRunning}`}>{finished ? "Finished" : "Running"}</span>
          </header>
          <div className={styles.workbenchBody}>
            {activeTab(t) === "terminal" ? <Terminal t={t} /> : <SandboxBrowser hit={t >= CUE.rowHit} />}
          </div>
        </section>
        <Stamp t={t} />
      </div>
    </div>
  );
}
