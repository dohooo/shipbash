"use client";

import {
  AlignLeft,
  ArrowUpRight,
  BookOpen,
  Box,
  ChevronRight,
  Clock,
  FileText,
  Globe,
  HelpCircle,
  Keyboard,
  Lock,
  MousePointerClick,
  RotateCw,
  Route,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { useState } from "react";

import type { ToolCallPart } from "../../_lib/conversation-parts";

type ToolClass = ToolCallPart["toolClass"];
type IconComponent = typeof Globe;

/** Group identity per tool class: display name, head icon, and how its count reads. */
const groups: Record<ToolClass, { name: string; icon: IconComponent; counted: (count: number) => string }> = {
  browser: { name: "Browser", icon: Globe, counted: actionCount },
  read: { name: "Read", icon: AlignLeft, counted: actionCount },
  knowledge: { name: "Knowledge", icon: BookOpen, counted: (count) => `${String(count)} recorded` },
  auth: { name: "Auth", icon: Lock, counted: (count) => (count === 1 ? "1 request" : `${String(count)} requests`) },
  terminal: { name: "Terminal", icon: SquareTerminal, counted: actionCount },
};

function actionCount(count: number): string {
  return count === 1 ? "1 action" : `${String(count)} actions`;
}

/** Row icons keyed by verb — knowledge rows key on their kind instead. */
const verbIcons: Record<string, IconComponent> = {
  open: ArrowUpRight,
  click: MousePointerClick,
  type: Keyboard,
  wait: Clock,
  reload: RotateCw,
  read: AlignLeft,
  page: FileText,
  path: Route,
  decision: Box,
  qa: HelpCircle,
  environment: Wrench,
  ask: Lock,
};

/** Durations read like the rows they annotate: 820ms below a second, 18.4s above. */
function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${String(ms)}ms`;
}

function bucketByClass(parts: readonly ToolCallPart[]): [ToolClass, ToolCallPart[]][] {
  const buckets = new Map<ToolClass, ToolCallPart[]>();
  for (const part of parts) {
    const bucket = buckets.get(part.toolClass);
    if (bucket) bucket.push(part);
    else buckets.set(part.toolClass, [part]);
  }
  return [...buckets.entries()];
}

/** The row's right-hand meta: duration for actions, entry ref for knowledge. */
function rowMeta(part: ToolCallPart): string {
  if (part.toolClass === "knowledge") return part.entryId ? `#${part.entryId.slice(-3)}` : "—";
  return part.ms > 0 ? duration(part.ms) : "—";
}

/**
 * Every tool call is the same row: `verb · content` as one flowing line, the
 * meta on the right, and — when the part carries a detail (a knowledge body,
 * an auth request's full text) — the row opens in place. A row with no
 * content is just its verb, never a dangling separator.
 */
function Row({ part }: { part: ToolCallPart }) {
  const [open, setOpen] = useState(false);
  const Icon = verbIcons[part.verb] ?? (part.toolClass === "knowledge" ? FileText : AlignLeft);
  const line = (
    <>
      <Icon className="x-ico" aria-hidden="true" />
      <span className="x-kt">
        <b>{part.verb}</b>
        {part.target ? <> · {part.target}</> : null}
      </span>
      <i>{rowMeta(part)}</i>
    </>
  );
  if (!part.detail) {
    return <div className="x-row" data-state={part.state === "fail" ? "fail" : undefined}>{line}</div>;
  }
  return (
    <div className="x-item" data-open={open ? "true" : undefined}>
      <button className="x-row" type="button" aria-expanded={open} onClick={() => { setOpen((was) => !was); }}>
        {line}
      </button>
      <div className="x-detail"><p>{part.detail}</p></div>
    </div>
  );
}

/**
 * One class of tool calls, folding on its own — the reader asks "what did the
 * browser do", not "what was step 7". Rows stay mounted while folded so an
 * open detail survives the group closing over it.
 */
function ToolGroup({ toolClass, parts, defaultOpen }: {
  toolClass: ToolClass;
  parts: readonly ToolCallPart[];
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const spec = groups[toolClass];
  const HeadIcon = spec.icon;
  const totalMs = parts.reduce((sum, part) => sum + part.ms, 0);
  return (
    <div className="x-grp" data-open={open ? "true" : undefined}>
      <button className="x-grp-head" type="button" aria-expanded={open} onClick={() => { setOpen((was) => !was); }}>
        <ChevronRight className="x-chev" aria-hidden="true" />
        <span className="x-grp-name">
          <HeadIcon className="x-ico" aria-hidden="true" />
          <b>{spec.name}</b>
          <span>{spec.counted(parts.length)}</span>
        </span>
        <span className="x-grp-ms">{totalMs > 0 ? duration(totalMs) : "—"}</span>
      </button>
      <div className="x-grp-rows">
        {parts.map((part, index) => <Row key={part.entryId ?? String(index)} part={part} />)}
      </div>
    </div>
  );
}

/**
 * A batch of consecutive tool calls, bucketed by class — each group folds
 * independently and starts folded. A trailing `live` part is the step still
 * running, drawn as the pulsing line under the groups rather than a row.
 */
export function ToolPart({ parts, defaultOpen = false }: {
  parts: readonly ToolCallPart[];
  /** Stories only: renders every group already expanded. */
  defaultOpen?: boolean;
}) {
  const done = parts.filter((part) => !part.live);
  const live = parts.filter((part) => part.live);
  return (
    <>
      {done.length > 0
        ? (
          <div className="x-acts">
            {bucketByClass(done).map(([toolClass, bucket]) => (
              <ToolGroup key={toolClass} toolClass={toolClass} parts={bucket} defaultOpen={defaultOpen} />
            ))}
          </div>
        )
        : null}
      {live.map((part) => (
        <div className="x-live" key={`${part.verb}:${part.target}`}>
          <span className="x-live-dot" aria-hidden="true" />
          <span className="x-live-copy">{part.target ? `${part.verb} · ${part.target}` : part.verb}</span>
        </div>
      ))}
    </>
  );
}
