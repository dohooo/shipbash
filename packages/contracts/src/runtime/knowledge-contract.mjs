/**
 * A structural mirror of the product-knowledge body shapes the agent writes.
 *
 * `src/knowledge.ts` is the authority: its Zod schemas validate every entry
 * on the host before it reaches the database, and the agent's field manual is
 * generated from their descriptions. This file exists only because it runs
 * inside the Runner without a bundle and must stay dependency-free — it
 * re-states the same required keys, types, and length caps by hand so the
 * agent gets an immediate, actionable error instead of discovering three tool
 * calls later that the host threw its entry away.
 *
 * The two must be changed together. When they disagree, the host wins: a body
 * that passes here and fails there is reported back as an `agent_warning`, not
 * a crashed run.
 */
import { isRecord, requiredString } from "./contract-values.mjs";
import { PUBLIC_PRODUCT_KNOWLEDGE_KIND_VALUES } from "./generated/db-vocabularies.mjs";

export const KNOWLEDGE_KINDS = PUBLIC_PRODUCT_KNOWLEDGE_KIND_VALUES;

const TEXT = "text";
const TEXT_LIST = "textList";
const BOOLEAN = "boolean";
const INTEGER = "integer";
const ENUM = "enum";

// Mirrors src/knowledge.ts for the kinds the agent writes: qa entries are the
// harness's record of the owner's answers, written on the host and never here.
// `nullable` fields accept null or omission and normalize to null; list fields
// accept omission and normalize to [].
const BODY_RULES = Object.freeze({
	page: [
		{ key: "url", type: TEXT, max: 500 },
		{ key: "purpose", type: TEXT, max: 600 },
		{ key: "keyActions", type: TEXT_LIST, maxItems: 10, itemMax: 120 },
		{ key: "reachedVia", type: TEXT, max: 300 },
		{ key: "openQuestions", type: TEXT_LIST, maxItems: 5, itemMax: 300 },
	],
	path: [
		{ key: "steps", type: TEXT_LIST, maxItems: 60, itemMax: 300, minItems: 1 },
		{ key: "outcome", type: TEXT, max: 400 },
		{
			key: "durationSeconds",
			type: INTEGER,
			min: 0,
			max: 86_400,
			nullable: true,
		},
		{ key: "becameJourney", type: BOOLEAN },
	],
	decision: [
		{ key: "context", type: TEXT, max: 500 },
		{ key: "chose", type: TEXT, max: 300 },
		{ key: "reason", type: TEXT, max: 500 },
		{ key: "userConfirmed", type: BOOLEAN },
	],
	environment: [
		{ key: "capability", type: TEXT, max: 300 },
		{ key: "how", type: TEXT, max: 2_000 },
		{ key: "providedBy", type: ENUM, values: ["user", "agent"] },
		{ key: "appliesTo", type: TEXT_LIST, maxItems: 10, itemMax: 120 },
	],
});

/** The kinds the agent may record: every kind but qa. */
export const AGENT_KNOWLEDGE_KINDS = Object.freeze(Object.keys(BODY_RULES));

/**
 * A list field: omission means an empty list, and every entry must be a
 * non-empty string within the rule's count and length caps.
 *
 * @param {{ minItems?: number, maxItems: number, itemMax: number }} rule
 * @param {unknown} raw
 * @param {string} field
 * @param {boolean} absent whether `raw` was omitted or null
 * @returns {string[]}
 */
function readTextListField(rule, raw, field, absent) {
	const items = absent ? [] : raw;
	if (!Array.isArray(items))
		throw new Error(`${field} must be an array of strings.`);
	if (rule.minItems && items.length < rule.minItems) {
		throw new Error(
			`${field} must contain at least ${String(rule.minItems)} entries.`,
		);
	}
	if (items.length > rule.maxItems) {
		throw new Error(
			`${field} must contain at most ${String(rule.maxItems)} entries.`,
		);
	}
	return items.map((item, index) =>
		requiredString(item, `${field}[${String(index)}]`, rule.itemMax),
	);
}

function readField(rule, raw, field) {
	const absent = raw === undefined || raw === null;
	if (rule.type === TEXT_LIST) {
		return readTextListField(rule, raw, field, absent);
	}
	if (absent) {
		if (!rule.nullable) throw new Error(`${field} is required.`);
		return null;
	}
	if (rule.type === TEXT) return requiredString(raw, field, rule.max);
	if (rule.type === BOOLEAN) {
		if (typeof raw !== "boolean")
			throw new Error(`${field} must be a boolean.`);
		return raw;
	}
	if (rule.type === INTEGER) {
		if (!Number.isSafeInteger(raw) || raw < rule.min || raw > rule.max) {
			throw new Error(
				`${field} must be an integer between ${String(rule.min)} and ${String(rule.max)}.`,
			);
		}
		return raw;
	}
	const text = requiredString(raw, field, 64);
	if (!rule.values.includes(text)) {
		throw new Error(`${field} must be one of: ${rule.values.join(", ")}.`);
	}
	return text;
}

/**
 * Validates and normalizes one knowledge body, returning the exact object that
 * will be handed to the host. Throws with a message the agent can act on.
 */
// Field names agents reach for that mean the same thing as a canonical field.
// Accepted on the way in and normalized before validation, so one misremembered
// name does not cost an entry; the host only ever sees canonical fields.
const FIELD_ALIASES = Object.freeze({
	page: {
		reachedFrom: "reachedVia",
		reached_via: "reachedVia",
		actions: "keyActions",
	},
	path: {
		finalState: "outcome",
		result: "outcome",
		wasJourney: "becameJourney",
		candidateJourney: "becameJourney",
		deservesJourney: "becameJourney",
	},
	decision: { decision: "chose", choice: "chose", why: "reason" },
	environment: { appliedTo: "appliesTo" },
});

export function validateKnowledgeBody(kind, value) {
	const rules = BODY_RULES[kind];
	if (!rules) {
		throw new Error(
			`kind must be one of: ${AGENT_KNOWLEDGE_KINDS.join(", ")}. The owner's answers are recorded as qa for you; do not record them.`,
		);
	}
	if (!isRecord(value)) throw new Error("body must be an object.");
	const aliases = FIELD_ALIASES[kind] ?? {};
	const allowed = new Set(rules.map((rule) => rule.key));
	const normalized = {};
	for (const [key, raw] of Object.entries(value)) {
		const canonical = allowed.has(key) ? key : aliases[key];
		if (!canonical) {
			throw new Error(
				`body.${key} is not a field of a ${kind} entry. Fields: ${[...allowed].join(", ")}.`,
			);
		}
		if (canonical in normalized) {
			throw new Error(`body.${key} duplicates body.${canonical}.`);
		}
		normalized[canonical] = raw;
	}
	value = normalized;
	const body = {};
	for (const rule of rules) {
		body[rule.key] = readField(rule, value[rule.key], `body.${rule.key}`);
	}
	return body;
}

/**
 * Renders each kind's body fields for the recording tool's description, from
 * the same rules the validator enforces — the spec the agent reads and the
 * spec that judges it can never drift apart.
 */
export function describeKnowledgeBodyFields() {
	const label = (rule) => {
		if (rule.type === TEXT_LIST) return `${rule.key} (string[])`;
		if (rule.type === BOOLEAN) return `${rule.key} (boolean)`;
		if (rule.type === INTEGER)
			return `${rule.key} (integer${rule.nullable ? ", optional" : ""})`;
		if (rule.type === ENUM)
			return `${rule.key} ('${rule.values.join("'|'")}')`;
		return `${rule.key}${rule.nullable ? " (optional)" : ""}`;
	};
	return Object.entries(BODY_RULES)
		.map(([kind, rules]) => `${kind}: ${rules.map(label).join(", ")}`)
		.join("; ");
}
