"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import login from "../../login/login.module.css";
import { LoginChassis } from "../../login/login-chassis";
import styles from "./cli-authorize.module.css";
import { normalizePairingCode } from "./pairing-code";

/** The five screens (denied reads like expired, with another sentence). */
export type CliAuthorizeState =
	| "entry"
	| "review"
	| "working"
	| "done"
	| "expired"
	| "denied";

interface CliAuthorizeRequest {
	client: { name: string; version: string };
	device: string;
	expiresAt: string;
}

interface CliAuthorizeProps {
	account: string;
	code: string | null;
	initial: CliAuthorizeState;
	request: CliAuthorizeRequest | null;
	/** This page with its code, for the sign-in round trip. */
	returnTo: string;
}

const POLL_MS = 1_500;

/** "ada-mbp.local" reads as "ada-mbp" in the title. */
function shortDevice(device: string): string {
	return device.split(".")[0] || device;
}

/** How hard the eye works on each screen: signing is the only real load. */
function eyeLoad(state: CliAuthorizeState): number {
	if (state === "working") return 2;
	if (state === "done") return 0;
	return 0.3;
}

async function decide(
	code: string,
	decision: "approve" | "deny",
): Promise<boolean> {
	const response = await fetch(
		`/api/cli/sessions/${encodeURIComponent(code)}/${decision}`,
		{
			method: "POST",
			credentials: "same-origin",
			headers: { accept: "application/json" },
		},
	);
	return response.ok;
}

function stateFrom(payload: unknown): string | null {
	if (
		typeof payload !== "object" ||
		payload === null ||
		!("request" in payload)
	)
		return null;
	const request = payload.request;
	if (typeof request !== "object" || request === null || !("state" in request))
		return null;
	return typeof request.state === "string" ? request.state : null;
}

async function readState(code: string): Promise<string | null> {
	const response = await fetch(
		`/api/cli/sessions/${encodeURIComponent(code)}`,
		{
			credentials: "same-origin",
			headers: { accept: "application/json" },
		},
	);
	if (!response.ok) return response.status === 404 ? "expired" : null;
	return stateFrom(await response.json());
}

function EntryForm({ onSubmit }: { onSubmit: (code: string) => void }) {
	const [value, setValue] = useState("");
	const [invalid, setInvalid] = useState(false);
	return (
		<>
			<h1 className={login.title}>Pair your terminal.</h1>
			<form
				className={login.form}
				onSubmit={(event) => {
					event.preventDefault();
					const code = normalizePairingCode(value);
					if (code) onSubmit(code);
					else setInvalid(true);
				}}
			>
				<input
					aria-invalid={invalid}
					aria-label="Pairing code"
					autoCapitalize="characters"
					autoComplete="off"
					className={`${login.input} ${styles.pairInput}`}
					name="code"
					onChange={(event) => {
						setValue(event.target.value);
						setInvalid(false);
					}}
					placeholder="FJKD-8P2M"
					spellCheck={false}
					value={value}
				/>
				<button className={`${login.cta} ${login.ctaFull}`} type="submit">
					Continue
				</button>
			</form>
		</>
	);
}

function Panel({
	account,
	code,
	onApprove,
	onDeny,
	request,
	returnTo,
	state,
}: {
	account: string;
	code: string;
	onApprove: () => void;
	onDeny: () => void;
	request: CliAuthorizeRequest | null;
	returnTo: string;
	state: Exclude<CliAuthorizeState, "entry">;
}) {
	if (state === "review") {
		return (
			<>
				<h1 className={login.title}>
					Approve {shortDevice(request?.device ?? "this device")}?
				</h1>
				<p className={styles.pairCode}>{code}</p>
				<p className={styles.pairFacts}>
					<b>
						{request?.client.name ?? "shipbash"} {request?.client.version ?? ""}
					</b>{" "}
					· {request?.device ?? ""}
					<br />
					approve only if you just ran <b>shipbash login</b>
				</p>
				<div className={styles.pairRow}>
					<button className={login.cta} onClick={onApprove} type="button">
						Approve
					</button>
					<button className={styles.pairDeny} onClick={onDeny} type="button">
						Deny
					</button>
				</div>
				<div className={styles.pairAccount}>
					{account} ·{" "}
					<form
						action="/auth/logout"
						method="post"
						style={{ display: "inline" }}
					>
						<input name="next" type="hidden" value={returnTo} />
						<button type="submit">use another account</button>
					</form>
				</div>
			</>
		);
	}
	if (state === "working") {
		return (
			<>
				<h1 className={login.title}>Signing…</h1>
				<p className={`${styles.pairCode} ${styles.sm}`}>{code}</p>
				<span className={styles.pairWait} role="status">
					Waiting for the CLI
				</span>
			</>
		);
	}
	if (state === "done") {
		return (
			<>
				<h1 className={login.title}>You&apos;re in.</h1>
				<p className={login.description}>
					Your terminal has the token. You can close this tab.
				</p>
				<p className={styles.pairFine}>
					Revoke it any time with <code>shipbash logout</code>.
				</p>
			</>
		);
	}
	return (
		<>
			<h1 className={login.title}>
				{state === "denied" ? "Denied." : "That code expired."}
			</h1>
			<p className={`${login.description} ${styles.description}`}>
				{state === "denied" ? (
					"Nothing was issued."
				) : (
					<>
						Nothing was issued. Run <code>shipbash login</code> again.
					</>
				)}
			</p>
			<a className={login.cta} href="/">
				Done
			</a>
		</>
	);
}

/** The request's life on this screen: expiry on the service's clock, and the wait for the CLI once approved. */
function useAuthorizeFlow(
	code: string | null,
	initial: CliAuthorizeState,
	request: CliAuthorizeRequest | null,
) {
	const [state, setState] = useState<CliAuthorizeState>(initial);
	useEffect(() => {
		if (state !== "review" || !request) return;
		const remaining = new Date(request.expiresAt).getTime() - Date.now();
		const timer = setTimeout(() => setState("expired"), Math.max(0, remaining));
		return () => clearTimeout(timer);
	}, [request, state]);
	useEffect(() => {
		if (state !== "working" || !code) return;
		let cancelled = false;
		const tick = async () => {
			const next = await readState(code);
			if (cancelled) return;
			if (next === "taken") setState("done");
			else if (next === "denied") setState("denied");
			else if (next === "expired") setState("expired");
		};
		const timer = setInterval(() => {
			void tick();
		}, POLL_MS);
		void tick();
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [code, state]);
	const approve = async () => {
		if (!code) return;
		setState("working");
		if (!(await decide(code, "approve"))) setState("expired");
	};
	const deny = async () => {
		if (!code) return;
		setState((await decide(code, "deny")) ? "denied" : "expired");
	};
	return { state, approve, deny };
}

export function CliAuthorizeExperience({
	account,
	code,
	initial,
	request,
	returnTo,
}: CliAuthorizeProps) {
	const router = useRouter();
	const flow = useAuthorizeFlow(code, initial, request);
	return (
		<LoginChassis labelledBy="pair-title" load={eyeLoad(flow.state)}>
			{flow.state === "entry" || !code ? (
				<EntryForm
					onSubmit={(next) =>
						router.push(`/cli/authorize?code=${encodeURIComponent(next)}`)
					}
				/>
			) : (
				<Panel
					account={account}
					code={code}
					onApprove={() => {
						void flow.approve();
					}}
					onDeny={() => {
						void flow.deny();
					}}
					request={request}
					returnTo={returnTo}
					state={flow.state}
				/>
			)}
		</LoginChassis>
	);
}
