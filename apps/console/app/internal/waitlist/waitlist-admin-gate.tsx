"use client";

import { useActionState } from "react";
import login from "../../login/login.module.css";
import { LoginChassis } from "../../login/login-chassis";
import { unlockWaitlistAdminAction } from "./actions";
import { INITIAL_WAITLIST_ADMIN_STATE } from "./waitlist-admin-state";

/**
 * The lock on the internal list. One shared password and no account, so there
 * is nothing to recover and nothing to rate-limit beyond the constant-time
 * compare the action makes.
 */
export function WaitlistAdminGate() {
	const [state, submit, pending] = useActionState(
		unlockWaitlistAdminAction,
		INITIAL_WAITLIST_ADMIN_STATE,
	);
	return (
		<LoginChassis labelledBy="wl-title" load={pending ? 1 : 0}>
			<h1 className={login.title} id="wl-title">
				Internal.
			</h1>
			<p className={login.description}>
				The waiting list. Not part of the product, and not linked from it.
			</p>
			{state.error ? (
				<p className={login.error} role="alert">
					{state.error}
				</p>
			) : null}
			<form action={submit} className={login.form}>
				<input
					autoComplete="current-password"
					className={login.input}
					name="password"
					placeholder="Password"
					required
					type="password"
				/>
				<button
					className={`${login.cta} ${login.ctaFull}${pending ? ` ${login.ctaBusy}` : ""}`}
					type="submit"
				>
					<span>Unlock</span>
				</button>
			</form>
		</LoginChassis>
	);
}
