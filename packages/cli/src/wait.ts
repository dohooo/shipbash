/**
 * Waiting for work ShipBash does on its own time: a pairing, a walk, a
 * verification. The command polls every 3 s until the work settles; a look
 * that failed on the way to ShipBash (NETWORK) is tried again at the next
 * poll, with one line on stderr when the connection is lost and one when it
 * is back. When the wait limit comes first it exits 3, aborting a look still
 * in flight, and on Ctrl-C 130; both name the command that keeps waiting, and
 * neither stops the work.
 */
import { CliError } from "./errors.ts";
import type { Output } from "./output.ts";

const POLL_MS = 3_000;
/** Agent mode returns from a wait after this long unless --timeout says otherwise. */
const AGENT_WAIT_MS = 90_000;

/** How long to wait: --timeout, else 90 s in agent mode and no limit for a person. */
export function waitLimitMs(
	timeout: string | null,
	agent: boolean,
): number | null {
	if (timeout === null) return agent ? AGENT_WAIT_MS : null;
	const seconds = Number(timeout);
	if (!/^\d+$/u.test(timeout) || !Number.isSafeInteger(seconds))
		throw new CliError(
			"USAGE",
			`--timeout takes a whole number of seconds, not "${timeout}".`,
		);
	return seconds * 1_000;
}

/** The line before the first poll that names what is waited on: `(verification 2c7f19e0 · Ctrl-C stops waiting, not the run)`. */
export function announce(output: Output, subject: string, work: string): void {
	output.progress(
		output.style.dim(`(${subject} · Ctrl-C stops waiting, not the ${work})`),
	);
}

export interface Wait<T> {
	/**
	 * One look at the work: what it settled on, or null while it goes on. A
	 * look that passes `signal` to its request is aborted when the limit comes;
	 * one that must not be cut off mid-request ignores it, and the wait stops
	 * after it.
	 */
	poll(signal?: AbortSignal): Promise<T | null>;
	limitMs: number | null;
	/** What exit 3 reports when the limit comes first: STILL_RUNNING, naming the command that keeps waiting. */
	stillRunning: CliError;
	/** What Ctrl-C prints before exit 130: the command that keeps waiting. */
	interrupted: string;
}

/** The poll interval, cut short when the limit comes, and skipped once it has. */
function pause(limit: AbortSignal): Promise<void> {
	if (limit.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			limit.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, POLL_MS);
		limit.addEventListener("abort", done, { once: true });
	});
}

/**
 * The wait's looks, one per call. A look that failed on the way to ShipBash
 * reads as the work going on, so the next poll looks again; the first such
 * failure says so, and the look that gets through after it says the
 * connection is back.
 */
function looks<T>(
	output: Output,
	wait: Wait<T>,
): (signal?: AbortSignal) => Promise<T | null> {
	let lost = false;
	return async (signal) => {
		try {
			const settled = await wait.poll(signal);
			if (lost) output.progress("Connection to ShipBash is back.");
			lost = false;
			return settled;
		} catch (error) {
			if (!(error instanceof CliError && error.code === "NETWORK")) throw error;
			if (!lost)
				output.progress(
					output.style.yellow(
						"Lost the connection to ShipBash; still waiting and trying again.",
					),
				);
			lost = true;
			return null;
		}
	};
}

export async function waitFor<T>(output: Output, wait: Wait<T>): Promise<T> {
	const limit = new AbortController();
	const timer =
		wait.limitMs === null
			? undefined
			: setTimeout(() => limit.abort(), wait.limitMs);
	const stop = () => {
		output.progress(wait.interrupted);
		process.exit(130);
	};
	process.once("SIGINT", stop);
	const look = looks(output, wait);
	try {
		// The first look always completes, so a limit of 0 still reports work that has already settled.
		let settled = await look();
		while (settled === null) {
			await pause(limit.signal);
			if (limit.signal.aborted) throw wait.stillRunning;
			settled = await look(limit.signal).catch((error: unknown) => {
				// A look the limit cut off; any other failure is the command's.
				const cutOff =
					limit.signal.aborted &&
					error instanceof Error &&
					error.name === "AbortError";
				throw cutOff ? wait.stillRunning : error;
			});
		}
		return settled;
	} finally {
		clearTimeout(timer);
		process.off("SIGINT", stop);
	}
}
