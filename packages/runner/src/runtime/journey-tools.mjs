/**
 * The Journey tools of the kinds that converse (Discovery, a conversation):
 * the list is written as the agent walks, not composed at the end. The store
 * is one JSON file on the persistent session mount, so it survives auth
 * parks and wakes with the conversation; the host reseeds it before every leg, so what list_journeys
 * returns is the list as it stands.
 *
 * Every mutation also rides the progress channel (journey_upsert /
 * journey_removed), which is how the owner watches the list grow live. The
 * round's closing result document is built FROM this store — the tools are
 * the only way a Journey exists.
 *
 * When the project already has an approved Suite, the host seeds the store
 * from it before the first leg: those entries carry `origin: "suite"` and the
 * Case id they stand for, so the agent reads the approved list as its
 * baseline and adds beyond it. An approved entry is read-only here — neither
 * refined nor removed: a Discovery adds to the owner's list, it does not
 * rewrite or retire it (journey-proposal.mjs turns the store back into a
 * change_suite that keeps every Case id); a change the walk proved to one is
 * staged with propose_edit (edit-tools.mjs), and lands once a walk proves it
 * and the owner keeps it.
 */
import { agentServices } from "@shipbash/contracts/runtime/agent-model.mjs";
import { isRecord as record, requiredString as text } from "@shipbash/contracts/runtime/contract-values.mjs";
import {
  CASE_REPEATS, JOURNEY_ROLE, MAX_CASE_CHECKPOINTS, MIN_JOURNEY_CHECKPOINTS, assertCheckpointCount, isHookRole, validateCaseRepeat,
} from "@shipbash/contracts/runtime/case-role-contract.mjs";
import { assertJourneyTitle } from "@shipbash/contracts/runtime/journey-grammar.mjs";
import { scopedHooksRefusal } from "./hook-tools.mjs";
import { GOAL_DESCRIPTION, STEPS_DESCRIPTION, TITLE_DESCRIPTION, unquotedTextNote } from "./journey-writing.mjs";
import { appendProgressEvent } from "./progress-events.mjs";

// Above this the list stops being a Journey list at all. There is no soft
// target: the product's structure decides the count.
export const JOURNEY_HARD_LIMIT = 20;

const JOURNEY_FIELD_KEYS = new Set([
  "title",
  "category",
  "steps",
  "checkpoints",
  "preconditions",
  "whyItMatters",
  "repeat",
]);

// What list_journeys shows on an entry beyond its fields. An agent handing an
// entry back whole is not naming a new field: these are dropped, not refused,
// and update_journey's schema admits them for the same reason.
const JOURNEY_ECHO_KEYS = new Set(["id", "origin", "caseId", "role", "scopeJourneyId", "ownerConfirmation"]);
const JOURNEY_ECHO_PROPERTIES = {
  origin: { type: "string", description: "As list_journeys shows it; read-only, ignored here." },
  caseId: { type: "string", description: "As list_journeys shows it; read-only, ignored here." },
  role: { type: "string", description: "As list_journeys shows it; a Journey's role is journey, ignored here." },
};
const REPEAT_PROPERTY = { type: "string", enum: [...CASE_REPEATS], description: "repeatable: every run walks it (the default). "
  + "one_time: walked once, kept but left out of runs. Set it only as the owner ruled; left out, the Journey keeps what it has." };

/** The states a Journey's tool arguments say it needs: one, a list of at most 10, or none. */
function journeyPreconditions(value) {
  if (value === undefined) return [];
  const preconditions = (Array.isArray(value) ? value : [value])
    .map((entry, index) => text(entry, `preconditions[${String(index)}]`, 500));
  if (preconditions.length > 10) throw new Error("preconditions must contain at most 10 states.");
  return preconditions;
}

/**
 * One validated Journey from tool arguments; mirrors the host's candidate shape. The caller's role sets the checkpoint minimum: the hook tools pass the slot theirs was added under.
 * A Journey's title is held to the title rule, unless it is the title of `current`, the entry this replaces, which may stay as long as it was stored.
 * @param {string} [role]
 * @param {{ title: string } | null} [current]
 */
export function validateJourneyInput(args, role = JOURNEY_ROLE, current = null) {
  if (!record(args)) throw new Error("Journey must be an object.");
  const unknown = Object.keys(args).filter((key) => !JOURNEY_ECHO_KEYS.has(key) && !JOURNEY_FIELD_KEYS.has(key));
  if (unknown.length) throw new Error(`Unknown Journey field: ${unknown[0]}.`);
  const title = text(args.title, "title", 500);
  if (role === JOURNEY_ROLE) assertJourneyTitle(title, "title", current?.title ?? null);
  const category = text(args.category, "category", 120);
  if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > 40) {
    throw new Error("steps must contain between 1 and 40 instructions.");
  }
  const steps = args.steps.map((step, index) => text(step, `steps[${String(index)}]`, 2_000));
  if (!Array.isArray(args.checkpoints)) throw new Error("checkpoints must be a list of {goal, afterStep} objects.");
  assertCheckpointCount(args.checkpoints.length, role, "checkpoints");
  const checkpoints = args.checkpoints.map((checkpoint, index) => {
    const field = `checkpoints[${String(index)}]`;
    if (!record(checkpoint)) throw new Error(`${field} must be a {goal, afterStep} object.`);
    const afterStep = checkpoint.afterStep;
    if (
      afterStep !== null
      && (!Number.isSafeInteger(afterStep) || Number(afterStep) < 1 || Number(afterStep) > steps.length)
    ) {
      throw new Error(`${field}.afterStep must be null or a step number between 1 and ${String(steps.length)}.`);
    }
    return { goal: text(checkpoint.goal, `${field}.goal`, 1_000), afterStep: afterStep === null ? null : Number(afterStep) };
  });
  const preconditions = journeyPreconditions(args.preconditions);
  return {
    title,
    category,
    steps,
    checkpoints,
    preconditions,
    whyItMatters: args.whyItMatters == null ? null : text(args.whyItMatters, "whyItMatters", 300),
    ...(role === JOURNEY_ROLE && args.repeat !== undefined ? { repeat: validateCaseRepeat(args.repeat, "repeat") } : {}),
  };
}

/** The empty store; also the parse fallback for a corrupt or absent file. */
export function emptyJourneyStore() {
  return { productThesis: null, suite: null, nextId: 1, journeys: [] };
}

/**
 * The approved Suite the store was seeded from, when the host named one; the
 * revision it was seeded at is the host's own bookkeeping and rides along.
 */
function parseStoreSuite(value) {
  if (!record(value) || typeof value.id !== "string" || typeof value.name !== "string") return null;
  return {
    id: value.id,
    name: value.name,
    ...(Number.isSafeInteger(value.definitionRevision) ? { definitionRevision: value.definitionRevision } : {}),
  };
}

export function parseJourneyStore(contents) {
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    return emptyJourneyStore();
  }
  if (!record(value) || !Array.isArray(value.journeys)) return emptyJourneyStore();
  const journeys = value.journeys.filter((journey) => record(journey) && typeof journey.id === "string");
  const highest = journeys.reduce((max, journey) => {
    const match = /^j(\d+)$/u.exec(journey.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return {
    productThesis: typeof value.productThesis === "string" ? value.productThesis : null,
    suite: parseStoreSuite(value.suite),
    // The host's bookkeeping — which lineage record the store was seeded
    // against — rides through every save untouched.
    ...(record(value.seededFor) ? { seededFor: value.seededFor } : {}),
    nextId: Math.max(Number.isSafeInteger(value.nextId) ? /** @type {number} */ (value.nextId) : 1, highest + 1),
    journeys,
  };
}

/** True for an entry the host seeded from the approved Suite. */
export function isApprovedJourney(journey) {
  return journey.origin === "suite" && typeof journey.caseId === "string";
}

/**
 * The opening line that names the list a Discovery leg starts on: a waking
 * leg is reminded it may have changed; a fresh leg learns what the
 * host seeded — the owner's approved Journeys as the baseline to add beyond,
 * and the entries a retried attempt left. Null when a fresh leg starts empty.
 * @param {ReturnType<typeof parseJourneyStore>} store
 * @param {boolean} resumed
 */
export function journeyListOpeningLine(store, resumed) {
  const titled = (journeys) => journeys.map((journey, index) => `${String(index + 1)}. ${journey.title}`).join(" ");
  const journeys = store.journeys.filter((journey) => !isHookEntry(journey));
  if (resumed) {
    if (!journeys.length) return "The Journey list is currently empty.";
    return `Journeys currently on the list: ${titled(journeys)} — they may have changed while you slept; call list_journeys with detail full for the current definitions before changing any.`;
  }
  const approved = journeys.filter(isApprovedJourney);
  const working = journeys.filter((journey) => !isApprovedJourney(journey));
  return [
    approved.length
      ? `Journeys the owner already approved for this product are on the list as origin "suite": ${titled(approved)} — the baseline you add beyond, not proposals to repeat; call list_journeys with detail full for their definitions and add only the goals they do not cover.`
      : "",
    working.length
      ? `Journeys already on the list from the previous attempt: ${titled(working)} — continue from them; call list_journeys with detail full for their definitions before changing any.`
      : "",
  ].filter(Boolean).join(" ") || null;
}

function journeySummaryLine(store) {
  const count = store.journeys.filter((journey) => !isHookEntry(journey)).length;
  return `The list now holds ${String(count)} Journey${count === 1 ? "" : "s"}.`;
}

/** The input schema properties of a Journey, fresh on every call; the hook tools reuse them. */
export function journeyInputProperties() {
  return {
    title: { type: "string", minLength: 1, maxLength: 500 },
    category: { type: "string", minLength: 1, maxLength: 120 },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 40,
      items: { type: "string", minLength: 1, maxLength: 2_000 },
      description: STEPS_DESCRIPTION,
    },
    checkpoints: {
      type: "array",
      minItems: MIN_JOURNEY_CHECKPOINTS,
      maxItems: MAX_CASE_CHECKPOINTS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          goal: { type: "string", minLength: 1, maxLength: 1_000, description: GOAL_DESCRIPTION },
          afterStep: { type: ["integer", "null"], description: "1-based step this goal was observed after; null when the state already holds before step 1." },
        },
        required: ["goal", "afterStep"],
      },
    },
    preconditions: {
      type: "array",
      maxItems: 10,
      items: { type: "string", minLength: 1, maxLength: 500 },
      description: "Checkable states the Journey needs before step 1 and does not create. Empty when it builds everything itself.",
    },
    whyItMatters: {
      type: ["string", "null"],
      maxLength: 300,
      description: "Why a release must keep this alive. If every run reaches someone outside the account — an email, a text, an invitation — say so here: the owner approves the repetition, not the one walk.",
    },
  };
}

export function journeyToolDefinitions() {
  const properties = journeyInputProperties();
  const journeyProperties = { ...properties, title: { ...properties.title, description: TITLE_DESCRIPTION } };
  return [
    {
      name: "add_journey",
      description:
        "Add one User Journey to the proposal the moment a walked path proves it — the owner sees it appear live. "
        + "Steps are the user's own actions toward the goal, each one you executed — never your own preparation, checks or cleanup; what a Journey needs prepared or cleared is a hook (add_hook); the final checkpoint asserts, in the observed words, the state the user came for — a change made, or a page confirmed right: its sections, controls, and empty states in place, what it shows checked against the knowledge record or another surface. "
        + "Every surface has at least that read-only Journey — an approved one (origin \"suite\") counts, so do not propose it again; a write flow you cannot complete exempts the flow, never the surface. "
        + "Returns the Journey's id for later update_journey / remove_journey calls, and names each step that types text it does not quote.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { ...journeyProperties, repeat: REPEAT_PROPERTY },
        required: ["title", "category", "steps", "checkpoints"],
      },
    },
    {
      name: "update_journey",
      description:
        "Replace one Journey on the list with its refined definition — provide the complete Journey, not a diff. "
        + "Use it when a later walk sharpens steps or checkpoints, or when reviewing the list before you stop. "
        + "A Journey with origin \"suite\" is one of the owner's approved Journeys and is read-only here: when your walk proved it wrong, stage the change to it with propose_edit.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string", minLength: 1, maxLength: 64 }, ...journeyProperties, ...JOURNEY_ECHO_PROPERTIES, repeat: REPEAT_PROPERTY },
        required: ["id", "title", "category", "steps", "checkpoints"],
      },
    },
    {
      name: "remove_journey",
      description:
        "Remove one Journey from the list — when it turned out to overlap another, or to be a fragment short of a whole user goal; a read-only Journey that confirms a surface's page is right is a whole goal, not a fragment. "
        + "A Journey with origin \"suite\" is one of the owner's approved Journeys and cannot be removed here.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
        required: ["id"],
      },
    },
    {
      name: "set_product_thesis",
      description:
        "Record the product thesis: at most 600 characters on what the product is, its core value actions, and its funnel. Overwrites the previous thesis.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { thesis: { type: "string", minLength: 1, maxLength: 600 } },
        required: ["thesis"],
      },
    },
  ];
}

export const JOURNEY_TOOL_NAMES = Object.freeze([
  "add_journey",
  "update_journey",
  "remove_journey",
  "set_product_thesis",
]);

/** The store entry the agent named, by its working id. */
function indexOfJourney(store, args) {
  const id = text(args?.id, "id", 64);
  const index = store.journeys.findIndex((journey) => journey.id === id);
  if (index === -1) throw new Error(`No Journey with id ${id}. Call list_journeys for the current list.`);
  return { id, index };
}

/** True for a setup/teardown hook on the list; the journey tools leave those alone. */
export function isHookEntry(journey) {
  return typeof journey.role === "string" && isHookRole(journey.role);
}

/** The refusal a hook answers to a Journey tool: it is not a Journey. */
function hookRefusal(id) {
  return new Error(
    `${id} is a setup/teardown hook around the run, not a User Journey; `
    + "the Journey tools leave it alone — use update_hook / remove_hook for it.",
  );
}

async function addJourney(store, args, session) {
  if (store.journeys.filter((journey) => !isHookEntry(journey)).length >= JOURNEY_HARD_LIMIT) {
    throw new Error(`The list already holds ${String(JOURNEY_HARD_LIMIT)} Journeys. Curate with update_journey / remove_journey instead of adding more.`);
  }
  const journey = { id: `j${String(store.nextId)}`, ...validateJourneyInput(args) };
  store.nextId += 1;
  store.journeys.push(journey);
  await session.save();
  await session.publish("journey_upsert", { journeyId: journey.id, title: journey.title, journeyJson: JSON.stringify(journey) });
  return [`Journey ${journey.id} added. ${journeySummaryLine(store)}`, await unquotedTextNote(journey.steps, agentServices(process.env).jev)].filter(Boolean).join(" ");
}

/** The refusal an approved entry answers to a change: it is staged, or the Journeys page owns it. */
function approvedJourneyRefusal(store, id, remedy) {
  return new Error(
    `Journey ${id} is an approved Journey of the "${store.suite?.name ?? "current"}" Suite. `
    + `This list adds beyond the approved Journeys and never rewrites or retires one: ${remedy}.`,
  );
}

async function updateJourney(store, args, session) {
  const { id, index } = indexOfJourney(store, args);
  if (isHookEntry(store.journeys[index])) throw hookRefusal(id);
  if (isApprovedJourney(store.journeys[index])) {
    throw approvedJourneyRefusal(store, id, `stage your change to it with propose_edit and caseId ${String(store.journeys[index].caseId)}: it lands once a walk proves it and the owner keeps it`);
  }
  // The content fields are replaced; the role the host wrote onto the entry
  // stays, and so does repeat (the owner's ruling) unless this call sets it.
  const journey = { ...store.journeys[index], ...validateJourneyInput(args, JOURNEY_ROLE, store.journeys[index]) };
  store.journeys[index] = journey;
  await session.save();
  await session.publish("journey_upsert", { journeyId: id, title: journey.title, journeyJson: JSON.stringify(journey) });
  return `Journey ${id} updated.`;
}

async function removeJourney(store, args, session) {
  const { id, index } = indexOfJourney(store, args);
  if (isHookEntry(store.journeys[index])) throw hookRefusal(id);
  if (isApprovedJourney(store.journeys[index])) {
    throw approvedJourneyRefusal(store, id, "leave it in place and add what it does not cover; the owner removes approved Journeys on the Journeys page");
  }
  const around = scopedHooksRefusal(store, id);
  if (around) throw around;
  const [removed] = store.journeys.splice(index, 1);
  await session.save();
  await session.publish("journey_removed", { journeyId: id, title: removed.title });
  return `Journey ${id} removed. ${journeySummaryLine(store)}`;
}

async function setProductThesis(store, args, session) {
  store.productThesis = text(args?.thesis, "thesis", 600);
  await session.save();
  return "Product thesis recorded.";
}

const JOURNEY_TOOL_RUNNERS = Object.freeze({
  add_journey: addJourney,
  update_journey: updateJourney,
  remove_journey: removeJourney,
  set_product_thesis: setProductThesis,
});

/**
 * Runs one Journey tool — or, given a runner, a hook tool on the same
 * store. `io` carries the file primitives and the progress channel (append +
 * nextRevision), exactly like the knowledge tools.
 */
export async function runJourneyTool(name, args, io, runner = JOURNEY_TOOL_RUNNERS[name]) {
  const { storePath, eventPath, append, readControlFile, writeControlFile, nextRevision } = io;
  const store = parseJourneyStore(await readControlFile(storePath, "utf8").catch(() => ""));
  const session = {
    save: () => writeControlFile(storePath, `${JSON.stringify(store)}\n`, { encoding: "utf8", mode: 0o600 }),
    publish: (event, journey) => appendProgressEvent(append, eventPath, { revision: nextRevision(), event, ...journey }),
  };
  return runner(store, args, session);
}
