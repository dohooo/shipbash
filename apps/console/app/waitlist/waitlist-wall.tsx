"use client";

import { useActionState } from "react";
import login from "../login/login.module.css";
import { LoginChassis } from "../login/login-chassis";
import { joinWaitlistAction } from "./actions";
import styles from "./waitlist.module.css";
import {
	initialJoinWaitlistState,
	type JoinWaitlistState,
} from "./waitlist-state";

/** What the reader already told us, or null while they have told us nothing. */
export interface WaitlistReceipt {
	email: string;
	/** The host of the site they asked for, which is what the copy names. */
	siteHost: string;
}

function Problem({ state }: { state: JoinWaitlistState }) {
	if (!state.error) return null;
	return (
		<p className={login.error} role="alert">
			{state.error === "site" ? (
				<>
					That is not an address we can reach. Give the full one, starting with{" "}
					<b>https://</b>.
				</>
			) : (
				state.message
			)}
		</p>
	);
}

function Join({
	pending,
	state,
	submit,
}: {
	pending: boolean;
	state: JoinWaitlistState;
	submit: (payload: FormData) => void;
}) {
	const badSite = state.error === "site";
	return (
		<>
			<h1 className={login.title} id="wl-title">
				Join the waitlist.
			</h1>
			<p className={login.description}>
				ShipBash is in private beta. Leave your email and the site you want
				bashed, and we'll let you know when a spot opens up.
			</p>
			<Problem state={state} />
			{/* Keyed on the attempt so a refused ask re-renders with what was typed. */}
			<form
				action={submit}
				className={`${login.form} ${styles.form}`}
				key={state.attempt}
			>
				<label className={styles.field}>
					<span className={styles.label}>Email</span>
					<input
						className={login.input}
						defaultValue={state.email}
						name="email"
						required
						type="email"
					/>
				</label>
				<label className={styles.field}>
					<span className={styles.label}>What to bash</span>
					<input
						aria-invalid={badSite || undefined}
						className={
							badSite ? `${login.input} ${styles.inputBad}` : login.input
						}
						defaultValue={state.site}
						name="site"
						placeholder="https://shop.northwind.example"
						required
						type="url"
					/>
				</label>
				<button
					className={`${login.cta} ${styles.submit}${pending ? ` ${login.ctaBusy}` : ""}`}
					type="submit"
				>
					<span>Join the waitlist</span>
				</button>
			</form>
			<div className={`${styles.account} ${styles.switch}`}>
				<span>Not your account?</span>
				<form action="/auth/logout" method="post">
					<input name="next" type="hidden" value="/waitlist" />
					<button type="submit">Use another</button>
				</form>
			</div>
		</>
	);
}

/**
 * The read-only receipt, and what a returning reader sees forever — whether
 * their ask is still open or has been shelved. It carries no position, no
 * estimate and no word for its state, because we never told anyone they were
 * turned down and this page must not be the thing that tells them.
 */
function Joined({ receipt }: { receipt: WaitlistReceipt }) {
	return (
		<>
			<h1 className={login.title} id="wl-title">
				You're on the waitlist.
			</h1>
			<p className={styles.sent}>
				<strong>{receipt.siteHost}</strong>
				<span>
					We'll email <b>{receipt.email}</b> when a spot opens up.
				</span>
			</p>
		</>
	);
}

export function WaitlistWall({
	account,
	receipt,
}: {
	account: string;
	receipt: WaitlistReceipt | null;
}) {
	const [state, submit, pending] = useActionState(
		joinWaitlistAction,
		initialJoinWaitlistState(account),
	);
	return (
		<LoginChassis dense labelledBy="wl-title" load={pending ? 1 : 0}>
			{receipt ? (
				<Joined receipt={receipt} />
			) : (
				<Join pending={pending} state={state} submit={submit} />
			)}
		</LoginChassis>
	);
}
