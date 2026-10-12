"use client";

import type { ApiContractResponse } from "@shipbash/contracts/api/core";
import type { getSlackConnectContract } from "@shipbash/contracts/api/slack";
import { useMutation } from "@tanstack/react-query";
import { type ReactNode, useEffect } from "react";

import { webClient } from "../../../lib/web-client";
import { LoginChassis } from "../../login/login-chassis";
import login from "../../login/login.module.css";
import styles from "./slack-connect.module.css";

type SlackConnectRequest = ApiContractResponse<typeof getSlackConnectContract>["request"];

/**
 * What the page is showing: on the way to Slack; the Slack identity Slack
 * verified, to confirm; or why there is none — the sign-in expired, Slack
 * did not sign the person in, or it signed in to another workspace than the
 * one @ShipBash asked from.
 */
type SignInFailure = "expired" | "refused" | "workspace";

export type SlackConnectScreen =
	| { kind: "leaving"; href: string }
	| { kind: "confirm"; signInId: string; request: SlackConnectRequest }
	| { kind: "failed"; reason: SignInFailure };

interface SlackConnectProps {
	/** The ShipBash account the Slack user would sign in as. */
	account: string;
	screen: SlackConnectScreen;
}

/** A replace, so going back from Slack does not land here and leave again. */
function Leaving({ href }: { href: string }) {
	useEffect(() => {
		window.location.replace(href);
	}, [href]);
	return (
		<>
			<h1 className={login.title} id="slack-connect-title">
				Taking you to Slack
			</h1>
			<p className={login.description}>Slack confirms who you are there.</p>
			<a className={`${login.cta} ${login.ctaFull}`} href={href}>
				Continue to Slack
			</a>
		</>
	);
}

function Review({
	account,
	busy,
	error,
	onConnect,
	request,
}: {
	account: string;
	busy: boolean;
	error: Error | null;
	onConnect: () => void;
	request: SlackConnectRequest;
}) {
	// Another account starts over: this sign-in belongs to the one signed in now.
	const restart = `/slack/connect?${new URLSearchParams({ team: request.slackTeamId, channel: request.channelId }).toString()}`;
	return (
		<>
			<h1 className={login.title} id="slack-connect-title">
				Sign in to use @ShipBash in {request.slackTeamName}
			</h1>
			<p className={login.description}>
				You&apos;re signed in to ShipBash as <b>{account}</b>. When @
				{request.slackUserName} mentions @ShipBash in {request.slackTeamName},
				it works as this account.
			</p>
			{error ? (
				<p className={login.error} role="alert">
					{error.message}
				</p>
			) : null}
			<button
				className={`${login.cta} ${login.ctaFull}${busy ? ` ${login.ctaBusy}` : ""}`}
				disabled={busy}
				onClick={onConnect}
				type="button"
			>
				<span>Continue</span>
			</button>
			<div className={styles.account}>
				{account} ·{" "}
				<form action="/auth/logout" method="post">
					<input name="next" type="hidden" value={restart} />
					<button type="submit">use another account</button>
				</form>
			</div>
		</>
	);
}

const FAILED: Record<SignInFailure, { title: string; description: string }> = {
	expired: { title: "That link expired.", description: "Mention @ShipBash in Slack again for a new one." },
	refused: { title: "Slack didn't sign you in.", description: "Mention @ShipBash in Slack again to try again." },
	workspace: {
		title: "That was another Slack workspace.",
		description: "Mention @ShipBash again, and sign in to the Slack workspace you mentioned it in.",
	},
};

function Failed({ reason }: { reason: SignInFailure }) {
	return (
		<>
			<h1 className={login.title} id="slack-connect-title">
				{FAILED[reason].title}
			</h1>
			<p className={login.description}>{FAILED[reason].description}</p>
		</>
	);
}

function Confirm({ account, signInId, request }: { account: string; signInId: string; request: SlackConnectRequest }) {
	const connect = useMutation({
		mutationFn: () => webClient.confirmSlackConnect(signInId),
	});
	let panel: ReactNode;
	if (connect.isSuccess) {
		const slack = `slack://channel?team=${encodeURIComponent(request.slackTeamId)}&id=${encodeURIComponent(request.channelId)}`;
		panel = (
			<>
				<h1 className={login.title} id="slack-connect-title">
					You&apos;re signed in.
				</h1>
				<p className={login.description}>
					Mention @ShipBash in {request.slackTeamName} and it will answer.
				</p>
				<a className={login.cta} href={slack}>
					Return to Slack
				</a>
			</>
		);
	} else {
		panel = (
			<Review
				account={account}
				busy={connect.isPending}
				error={connect.error}
				onConnect={() => connect.mutate()}
				request={request}
			/>
		);
	}
	return (
		<LoginChassis labelledBy="slack-connect-title" load={connect.isPending ? 1 : 0}>
			{panel}
		</LoginChassis>
	);
}

export function SlackConnect({ account, screen }: SlackConnectProps) {
	if (screen.kind === "confirm") {
		return <Confirm account={account} request={screen.request} signInId={screen.signInId} />;
	}
	return (
		<LoginChassis labelledBy="slack-connect-title" load={screen.kind === "leaving" ? 1 : 0}>
			{screen.kind === "leaving" ? <Leaving href={screen.href} /> : <Failed reason={screen.reason} />}
		</LoginChassis>
	);
}
