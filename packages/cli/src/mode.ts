/**
 * Human or agent, decided once per invocation; the first rule that matches
 * wins. Agent mode never prompts, prints exactly one JSON object on stdout,
 * and returns from long waits.
 */
import { determineAgent } from "@vercel/detect-agent";

export interface Mode {
	agent: boolean;
	/** The rule that decided: `--json`, `SHIPBASH_AGENT`, a detected agent, or whether there is a terminal. */
	rule: "flag" | "env" | "detected" | "terminal";
	/** What decided, as `status` and the notice line name it. */
	reason: string;
}

export async function resolveMode(
	argv: readonly string[],
	env: NodeJS.ProcessEnv,
	streams: { stdin: { isTTY?: boolean }; stdout: { isTTY?: boolean } },
): Promise<Mode> {
	if (argv.includes("--json"))
		return { agent: true, rule: "flag", reason: "--json" };
	if (env.SHIPBASH_AGENT === "1")
		return { agent: true, rule: "env", reason: "SHIPBASH_AGENT" };
	if (env.SHIPBASH_AGENT === "0")
		return { agent: false, rule: "env", reason: "SHIPBASH_AGENT" };
	const detected = await determineAgent();
	if (detected.isAgent)
		return { agent: true, rule: "detected", reason: detected.agent.name };
	return streams.stdin.isTTY && streams.stdout.isTTY
		? { agent: false, rule: "terminal", reason: "terminal" }
		: { agent: true, rule: "terminal", reason: "no terminal" };
}

/** The stderr line that says why agent mode was chosen, when an environment variable or a detected agent chose it. */
export function modeNotice(mode: Mode): string | null {
	if (!mode.agent || (mode.rule !== "env" && mode.rule !== "detected"))
		return null;
	return `shipbash: agent mode (${mode.reason}) · SHIPBASH_AGENT=0 for text`;
}

export function modeLabel(mode: Mode): string {
	return `${mode.agent ? "agent" : "text"} (${mode.reason})`;
}
