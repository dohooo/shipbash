/**
 * The Discovery agent's run-hook tools: a setup or teardown hook around
 * the run, written into the same Journey store the journey tools keep
 * (journey-tools.mjs) under one of four roles — before_all / after_all once
 * per run, before_each / after_each around every Journey or the one Journey
 * the hook names by its working id. One array, not two: a second array
 * would be one more place for a whole batch to die silently on reseed.
 *
 * A hook is not a Journey. The journey tools refuse it and point here;
 * these refuse a Journey and point back. An approved hook (origin
 * "suite") is read-only exactly as an approved Journey is.
 *
 * Every hook declares who has to confirm it: data this walk created is
 * the agent's to clear (not_needed); the owner's data, or a reset path the
 * owner taught, is asked first through request_choice (confirmed) or, when
 * the question could not be asked, left pending for the review page.
 */
import { agentServices } from "@shipbash/contracts/runtime/agent-model.mjs";
import { isRecord as record, requiredString as text } from "@shipbash/contracts/runtime/contract-values.mjs";
import {
  MIN_HOOK_CHECKPOINTS,
  OWNER_CONFIRMATIONS,
  PER_JOURNEY_ROLES,
  SUITE_LEVEL_ROLES,
  assertScopeAllowed,
  hookCategory,
  validateOwnerConfirmation,
} from "@shipbash/contracts/runtime/case-role-contract.mjs";
import {
  isHookEntry,
  isApprovedJourney,
  journeyInputProperties,
  runJourneyTool,
  validateJourneyInput,
} from "./journey-tools.mjs";
import { HOOK_STEPS_DESCRIPTION, unquotedTextNote } from "./journey-writing.mjs";

const HOOK_ROLES = Object.freeze([...SUITE_LEVEL_ROLES, ...PER_JOURNEY_ROLES]);

function hookRole(value) {
  const role = HOOK_ROLES.find((entry) => entry === value);
  if (!role) throw new Error(`role must be one of ${HOOK_ROLES.join(", ")}.`);
  return role;
}

function ownerConfirmationOf(value) {
  if (value === undefined || value === null) {
    throw new Error(`ownerConfirmation is required: one of ${OWNER_CONFIRMATIONS.join(", ")}.`);
  }
  return validateOwnerConfirmation(value, "ownerConfirmation");
}

/** The working id of the Journey a per-journey hook is around, held to a Journey on the list. */
function scopeOf(store, role, value) {
  if (value === undefined || value === null) return null;
  assertScopeAllowed(role, "scopeJourneyId");
  const id = text(value, "scopeJourneyId", 64);
  const target = store.journeys.find((journey) => journey.id === id);
  if (!target) throw new Error(`scopeJourneyId names ${id}, which is not on the list. Call list_journeys for the current ids.`);
  if (isHookEntry(target)) throw new Error(`scopeJourneyId must name a Journey; ${id} is a hook.`);
  return id;
}

/**
 * One validated hook from tool arguments: the Journey fields under the
 * category its role derives (a category handed back whole from
 * list_journeys is dropped, never refused), plus its role fields.
 */
export function validateHookInput(store, args) {
  if (!record(args)) throw new Error("Hook must be an object.");
  const role = hookRole(args.role);
  const scopeJourneyId = scopeOf(store, role, args.scopeJourneyId);
  const ownerConfirmation = ownerConfirmationOf(args.ownerConfirmation);
  return {
    ...validateJourneyInput({ ...args, category: hookCategory(role) }, role),
    role,
    ...(scopeJourneyId === null ? {} : { scopeJourneyId }),
    ownerConfirmation,
  };
}

/** The hooks on the list whose scope names this Journey's working id. */
export function hooksScopedTo(store, journeyId) {
  return store.journeys.filter((entry) => isHookEntry(entry) && entry.scopeJourneyId === journeyId);
}

/**
 * The refusal a Journey with hooks around it answers to remove_journey, or
 * null when nothing is around it: a dangling scope would fail the whole
 * delivery at round end, so the hooks go first — removed, or pointed at
 * another Journey.
 */
export function scopedHooksRefusal(store, journeyId) {
  const around = hooksScopedTo(store, journeyId);
  if (!around.length) return null;
  const named = around.map((hook) => `${hook.id} (${hook.title})`).join(", ");
  return new Error(
    `Journey ${journeyId} has hooks around it: ${named}. `
    + `A Journey leaves the list with nothing scoped to it: remove each with remove_hook, or point it at another Journey with update_hook, then remove ${journeyId}.`,
  );
}

function hookSummaryLine(store) {
  const count = store.journeys.filter(isHookEntry).length;
  return `The list now holds ${String(count)} hook${count === 1 ? "" : "s"}.`;
}

const WHO_MAY_ADD =
  "Who adds one: a hook that touches only data this run created is added directly (ownerConfirmation not_needed); "
  + "one that touches the owner's data, or walks a reset path the owner told you about, is asked first with request_choice — "
  + "confirmed when the owner said yes, pending when the question could not be asked, so the review page asks it.";

export function hookToolDefinitions() {
  const journey = journeyInputProperties();
  const hookProperties = {
    role: {
      type: "string",
      enum: [...HOOK_ROLES],
      description: "before_all / after_all: once per run. before_each / after_each: around every Journey, or around the one scopeJourneyId names.",
    },
    title: journey.title,
    steps: { ...journey.steps, description: HOOK_STEPS_DESCRIPTION },
    checkpoints: {
      ...journey.checkpoints,
      minItems: MIN_HOOK_CHECKPOINTS,
      description: "The state the hook leaves, in the observed words — one goal when one sentence says it; never a step that ran on the way.",
    },
    preconditions: journey.preconditions,
    whyItMatters: {
      type: ["string", "null"],
      maxLength: 300,
      description: "What runs dirty without it — the Journey that would inherit leftovers, or the state a Journey cannot start from twice.",
    },
    scopeJourneyId: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      description: "before_each / after_each only: the working id of the Journey this hook is around. Absent means every Journey.",
    },
    ownerConfirmation: {
      type: "string",
      enum: [...OWNER_CONFIRMATIONS],
      description: "not_needed: only data this run created. confirmed: the owner said yes in this round. pending: the owner's data or reset path, not yet asked.",
    },
  };
  const echoProperties = {
    origin: { type: "string", description: "As list_journeys shows it; read-only, ignored here." },
    caseId: { type: "string", description: "As list_journeys shows it; read-only, ignored here." },
    category: { type: "string", description: "As list_journeys shows it; derived from the role, ignored here." },
    repeat: { type: "string", description: "As list_journeys shows it; a hook has no repeat of its own, ignored here." },
  };
  return [
    {
      name: "add_hook",
      description:
        "Add one setup or teardown hook around the run — the owner sees it appear live. "
        + "Four slots: before_all / after_all once per run; before_each / after_each around every Journey, or around one Journey only when scopeJourneyId names it. "
        + "A Journey that creates something gets an after_each scoped to it that deletes what a failed walk leaves behind, by the run-id name the data carries; "
        + "a reset path an environment entry names is a before_each scoped to the Journey whose precondition it produces. "
        + `${WHO_MAY_ADD} `
        + "Steps are how you reached the state, each one you executed, your own setup commands included; what a Journey needs prepared is a before_each scoped to it; the category is derived from the role. "
        + "Returns the hook's id for later update_hook / remove_hook calls, and names each step that types text it does not quote.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: hookProperties,
        required: ["role", "title", "steps", "checkpoints", "ownerConfirmation"],
      },
    },
    {
      name: "update_hook",
      description:
        "Replace one hook on the list with its refined definition — provide the complete hook, not a diff. "
        + "A hook with origin \"suite\" is one of the owner's approved hooks and is read-only here: when your walk proved it wrong, stage the change to it with propose_edit. "
        + "A Journey is refined with update_journey, never here.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string", minLength: 1, maxLength: 64 }, ...hookProperties, ...echoProperties },
        required: ["id", "role", "title", "steps", "checkpoints", "ownerConfirmation"],
      },
    },
    {
      name: "remove_hook",
      description:
        "Remove one hook from the list — when the Journey it served is gone, or it overlaps another. "
        + "A hook with origin \"suite\" is one of the owner's approved hooks and cannot be removed here. "
        + "A Journey is removed with remove_journey, never here.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
        required: ["id"],
      },
    },
  ];
}

export const HOOK_TOOL_NAMES = Object.freeze(["add_hook", "update_hook", "remove_hook"]);

/** The refusal an approved hook answers to a change: it is staged, or the Journeys page owns it. */
function approvedHookRefusal(store, id, remedy) {
  return new Error(
    `Hook ${id} is an approved hook of the "${store.suite?.name ?? "current"}" Suite. `
    + `Discovery adds beyond the approved list and never rewrites or retires it: ${remedy}.`,
  );
}

/** The store entry the agent named, held to a hook it may change; `remedy` says what to do instead with an approved one, by its Case id. */
function indexOfHook(store, args, remedy) {
  const id = text(args?.id, "id", 64);
  const index = store.journeys.findIndex((journey) => journey.id === id);
  if (index === -1) throw new Error(`No hook with id ${id}. Call list_journeys for the current list.`);
  const entry = store.journeys[index];
  if (!isHookEntry(entry)) {
    throw new Error(`${id} is a User Journey, not a hook; use update_journey / remove_journey for it.`);
  }
  if (isApprovedJourney(entry)) throw approvedHookRefusal(store, id, remedy(entry.caseId));
  return { id, index };
}

function upsertEvent(hook) {
  return { journeyId: hook.id, title: hook.title, role: hook.role, journeyJson: JSON.stringify(hook) };
}

async function addHook(store, args, session) {
  const hook = { id: `j${String(store.nextId)}`, ...validateHookInput(store, args) };
  store.nextId += 1;
  store.journeys.push(hook);
  await session.save();
  await session.publish("journey_upsert", upsertEvent(hook));
  return [`Hook ${hook.id} added. ${hookSummaryLine(store)}`, await unquotedTextNote(hook.steps, agentServices(process.env).jev)].filter(Boolean).join(" ");
}

async function updateHook(store, args, session) {
  const { id, index } = indexOfHook(store, args, (caseId) => `stage your change to it with propose_edit and caseId ${String(caseId)}: it lands once a walk proves it and the owner keeps it`);
  // The content and role fields are replaced — a scope left out is cleared —
  // and a repeat the entry carries stays as it was, as update_journey keeps
  // one it is not handed: dropped here, it would be dropped at delivery.
  const { scopeJourneyId: _replaced, ...held } = store.journeys[index];
  const hook = { ...held, id, ...validateHookInput(store, args) };
  store.journeys[index] = hook;
  await session.save();
  await session.publish("journey_upsert", upsertEvent(hook));
  return `Hook ${id} updated.`;
}

async function removeHook(store, args, session) {
  const { id, index } = indexOfHook(store, args, () => "leave it in place and add what it does not cover; the owner removes approved hooks on the Journeys page");
  const [removed] = store.journeys.splice(index, 1);
  await session.save();
  await session.publish("journey_removed", { journeyId: id, title: removed.title, role: removed.role });
  return `Hook ${id} removed. ${hookSummaryLine(store)}`;
}

const HOOK_TOOL_RUNNERS = Object.freeze({
  add_hook: addHook,
  update_hook: updateHook,
  remove_hook: removeHook,
});

/** Runs one hook tool on the Journey store through the journey tools' own io. */
export function runHookTool(name, args, io) {
  const runner = HOOK_TOOL_RUNNERS[name];
  return runner ? runJourneyTool(name, args, io, runner) : null;
}
