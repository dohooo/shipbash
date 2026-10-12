import Image from "next/image";
import type { ReactNode } from "react";

import { StaticEye } from "../static-eye";
import styles from "./hero-demo.module.css";
import { Grow, Message, Separator, Stream, TodoCaption, TodoLine, type Run, type TodoState } from "./slack-parts";
import { Recording } from "./recording";
import { CUE, span, typed } from "./timeline";

const ANSWER: readonly Run[] = [
  { text: "Not guaranteed.", tone: "bold" },
  { text: " acme v2.4.0 checks incognito when sync runs, not when the session ends, so that session can still be studied." },
];
const REPORT: readonly Run[] = [
  { text: "Reproduced on v2.4.0:", tone: "bad" },
  { text: " incognito went off " },
  { text: "15 ms", tone: "bold" },
  { text: " after session A ended. Sync later read A’s transcript and marked it " },
  { text: "studied", tone: "italic" },
  { text: "." },
];
const FIXED: readonly Run[] = [
  { text: "Fixed on v2.4.1:", tone: "good" },
  { text: " with incognito off right away, session A stays unstudied; new session B is studied as expected." },
];
const BASH = "bash it and show me";
const STEPS = ["Turning incognito on for codex", "Running session A", "Ending session A, then turning incognito off within milliseconds"];
const WALK = "Turn incognito off right after a session ends";

/** How long a row takes to grow open in the feed. */
const OPEN = 0.35;

function grows(t: number, at: number, node: ReactNode, key: string) {
  return { key, p: span(t, at, at + OPEN), node };
}

function walkState(t: number): { state: TodoState; step: string | undefined } {
  if (t >= CUE.walkDone) return { state: "done", step: undefined };
  if (t < CUE.walkRunning) return { state: "queued", step: undefined };
  const index = CUE.steps.filter((at) => t >= at).length - 1;
  return { state: "working", step: STEPS[Math.max(0, index)] };
}

function retestState(t: number): TodoState {
  if (t >= CUE.retest[2]) return "done";
  return t >= CUE.retest[1] ? "working" : "queued";
}

function firstExchange(t: number) {
  const walk = walkState(t);
  return [
    grows(t, -1, <Message who="raj" time="2:31 PM">acme v2.4.0 is out: per-agent incognito 🎉</Message>, "raj"),
    grows(t, -1, <Message who="lena" time="2:33 PM">nice, turning it on for codex now</Message>, "lena"),
    grows(t, CUE.maya1, <Message who="maya" time="2:47 PM">If I turn incognito off right after a session ends, does that session stay unlearned?</Message>, "maya1"),
    grows(t, CUE.answerTyping, (
      <Message who="shipbash" time="2:47 PM" target="answer">
        {t < CUE.answer[0] ? <span className={styles.typingDots}><i /><i /><i /></span> : <Stream runs={ANSWER} p={span(t, CUE.answer[0], CUE.answer[1])} />}
      </Message>
    ), "answer"),
    grows(t, CUE.bashSent, <Message who="maya" time="2:48 PM">{BASH}</Message>, "bash"),
    grows(t, CUE.walkQueued, (
      <Message who="shipbash" time="2:48 PM" target="walk">
        Started the immediate-off test: finish a session, turn incognito off right away, then check whether Acme studies it.
        <TodoLine state={walk.state} title={WALK} step={walk.step} />
        <TodoCaption time={walk.state === "done" ? "3:07 PM" : "2:48 PM"} target="openLink" />
      </Message>
    ), "walk"),
  ];
}

function evidence(t: number) {
  return [
    grows(t, CUE.laterSep, <Separator label="19 min later" />, "later"),
    grows(t, CUE.report[0], (
      <Message who="shipbash" time="3:07 PM" target="report"><Stream runs={REPORT} p={span(t, CUE.report[0], CUE.report[1])} /></Message>
    ), "report"),
    grows(t, CUE.video, (
      <Message who="shipbash" time="3:07 PM" target="video">
        <div className={styles.context}>Screen recording · <span className={styles.link}>{WALK}</span></div>
        <Recording />
      </Message>
    ), "video"),
    grows(t, CUE.handoff, (
      <Message who="shipbash" time="3:07 PM" target="handoff">
        Hand off to agent:
        <div className={styles.codeBlock}>
          <span>npx shipbash evidence 713a3e5f</span>
          <span className={styles.copy} data-target="copy">{t >= CUE.copyClick.at ? "Copied" : "Copy"}</span>
        </div>
      </Message>
    ), "handoff"),
  ];
}

function fixAndRetest(t: number) {
  const ticks = ["Confirmed on main: sync only checks the current incognito state", "Opened acme-cli #275 · CI green", "Merged · released v2.4.1"];
  return [
    grows(t, CUE.morningSep, <Separator label="Next morning" />, "morning"),
    grows(t, CUE.mayaClaude, <Message who="maya" time="9:12 AM"><span className={styles.mention}>@Claude</span> verify on the latest codebase, smallest fix PR if it’s real</Message>, "toClaude"),
    grows(t, CUE.claudeTicks[0], (
      <Message who="claude" time="9:13 AM" target="claude">
        {ticks.map((tick, index) => (t >= (CUE.claudeTicks[index] ?? Number.POSITIVE_INFINITY) ? <div key={tick} className={styles.tick}><span>✓</span>{tick}</div> : null))}
      </Message>
    ), "claude"),
    grows(t, CUE.mayaRebash, <Message who="maya" time="9:41 AM"><span className={styles.mention}>@ShipBash</span> fix merged, re-bash the latest cli</Message>, "rebash"),
    grows(t, CUE.retest[0], (
      <Message who="shipbash" time="9:41 AM">
        Started the re-test on v2.4.1.
        <TodoLine state={retestState(t)} title="Re-test the immediate-off fix" step="Turning incognito off right after session A ends" />
        <TodoCaption time={t >= CUE.retest[2] ? "9:58 AM" : "9:41 AM"} />
      </Message>
    ), "retest"),
    grows(t, CUE.fixed[0], (
      <Message who="shipbash" time="9:58 AM" target="fixed">
        <Stream runs={FIXED} p={span(t, CUE.fixed[0], CUE.fixed[1])} />
        {t >= CUE.kept ? (
          <div className={styles.kept} data-target="keep">✓ Added to Suite · Acme CLI essentials · runs nightly</div>
        ) : t >= CUE.ask ? (
          <div className={styles.ask}>Keep this as a regression? <span className={styles.buttonPrimary} data-target="keep">Keep</span><span className={styles.button}>Not now</span></div>
        ) : null}
      </Message>
    ), "fixed"),
  ];
}

function Composer({ t }: { t: number }) {
  const typing = t >= CUE.composer[0] && t < CUE.bashSent;
  return (
    <div className={`${styles.composer} ${typing ? styles.composerTyping : ""}`} data-target="composer">
      {typing ? <>{typed(BASH, t, CUE.composer[0], CUE.composer[1])}<span className={styles.caret} /></> : "Reply…"}
    </div>
  );
}

export function SlackScene({ t }: { t: number }) {
  const rows = [...firstExchange(t), ...evidence(t), ...fixAndRetest(t)];
  return (
    <div className={styles.slack}>
      <aside className={styles.slackSide}>
        <div className={styles.workspace}>Acme</div>
        <div className={styles.sideLabel}>Channels</div>
        <div className={styles.channel}># general</div>
        <div className={`${styles.channel} ${styles.channelActive}`}># acme-cli</div>
        <div className={styles.channel}># releases</div>
        <div className={styles.sideLabel}>Apps</div>
        <div className={styles.channel}><span className={styles.appIcon}><StaticEye compact /></span>ShipBash</div>
        <div className={styles.channel}><Image className={styles.appIcon} src="/hero-demo/claude.svg" alt="" width={18} height={18} />Claude</div>
      </aside>
      <main className={styles.slackMain}>
        <div className={styles.slackHead}><b># acme-cli</b><span>releases, bugs and questions</span></div>
        <div className={styles.feed}>
          {rows.map((row) => <Grow key={row.key} p={row.p}>{row.node}</Grow>)}
        </div>
        <Composer t={t} />
      </main>
    </div>
  );
}
