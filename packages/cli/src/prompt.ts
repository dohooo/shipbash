/**
 * Questions for the person at the terminal. Agent mode never asks: a command
 * there stops with exit 2 and the choices instead, so reaching a prompt in
 * agent mode is a bug.
 */
import {
	checkbox as inquirerCheckbox,
	confirm as inquirerConfirm,
	input as inquirerInput,
	select as inquirerSelect,
} from "@inquirer/prompts";

import type { Mode } from "./mode.ts";

function assertHuman(mode: Mode): void {
	if (mode.agent)
		throw new Error(
			"A prompt was reached in agent mode; the command must exit 2 with the choices instead.",
		);
}

export async function select<Value>(
	mode: Mode,
	config: { message: string; choices: { name: string; value: Value }[] },
): Promise<Value> {
	assertHuman(mode);
	return inquirerSelect(config);
}

export async function checkbox<Value>(
	mode: Mode,
	config: {
		message: string;
		/** `short` is what the answered prompt shows for the choice. */
		choices: { name: string; short: string; value: Value; checked: boolean }[];
	},
): Promise<Value[]> {
	assertHuman(mode);
	return inquirerCheckbox(config);
}

export async function confirm(
	mode: Mode,
	config: { message: string },
): Promise<boolean> {
	assertHuman(mode);
	return inquirerConfirm(config);
}

export async function input(
	mode: Mode,
	config: { message: string },
): Promise<string> {
	assertHuman(mode);
	return inquirerInput({ ...config, required: true });
}
