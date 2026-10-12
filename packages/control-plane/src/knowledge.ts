/**
 * Product knowledge: the single source of truth for what ShipBash may record
 * about a Project's product, and therefore for two things at once —
 *
 *   1. write-time validation on the host (`knowledgeEntrySchema`), and
 *   2. the TypeScript types the store and the API speak.
 *
 * `packages/contracts/src/runtime/knowledge-contract.mjs` re-implements a
 * structural subset of these shapes by hand (container code runs inside the
 * Runner without a bundle, so it cannot import this module). This module stays
 * authoritative: the host re-validates every entry here before it reaches the
 * database. Change the two together.
 */
import { z } from "zod";

import { PUBLIC_PRODUCT_KNOWLEDGE_KIND_VALUES } from "@shipbash/contracts/runtime/generated/db-vocabularies.mjs";
import { normalizePageKey } from "@shipbash/contracts/runtime/page-key.mjs";

export { normalizePageKey };

export const KNOWLEDGE_KINDS = PUBLIC_PRODUCT_KNOWLEDGE_KIND_VALUES;

export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);

const optionalText = (maximum: number) =>
	z.string().trim().max(maximum).nullable().default(null);

const entryTitle = boundedText(120).describe(
	"One-line label for this entry, written so a human scanning a list knows what it holds. " +
		'State the subject, not the act of recording it: "Billing page requires a connected card", ' +
		'never "Recorded a page".',
);

/**
 * Something the user told us. The host writes these itself from the answer to
 * a `request_choice` question, so the agent never fills this shape in by hand.
 */
export const qaKnowledgeBodySchema = z
	.object({
		question: boundedText(500).describe(
			"The question that was put to the user, verbatim.",
		),
		options: z
			.array(boundedText(120))
			.max(8)
			.default([])
			.describe(
				"The choices offered to the user, verbatim. Empty when the question was free-text only.",
			),
		answer: optionalText(120).describe(
			"The option the user selected, verbatim. Null when the user answered in their own words.",
		),
		freeText: optionalText(2_000).describe(
			"What the user typed when they answered in their own words. Null when they picked an option. " +
				"Exactly one of answer and freeText is ever set.",
		),
		note: optionalText(2_000).describe(
			"The user's extra remark attached to a selected option. Only ever present alongside answer; " +
				"a free-text answer carries its own detail and never has a note.",
		),
		page: optionalText(500).describe(
			"The URL the agent was on when it asked, so the answer can be surfaced again on that page. " +
				"Null when the question was not about a particular page.",
		),
		askedDuring: z
			.literal("discovery")
			.describe("Which kind of run raised the question: only a run the owner watches asks live."),
	})
	.refine((value) => (value.answer === null) !== (value.freeText === null), {
		message: "Exactly one of answer or freeText must be set.",
		path: ["answer"],
	})
	.refine((value) => value.note === null || value.answer !== null, {
		message: "note is only allowed alongside a selected option.",
		path: ["note"],
	})
	.describe(
		"Something the user decided. Their answers outrank the agent's inferences.",
	);

/** A page the agent understood well enough to describe. */
export const pageKnowledgeBodySchema = z
	.object({
		url: boundedText(500).describe(
			"The page's URL as the browser reported it.",
		),
		purpose: boundedText(600).describe(
			"What this page is for, in the product's own terms — the job a user comes here to do, " +
				"not a description of its layout.",
		),
		keyActions: z
			.array(boundedText(120))
			.max(10)
			.default([])
			.describe(
				"The actions this page actually offers, phrased as a user would name them " +
					'("invite a teammate", "connect a repository").',
			),
		reachedVia: boundedText(300).describe(
			"How you got here, so the next run can get here too: the click path from a known page, " +
				"or the fact that it is a landing surface.",
		),
		openQuestions: z
			.array(boundedText(300))
			.max(5)
			.default([])
			.describe(
				"What you could not work out about this page. These become questions for the user later, " +
					"so write them as questions, not as apologies.",
			),
	})
	.describe(
		"A page you understood. Record one for every page you can describe.",
	);

/** A route the agent walked end to end — including the ones that broke. */
export const pathKnowledgeBodySchema = z
	.object({
		steps: z
			.array(boundedText(300))
			.min(1)
			.describe(
				"The steps you actually performed, taken from your execution transcript in order. " +
					"Never invent or tidy a step you did not run.",
			),
		outcome: boundedText(400).describe(
			"Where the route ended: the business result you reached, or exactly where and why it broke.",
		),
		durationSeconds: z
			.number()
			.int()
			.min(0)
			.max(86_400)
			.nullable()
			.default(null)
			.describe(
				"Roughly how long the route took, when you can tell. Null when you cannot.",
			),
		becameJourney: z
			.boolean()
			.describe(
				"True when this route is worth proposing as a guarded User Journey.",
			),
	})
	.describe(
		"A route you walked end to end. Broken routes are as valuable as working ones.",
	);

/** A choice the agent made on its own, so a later run can see the seam. */
export const decisionKnowledgeBodySchema = z
	.object({
		context: boundedText(500).describe(
			"The fork you were standing at, and what made it a fork.",
		),
		chose: boundedText(300).describe("What you did."),
		reason: boundedText(500).describe(
			'Why that branch. Be honest when the reason was only "it was the first option".',
		),
		userConfirmed: z
			.boolean()
			.describe(
				"True only when the user explicitly confirmed this choice. While false, the next run that " +
					"reaches this fork must ask rather than repeat the guess.",
			),
	})
	.describe(
		"A choice you made without the user. Recording it is what makes it reviewable.",
	);

/** How to operate this product's test environment. */
export const environmentKnowledgeBodySchema = z
	.object({
		capability: boundedText(300).describe(
			'What this makes possible, stated as an outcome: "reset a workspace\'s onboarding", ' +
				'"use the sandbox payment card".',
		),
		how: boundedText(2_000).describe(
			"The exact steps or address to use it, concrete enough to follow without guessing.",
		),
		providedBy: z
			.enum(["user", "agent"])
			.describe(
				"Whether the user told us this or the agent discovered it. User-provided environment " +
					"knowledge is trusted over anything the agent inferred.",
			),
		appliesTo: z
			.array(boundedText(120))
			.max(10)
			.default([])
			.describe(
				"The areas or Journeys this applies to. Empty when it applies to the whole product.",
			),
	})
	.describe(
		"How to operate the test environment. This is what turns a one-shot run into a repeatable one.",
	);

export const knowledgeEntrySchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("qa"), entryTitle, body: qaKnowledgeBodySchema }),
	z.object({
		kind: z.literal("page"),
		entryTitle,
		body: pageKnowledgeBodySchema,
	}),
	z.object({
		kind: z.literal("path"),
		entryTitle,
		body: pathKnowledgeBodySchema,
	}),
	z.object({
		kind: z.literal("decision"),
		entryTitle,
		body: decisionKnowledgeBodySchema,
	}),
	z.object({
		kind: z.literal("environment"),
		entryTitle,
		body: environmentKnowledgeBodySchema,
	}),
]);

export type KnowledgeEntryInput = z.input<typeof knowledgeEntrySchema>;
export type KnowledgeEntry = z.infer<typeof knowledgeEntrySchema>;
export type KnowledgeBody = KnowledgeEntry["body"];

export function parseKnowledgeEntry(value: unknown): KnowledgeEntry {
	const parsed = knowledgeEntrySchema.safeParse(value);
	if (!parsed.success) {
		const [issue] = parsed.error.issues;
		const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
		throw new Error(
			`Knowledge entry is invalid${where}: ${issue?.message ?? "unknown reason"}`,
		);
	}
	return parsed.data;
}

/**
 * The page a given entry belongs to, derived at write time so retrieval never
 * has to reach into `body`. Only the two kinds that carry a URL have one.
 */
export function pageKeyForEntry(entry: KnowledgeEntry): string | null {
	if (entry.kind === "page") return normalizePageKey(entry.body.url);
	if (entry.kind === "qa") return normalizePageKey(entry.body.page);
	return null;
}

/**
 * One active entry as the store and the API speak it. Retired entries are
 * never returned by retrieval, so this shape has no status: everything read
 * through here is current.
 */
export interface ProductKnowledgeRecord {
	id: string;
	kind: KnowledgeKind;
	title: string;
	body: KnowledgeBody;
	pageKey: string | null;
	sourceActivityId: string | null;
	supersedes: string | null;
	createdAt: string;
}
