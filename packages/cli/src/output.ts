/**
 * Every command returns a result object and a text renderer. Agent mode
 * prints the object (or the error envelope) as the one JSON document on
 * stdout; human mode prints the text rendered from it. Progress goes to
 * stderr in both modes, coloured only for a person at a terminal.
 */
import { stripVTControlCharacters, styleText } from "node:util";

import type { CliError } from "./errors.ts";
import type { Mode } from "./mode.ts";

type Paint = (text: string) => string;
export interface Style {
	bold: Paint;
	dim: Paint;
	red: Paint;
	green: Paint;
	yellow: Paint;
	blue: Paint;
}

export interface Printable {
	result: Readonly<Record<string, unknown>> & { ok: true };
	text(style: Style): string[];
}

export interface Output {
	readonly mode: Mode;
	readonly style: Style;
	progress(line: string): void;
	print(printable: Printable): void;
	fail(error: CliError): void;
}

export interface OutputStreams {
	stdout: NodeJS.WritableStream & { isTTY?: boolean };
	stderr: NodeJS.WritableStream & { isTTY?: boolean };
}

function paint(format: Parameters<typeof styleText>[0], on: boolean): Paint {
	return on
		? (text) => styleText(format, text, { validateStream: false })
		: (text) => text;
}

function createStyle(colour: boolean): Style {
	return {
		bold: paint("bold", colour),
		dim: paint("dim", colour),
		red: paint("red", colour),
		green: paint("green", colour),
		yellow: paint("yellow", colour),
		blue: paint("blue", colour),
	};
}

function colourFor(
	mode: Mode,
	streams: OutputStreams,
	env: NodeJS.ProcessEnv,
): boolean {
	return (
		!mode.agent &&
		streams.stdout.isTTY === true &&
		streams.stderr.isTTY === true &&
		!env.NO_COLOR &&
		env.TERM !== "dumb"
	);
}

export function createOutput(
	mode: Mode,
	streams: OutputStreams,
	env: NodeJS.ProcessEnv = process.env,
): Output {
	const style = createStyle(colourFor(mode, streams, env));
	const json = (value: object) =>
		streams.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
	return {
		mode,
		style,
		progress(line) {
			streams.stderr.write(`${line}\n`);
		},
		print({ result, text }) {
			if (mode.agent) json(result);
			else for (const line of text(style)) streams.stdout.write(`${line}\n`);
		},
		fail(error) {
			if (mode.agent) {
				json({
					ok: false,
					error: error.code,
					message: error.message,
					...error.details,
					nextSteps: error.nextSteps,
				});
				return;
			}
			const lines = [
				style.red(`shipbash: ${error.message}`),
				...error.lines.map((line) => `  ${line}`),
				...error.nextSteps.map((step, index) =>
					style.dim(`  ${String(index + 1)}. ${step}`),
				),
			];
			for (const line of lines) streams.stderr.write(`${line}\n`);
		},
	};
}

/** Rows padded into columns two spaces apart; the first row is the header. A coloured cell pads by the text it shows. */
export function columns(rows: readonly (readonly string[])[]): string[] {
	const width = (cell: string) => stripVTControlCharacters(cell).length;
	const widths: number[] = [];
	for (const row of rows)
		for (const [index, cell] of row.entries())
			widths[index] = Math.max(widths[index] ?? 0, width(cell));
	return rows.map((row) =>
		row
			.map((cell, index) =>
				index === row.length - 1
					? cell
					: cell + " ".repeat((widths[index] ?? 0) - width(cell)),
			)
			.join("  "),
	);
}

/** How long ago a moment was, as a list shows it: "just now", "12 min ago", "3h ago", "4d ago". */
export function ago(timestamp: string): string {
	const minutes = Math.floor((Date.now() - Date.parse(timestamp)) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${String(minutes)} min ago`;
	const hours = Math.floor(minutes / 60);
	return hours < 24
		? `${String(hours)}h ago`
		: `${String(Math.floor(hours / 24))}d ago`;
}
