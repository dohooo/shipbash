"use client";

import { useActionState } from "react";

import { setTeamRunQuotaAction } from "./actions";
import styles from "./waitlist-admin.module.css";
import { INITIAL_WAITLIST_ADMIN_STATE } from "./waitlist-admin-state";

/** One team's month, worded on the server like the requests are. */
export interface TeamUsageRow {
	teamId: string;
	name: string;
	slug: string;
	runs: number;
	cost: string;
	/** Null is no limit. */
	quota: number | null;
}

type Submit = (payload: FormData) => void;

/**
 * The quota, edited where it is shown. Keyed by the saved value, so a save
 * the page reads back redraws the field with what was saved.
 */
function QuotaForm({ row, submit }: { row: TeamUsageRow; submit: Submit }) {
	return (
		<form action={submit} className={styles.quota} key={String(row.quota)}>
			<input name="teamId" type="hidden" value={row.teamId} />
			<input
				aria-label={`Monthly Runs for ${row.name}`}
				defaultValue={row.quota ?? ""}
				inputMode="numeric"
				min={0}
				name="quota"
				placeholder="No limit"
				step={1}
				type="number"
			/>
			<button className="button quiet" type="submit">
				Save
			</button>
		</form>
	);
}

/**
 * Every team's Runs this month, the month's usage priced at list rates, and
 * the quota that stops its next verification run. An empty quota is no limit.
 */
export function TeamUsageTable({ rows }: { rows: readonly TeamUsageRow[] }) {
	const [state, submit] = useActionState(
		setTeamRunQuotaAction,
		INITIAL_WAITLIST_ADMIN_STATE,
	);
	return (
		<section aria-labelledby="wl-teams-title" className={styles.teams}>
			<h2 id="wl-teams-title">Teams this month</h2>
			<p className={styles.lede}>
				The Runs each team counted since the first of the month (UTC), and its
				usage priced at list rates: model tokens, Sandbox time and Jev.
				Sandbox time counts each Activity's last leg and work that has ended.
				When SHIPBASH_RUN_QUOTA is true, a team starts no verification run past
				its quota; empty is no limit.
			</p>
			{state.error ? (
				<p className={styles.problem} role="alert">
					{state.error}
				</p>
			) : null}
			<div className={styles.teamCard}>
				<table className="table data-table">
					<thead>
						<tr>
							<th>Team</th>
							<th className={styles.number}>Runs</th>
							<th className={styles.number}>Cost</th>
							<th className={styles.number}>Monthly quota</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => (
							<tr key={row.teamId}>
								<td>
									<b>{row.name}</b> <span className={styles.when}>{row.slug}</span>
								</td>
								<td className={styles.number}>{row.runs}</td>
								<td className={styles.number}>{row.cost}</td>
								<td>
									<QuotaForm row={row} submit={submit} />
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}
