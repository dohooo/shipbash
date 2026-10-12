/**
 * A failure the command reports and exits with; anything else is a bug. The
 * steps, when given, tell the reader — usually a coding agent — what to do
 * next, in order.
 */
export class CliError extends Error {
	readonly code: string;
	readonly nextSteps: readonly string[];
	/** What a program reading the JSON needs beside the message, such as the choices to pick from. */
	readonly details: Readonly<Record<string, unknown>>;
	/** What a person reads between the message and the steps: the details, as text. */
	readonly lines: readonly string[];
	constructor(
		code: string,
		message: string,
		{
			nextSteps = [],
			details = {},
			lines = [],
		}: {
			nextSteps?: readonly string[];
			details?: Readonly<Record<string, unknown>>;
			lines?: readonly string[];
		} = {},
	) {
		super(message);
		this.name = "CliError";
		this.code = code;
		this.nextSteps = nextSteps;
		this.details = details;
		this.lines = lines;
	}
}

/** What a command says when it is called without what it needs: its usage line. */
export function usageError(line: string): CliError {
	return new CliError("USAGE", `Usage: ${line}`);
}

/** A failure as the CliError it is reported as; anything that is not one is UNEXPECTED. */
export function toCliError(error: unknown): CliError {
	return error instanceof CliError
		? error
		: new CliError(
				"UNEXPECTED",
				error instanceof Error ? error.message : String(error),
			);
}

/** Codes that stop for the user: they must act or decide before the command can go on. */
const USER_MUST_ACT = new Set([
	"NOT_SIGNED_IN",
	"TOKEN_REVOKED",
	"TEAM_CHOICE_REQUIRED",
	"PROJECT_REQUIRED",
	"CONFIRMATION_REQUIRED",
	"DECISION_REQUIRED",
	"QUESTION",
	"SIGN_IN_NEEDED",
]);

/** 1 failed, fix and retry; 2 the user must act or decide; 3 still running. */
export function exitCode(code: string): 1 | 2 | 3 {
	if (code === "STILL_RUNNING") return 3;
	return USER_MUST_ACT.has(code) ? 2 : 1;
}

export function loginCommand(origin: string | null): string {
	return origin
		? `npx shipbash login --origin ${origin}`
		: "npx shipbash login";
}

/** What a command says when it needs a sign-in that has not happened yet. */
export function notSignedIn(): CliError {
	return new CliError(
		"NOT_SIGNED_IN",
		"Not signed in to ShipBash on this machine.",
		{ nextSteps: signInSteps(null) },
	);
}

/** What a command says when ShipBash no longer accepts the stored token. */
export function tokenRevoked(origin: string): CliError {
	return new CliError(
		"TOKEN_REVOKED",
		`The token for ${origin} no longer works.`,
		{ nextSteps: signInSteps(origin) },
	);
}

/**
 * What a command says when its request failed on the way to ShipBash, or at
 * a gateway in front of it: the same request may go through if sent again.
 * A wait does not stop at it; it looks again at the next poll.
 */
export function unreachable(message: string): CliError {
	return new CliError("NETWORK", message, {
		nextSteps: ["Run the same command again."],
	});
}

function signInSteps(origin: string | null): string[] {
	return [
		"Ask the user whether you should sign in for them; only continue on a yes.",
		`Run \`${loginCommand(origin)}\`. It prints a pairing code and a URL and opens the browser.`,
		"Tell the user to approve the code on that page.",
		`Run \`${loginCommand(origin)}\` again until it exits 0, then run this command again.`,
	];
}
