"use client";

import { ListTree } from "lucide-react";
import { useState } from "react";

import type { RunGridProps } from "./live-run-layout";
import { RunCase } from "./live-run-panels";
import { type RunRailRow, runJourneys, runRailRows, slotLabel } from "../_lib/run-cases";

/**
 * The run page's left column: its Journeys in rail order, with the hooks
 * around them folded behind a toggle in the column head — all but those that
 * did not pass.
 */
export function RunCaseRail({
	onSelectCase,
	railRows,
	railTally,
	selectedCaseRunId,
	view,
}: RunGridProps) {
	// Hooks start folded on every visit; the toggle is not remembered.
	const [hooksOpen, setHooksOpen] = useState(false);
	const rows = runRailRows(view.cases);
	const hooks = rows.filter((row) => row.ordinal === null);
	const liveHook = hooks.find(({ suiteCase }) =>
		suiteCase.id === view.currentCaseRunId && suiteCase.status === "running");
	// Folded, a hook still shows in its place while it runs, when it did not pass, and when it is the one selected.
	const shown = hooksOpen ? rows : rows.filter((row) =>
		row.ordinal !== null || row === liveHook || notPassed(row) || row.suiteCase.id === selectedCaseRunId);
	const count = railTally
		? <span className="rp-rail-tally">{railTally}</span>
		: <span>{runJourneys(view.cases).length}</span>;
	return (
		<aside className="case-rail" aria-label="User journeys">
			<header className="column-head">
				<span>Journeys</span>
				{hooks.length ? (
					<span className="hk-head-end">
						{count}
						<RailHooksToggle
							hooks={hooks}
							liveHook={liveHook}
							open={hooksOpen}
							onToggle={() => setHooksOpen((open) => !open)}
						/>
					</span>
				) : count}
			</header>
			<ol className="run-case-list" id={hooks.length ? "run-case-list" : undefined}>
				{railRows ?? shown.map(({ suiteCase, ordinal, nested, scopeOrdinal }) => (
					<RunCase
						suiteCase={suiteCase}
						ordinal={ordinal}
						nested={nested}
						scopeOrdinal={scopeOrdinal}
						currentCaseRunId={view.currentCaseRunId}
						selected={suiteCase.id === selectedCaseRunId}
						onSelect={onSelectCase}
						key={suiteCase.id}
					/>
				))}
			</ol>
		</aside>
	);
}

/** A hook whose verdict says it did not pass: failed, blocked, or an error on ShipBash's side. */
function notPassed({ suiteCase }: RunRailRow): boolean {
	return suiteCase.verdict === "failed" || suiteCase.verdict === "blocked" || suiteCase.verdict === "error";
}

/**
 * The column-head toggle the rail's hooks fold behind. It counts the hooks, or
 * only those that did not pass when any did not, and pulses instead while one runs.
 */
function RailHooksToggle({ hooks, liveHook, open, onToggle }: {
	hooks: readonly RunRailRow[];
	liveHook: RunRailRow | undefined;
	open: boolean;
	onToggle: () => void;
}) {
	const failed = hooks.filter(notPassed).length;
	const action = open ? "Hide" : "Show";
	const running = liveHook
		? ` · ${slotLabel(liveHook.suiteCase.role, liveHook.nested, liveHook.scopeOrdinal)} running`
		: "";
	return (
		<button
			className="hk-toggle"
			type="button"
			aria-pressed={open}
			aria-controls="run-case-list"
			aria-label={`${action} hooks`}
			title={`${action} hooks${failed ? ` · ${failed} did not pass` : ""}${running}`}
			data-fail={failed ? "" : undefined}
			data-live={liveHook ? "" : undefined}
			onClick={onToggle}
		>
			<ListTree aria-hidden="true" />
			{liveHook ? <span className="hk-live" aria-hidden="true" /> : (failed || hooks.length)}
		</button>
	);
}
