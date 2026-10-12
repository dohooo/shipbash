import Image from "next/image";
import type { ReactNode } from "react";

import { StaticEye } from "../static-eye";
import styles from "./hero-demo.module.css";

type Speaker = "maya" | "raj" | "lena" | "shipbash" | "claude";

const NAMES: Record<Speaker, string> = { maya: "Maya", raj: "Raj", lena: "Lena", shipbash: "ShipBash", claude: "Claude" };

function Avatar({ who }: { who: Speaker }) {
  if (who === "shipbash") {
    return <span className={`${styles.avatar} ${styles.avatarApp}`}><StaticEye compact /></span>;
  }
  return (
    <span className={`${styles.avatar} ${styles[`avatar_${who}`]}`}>
      <Image src={`/hero-demo/${who}.svg`} alt="" width={40} height={40} />
    </span>
  );
}

/** A Slack message: avatar, name, the APP tag for bots, time, and its body. */
export function Message({ who, time, target, children }: { who: Speaker; time: string; target?: string | undefined; children: ReactNode }) {
  const bot = who === "shipbash" || who === "claude";
  return (
    <div className={styles.message} data-target={target}>
      <Avatar who={who} />
      <div className={styles.messageBody}>
        <div className={styles.messageHead}>
          <b>{NAMES[who]}</b>
          {bot ? <span className={styles.appTag}>APP</span> : null}
          <span className={styles.time}>{time}</span>
        </div>
        {children}
      </div>
    </div>
  );
}

/** A feed row that grows open from nothing as `p` goes 0 → 1, so the feed scrolls instead of jumping. */
export function Grow({ p, children }: { p: number; children: ReactNode }) {
  if (p <= 0) return null;
  return (
    <div className={styles.grow} style={{ gridTemplateRows: `${p}fr`, opacity: Math.min(1, p * 1.6) }}>
      <div className={styles.growInner}>{children}</div>
    </div>
  );
}

export interface Run {
  text: string;
  tone?: "bold" | "bad" | "good" | "mention" | "code" | "italic";
}

const TONE: Record<NonNullable<Run["tone"]>, string | undefined> = {
  bold: styles.bold,
  bad: styles.markBad,
  good: styles.markGood,
  mention: styles.mention,
  code: styles.inlineCode,
  italic: styles.italic,
};

/** Rich text that streams in: the first `p` of its characters, with a caret while it is still arriving. */
export function Stream({ runs, p }: { runs: readonly Run[]; p: number }) {
  const total = runs.reduce((sum, run) => sum + run.text.length, 0);
  let left = Math.round(total * p);
  const shown = runs.flatMap((run) => {
    if (left <= 0) return [];
    const text = run.text.slice(0, left);
    left -= text.length;
    return [<span key={run.text} className={run.tone ? TONE[run.tone] : undefined}>{text}</span>];
  });
  return (
    <span>
      {shown}
      {p > 0 && p < 1 ? <span className={styles.caret} /> : null}
    </span>
  );
}

export function Separator({ label }: { label: string }) {
  return <div className={styles.separator}><span>{label}</span></div>;
}

export type TodoState = "queued" | "working" | "done";

/** One line of ShipBash's to-do list: ○ queued, ✱ at it (bold, with the step it is on), ✓ done. */
export function TodoLine({ state, title, step, target }: { state: TodoState; title: string; step?: string | undefined; target?: string | undefined }) {
  const glyph = state === "queued" ? "○" : state === "working" ? "✱" : "✓";
  const subject = (
    <>
      Walk: <span className={styles.link} data-target={target}>{title}</span>
    </>
  );
  return (
    <div className={`${styles.todo} ${styles[`todo_${state}`]}`}>
      <span className={styles.todoGlyph}>{glyph}</span>
      <span>
        {state === "working" ? <b>{subject}</b> : subject}
        {state === "queued" ? <span className={styles.todoDetail}> — starting</span> : null}
        {state === "working" && step ? <span key={step} className={`${styles.todoDetail} ${styles.todoStep}`}> — {step}</span> : null}
      </span>
    </div>
  );
}

export function TodoCaption({ time, target }: { time: string; target?: string | undefined }) {
  return <div className={styles.todoCaption}>to-dos as of {time} · <span className={styles.link} data-target={target}>Open in ShipBash</span></div>;
}
