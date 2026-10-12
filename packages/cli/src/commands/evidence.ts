/**
 * `shipbash evidence <id>`: pulls what ShipBash left behind into a directory
 * an agent can read. The id names what to pull: a journey's walk in a
 * verification (`case_run_…`), with the run's overview and every attempt of
 * that journey; or a walk or a Discovery (its id), with its conversation and
 * the files of each part it ran in. Either comes as one zip, in one format,
 * which is unpacked here.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { unzipSync } from "fflate";

import { requestBytesAs } from "../api.ts";
import { requireCredentials } from "../config.ts";
import { CliError, usageError } from "../errors.ts";
import type { Printable } from "../output.ts";

/** A bundle of a long run is tens of megabytes; it is read to its end, not until a quiet moment. */
const BUNDLE_TIMEOUT_MS = 5 * 60 * 1_000;

export const EVIDENCE_HELP = `Usage: shipbash evidence <id> [--out <dir>]

Pulls what ShipBash left behind into a directory for an agent to read, whatever
the outcome: README.md (start here), evidence.json (how it ended), and the
screenshots, screen recordings and terminal logs that were kept. The id is one
of:
  - a journey's walk in a verification (case_run_…): the run's overview, and
    that journey's files for each of its attempts. The README names the
    command for the run's other journeys, which adds them to the same
    directory.
  - a walk or a Discovery (its id): its conversation, its outcome, and its
    files for each part it ran in.
Changes nothing on ShipBash.

  --out <dir>  Where to write the bundle (default ./shipbash-evidence-<ref>, the
               id's first 8 hex characters, as in shipbash-evidence-0c67f2ce)
`;

/** Where each file of the bundle goes under the directory, refusing a name that leaves it. */
function destinations(
	directory: string,
	files: Record<string, Uint8Array>,
): Array<[string, Uint8Array]> {
	return Object.entries(files).map(([name, data]) => {
		const path = resolve(directory, name);
		const inside = relative(directory, path);
		if (
			inside === "" ||
			inside === ".." ||
			inside.startsWith(`..${sep}`) ||
			isAbsolute(inside)
		)
			throw new CliError(
				"EVIDENCE_UNSAFE",
				`The bundle names a file outside ${directory}: ${name}. Nothing was written; tell the user.`,
			);
		return [path, data];
	});
}

/** The bundle's files, or the failure of a zip that did not arrive whole. */
function unpack(archive: Uint8Array): Record<string, Uint8Array> {
	try {
		return unzipSync(archive);
	} catch {
		throw new CliError(
			"EVIDENCE_INCOMPLETE",
			"The bundle did not arrive whole, so nothing was written.",
			{
				nextSteps: [
					"Run this command again: a dropped connection may pass on a second try.",
					"If it fails again, it is a fault on ShipBash's side: tell the user, and do not treat any earlier bundle as this run's evidence.",
				],
			},
		);
	}
}

/** Where the bundle an id names is served: a case run's under its walk, anything else under the walk or Discovery it names. */
function bundlePath(id: string): string {
	return id.startsWith("case_run_")
		? `/api/case-runs/${encodeURIComponent(id)}/evidence.zip`
		: `/api/activities/${encodeURIComponent(id)}/evidence.zip`;
}

export async function runEvidence(
	id: string | undefined,
	options: { out: string | null },
): Promise<Printable> {
	if (!id) throw usageError("shipbash evidence <id> [--out <dir>]");
	const credentials = await requireCredentials();
	const outDirectory = resolve(
		options.out ??
			`shipbash-evidence-${id.replace(/^case_run_/u, "").slice(0, 8)}`,
	);
	const archive = await requestBytesAs(
		credentials,
		bundlePath(id),
		BUNDLE_TIMEOUT_MS,
	);
	const files = destinations(outDirectory, unpack(archive));
	await mkdir(outDirectory, { recursive: true });
	for (const [path, data] of files) {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, data, { mode: 0o600 });
	}
	return {
		result: { ok: true, id, directory: outDirectory, fileCount: files.length },
		text: () => [
			`Evidence for ${id} is in ${outDirectory}`,
			`  ${String(files.length)} files, including README.md and evidence.json`,
			"  Start with README.md.",
		],
	};
}
