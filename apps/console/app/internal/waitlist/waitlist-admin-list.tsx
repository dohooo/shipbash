"use client";

import {
	type ReactNode,
	type RefObject,
	useActionState,
	useEffect,
	useRef,
	useState,
} from "react";

import { decideWaitlistAction, lockWaitlistAdminAction } from "./actions";
import styles from "./waitlist-admin.module.css";
import { INITIAL_WAITLIST_ADMIN_STATE } from "./waitlist-admin-state";

/** One open ask, worded on the server so no date is formatted twice. */
export interface WaitlistRow {
	userId: string;
	siteHost: string;
	/** The first two letters of the host, for the square beside it. */
	mark: string;
	email: string;
	askedOn: string;
	shelved: boolean;
}

export interface WaitlistCounts {
	waiting: number;
	shelved: number;
	admitted: number;
}

type Submit = (payload: FormData) => void;

function ShelveToggle({ row, submit }: { row: WaitlistRow; submit: Submit }) {
	return (
		<form action={submit}>
			<input name="userId" type="hidden" value={row.userId} />
			<input
				name="action"
				type="hidden"
				value={row.shelved ? "unshelve" : "shelve"}
			/>
			<button className="button quiet" type="submit">
				{row.shelved ? "Unshelve" : "Shelve"}
			</button>
		</form>
	);
}

function Row({
	onLetIn,
	row,
	submit,
}: {
	onLetIn: (row: WaitlistRow, opener: HTMLButtonElement) => void;
	row: WaitlistRow;
	submit: Submit;
}) {
	return (
		<tr className={row.shelved ? styles.shelved : undefined}>
			<td>
				<span className={styles.site}>
					<span aria-hidden="true" className={styles.mark}>
						{row.mark}
					</span>
					<b>{row.siteHost}</b>
				</span>
			</td>
			<td>{row.email}</td>
			<td>
				<span className={styles.when}>{row.askedOn}</span>
			</td>
			<td>
				{row.shelved ? (
					<span className="status">
						<span aria-hidden="true" />
						Shelved
					</span>
				) : null}
			</td>
			<td className={styles.actions}>
				<span>
					<ShelveToggle row={row} submit={submit} />
					<button
						className="button"
						onClick={(event) => onLetIn(row, event.currentTarget)}
						type="button"
					>
						Let in
					</button>
				</span>
			</td>
		</tr>
	);
}

/**
 * Letting someone in is two irreversible effects at once, so it is confirmed —
 * through `showModal()`, never by toggling `hidden`. A <dialog> without the
 * `open` attribute is inert in Chromium: forced visible it still cannot be
 * focused or tabbed into, and it traps nothing.
 */
function LetInDialog({
	dialogRef,
	onClose,
	row,
	submit,
}: {
	dialogRef: RefObject<HTMLDialogElement | null>;
	onClose: () => void;
	row: WaitlistRow | null;
	submit: Submit;
}) {
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: the only click this handles is the backdrop, which lands on the dialog element itself; showModal() already gives the keyboard Escape, and the footer gives it Cancel.
		<dialog
			aria-labelledby="wl-confirm-title"
			className={styles.modal}
			onClick={(event) => {
				if (event.target === dialogRef.current) dialogRef.current?.close();
			}}
			onClose={onClose}
			ref={dialogRef}
		>
			<div className={styles.modalBody}>
				<strong id="wl-confirm-title">Let this team in?</strong>
				<p>
					<b>{row?.siteHost}</b> gets access on their next page load, and we
					send the one email we promised to <b>{row?.email}</b>. Both happen now
					and neither can be taken back quietly.
				</p>
			</div>
			<div className={styles.modalFoot}>
				<button
					className="button quiet"
					onClick={() => dialogRef.current?.close()}
					type="button"
				>
					Cancel
				</button>
				<form action={submit}>
					<input name="userId" type="hidden" value={row?.userId ?? ""} />
					<input name="action" type="hidden" value="admit" />
					<button className="button primary" data-confirm type="submit">
						Let them in
					</button>
				</form>
			</div>
		</dialog>
	);
}

function ListHead({
	counts,
	error,
}: {
	counts: WaitlistCounts;
	error: string | null;
}) {
	return (
		<>
			<div className={styles.head}>
				<h1>Waiting list</h1>
				<form action={lockWaitlistAdminAction}>
					<button className={styles.lock} type="submit">
						Lock
					</button>
				</form>
			</div>
			<p className={styles.lede}>
				Everyone who hit the wall and left an address. Letting someone in takes
				effect on their next page load, and sends the one mail we promised them.
			</p>
			{error ? (
				<p className={styles.problem} role="alert">
					{error}
				</p>
			) : null}
			<dl className={styles.counts}>
				<div>
					<dt>Waiting</dt>
					<dd>{counts.waiting}</dd>
				</div>
				<div>
					<dt>Shelved</dt>
					<dd>{counts.shelved}</dd>
				</div>
				<div>
					<dt>Let in</dt>
					<dd>{counts.admitted}</dd>
				</div>
			</dl>
		</>
	);
}

function RequestTable({
	onLetIn,
	rows,
	submit,
}: {
	onLetIn: (row: WaitlistRow, opener: HTMLButtonElement) => void;
	rows: readonly WaitlistRow[];
	submit: Submit;
}) {
	return (
		<div className={styles.card}>
			<table className="table data-table">
				<thead>
					<tr>
						<th>Site to test</th>
						<th>Account</th>
						<th>Asked</th>
						<th />
						<th />
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<Row key={row.userId} onLetIn={onLetIn} row={row} submit={submit} />
					))}
				</tbody>
			</table>
		</div>
	);
}

/** `children` follow the list on the same page: the teams' month. */
export function WaitlistAdminList({
	children,
	counts,
	rows,
}: {
	children?: ReactNode;
	counts: WaitlistCounts;
	rows: readonly WaitlistRow[];
}) {
	const [state, submit] = useActionState(
		decideWaitlistAction,
		INITIAL_WAITLIST_ADMIN_STATE,
	);
	const dialogRef = useRef<HTMLDialogElement>(null);
	const openerRef = useRef<HTMLButtonElement | null>(null);
	const [confirming, setConfirming] = useState<WaitlistRow | null>(null);
	const answered = state.attempt;

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!confirming || !dialog || dialog.open) return;
		dialog.showModal();
		dialog.querySelector<HTMLButtonElement>("[data-confirm]")?.focus();
	}, [confirming]);

	// The decision came back; the dialog has done its job.
	useEffect(() => {
		if (answered > 0) dialogRef.current?.close();
	}, [answered]);

	return (
		<main className={styles.page}>
			<ListHead counts={counts} error={state.error} />
			<RequestTable
				onLetIn={(chosen, opener) => {
					openerRef.current = opener;
					setConfirming(chosen);
				}}
				rows={rows}
				submit={submit}
			/>
			<p className={styles.note}>
				Shelving is ours, not theirs: a shelved reader sees exactly what a
				waiting one sees. We never told anyone they were turned down, so this
				page must not be the thing that tells them.
			</p>
			{children}
			<LetInDialog
				dialogRef={dialogRef}
				onClose={() => {
					setConfirming(null);
					openerRef.current?.focus();
					openerRef.current = null;
				}}
				row={confirming}
				submit={submit}
			/>
		</main>
	);
}
