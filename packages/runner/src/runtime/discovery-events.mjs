/**
 * The events the Discovery tools emit, parsed on their way out of the
 * container.
 *
 * They live apart from the runner because they are a contract between the
 * Discovery tools and the host, not runner mechanics: the runner only
 * carries them. Validation here is structural — the host re-validates every
 * knowledge body against src/knowledge.ts, which is the authority.
 */
import {
  identifier,
  isRecord,
  rejectUnknownKeys,
  requiredString,
} from "@shipbash/contracts/runtime/contract-values.mjs";
import { isHookRole, validateCaseRole } from "@shipbash/contracts/runtime/case-role-contract.mjs";
import { AGENT_KNOWLEDGE_KINDS } from "@shipbash/contracts/runtime/knowledge-contract.mjs";

/**
 * One parser per event name. Every event carries its own key set, so the
 * lookup replaces a chain of equality tests that could never match twice.
 */
const PARSE_BY_EVENT = new Map([
  ["knowledge_entry", (value, redactString) => {
    rejectUnknownKeys(
      value,
      new Set(["schemaVersion", "revision", "event", "kind", "title", "body", "supersedes"]),
      "activityProgress",
    );
    if (!AGENT_KNOWLEDGE_KINDS.includes(value.kind)) {
      throw new Error("Activity progress channel emitted an unsupported knowledge kind.");
    }
    if (!isRecord(value.body)) throw new Error("activityProgress.body must be an object.");
    return {
      event: "knowledge_entry",
      kind: value.kind,
      title: redactString(requiredString(value.title, "activityProgress.title", 120), 120),
      // The body already passed the Runner's structural check and is validated
      // again by the host's Zod schema, which is the authority; forwarding it
      // whole keeps this hop from becoming a third place to keep in step.
      body: value.body,
      supersedes: value.supersedes == null
        ? null
        : identifier(value.supersedes, "activityProgress.supersedes"),
    };
  }],
  ["choice_request", (value, redactString) => {
    rejectUnknownKeys(
      value,
      new Set(["schemaVersion", "revision", "event", "questionId", "prompt", "options", "allowFreeText"]),
      "activityProgress",
    );
    if (!Array.isArray(value.options) || value.options.length > 8) {
      throw new Error("activityProgress.options must be an array of at most 8 strings.");
    }
    if (typeof value.allowFreeText !== "boolean") {
      throw new Error("activityProgress.allowFreeText must be a boolean.");
    }
    return {
      event: "choice_request",
      questionId: identifier(value.questionId, "activityProgress.questionId"),
      prompt: redactString(requiredString(value.prompt, "activityProgress.prompt", 500), 500),
      options: value.options.map((option, index) => redactString(
        requiredString(option, `activityProgress.options[${String(index)}]`, 120),
        120,
      )),
      allowFreeText: value.allowFreeText,
    };
  }],
  ["choice_answered", (value, redactString) => {
    rejectUnknownKeys(
      value,
      new Set(["schemaVersion", "revision", "event", "questionId", "skipped", "option", "freeText", "note"]),
      "activityProgress",
    );
    return {
      event: "choice_answered",
      questionId: identifier(value.questionId, "activityProgress.questionId"),
      skipped: value.skipped === true,
      option: value.option == null
        ? null
        : redactString(requiredString(value.option, "activityProgress.option", 120), 120),
      freeText: value.freeText == null
        ? null
        : redactString(requiredString(value.freeText, "activityProgress.freeText", 2_000), 2_000),
      note: value.note == null
        ? null
        : redactString(requiredString(value.note, "activityProgress.note", 2_000), 2_000),
    };
  }],
  ["journey_upsert", (value, redactString) => {
    rejectUnknownKeys(
      value,
      new Set(["schemaVersion", "revision", "event", "journeyId", "title", "role", "journeyJson"]),
      "activityProgress",
    );
    return {
      event: "journey_upsert",
      journeyId: identifier(value.journeyId, "activityProgress.journeyId"),
      title: redactString(requiredString(value.title, "activityProgress.title", 500), 500),
      // The journey tools publish no role — a Journey; the hook tools name theirs.
      role: validateCaseRole(value.role, "activityProgress.role"),
      // The full definition already passed the Runner's structural check and
      // is validated again by the host's proposal path at round end; here it
      // only feeds the live view.
      journeyJson: redactString(requiredString(value.journeyJson, "activityProgress.journeyJson", 60_000), 60_000),
    };
  }],
  ["journey_removed", (value, redactString) => {
    rejectUnknownKeys(
      value,
      new Set(["schemaVersion", "revision", "event", "journeyId", "title", "role"]),
      "activityProgress",
    );
    return {
      event: "journey_removed",
      journeyId: identifier(value.journeyId, "activityProgress.journeyId"),
      title: redactString(requiredString(value.title, "activityProgress.title", 500), 500),
      role: validateCaseRole(value.role, "activityProgress.role"),
    };
  }],
  ["tool_error", (value, redactString) => {
    rejectUnknownKeys(
      value,
      new Set(["schemaVersion", "revision", "event", "tool", "message"]),
      "activityProgress",
    );
    return {
      event: "tool_error",
      tool: redactString(requiredString(value.tool, "activityProgress.tool", 64), 64),
      message: redactString(requiredString(value.message, "activityProgress.message", 500), 500),
    };
  }],
]);

/**
 * Returns the parsed event, or null when this event is not one of ours. The
 * runner hands in its own redaction for every free-text field.
 */
export function parseDiscoveryProgressEvent(event, value, redactString) {
  const parse = PARSE_BY_EVENT.get(event);
  if (!parse) return null;
  return parse(value, redactString);
}

/**
 * How each Discovery event surfaces to the host and, through it, the user.
 *
 * The Runner cannot reach the database, so a knowledge entry travels as an
 * event and the host persists it on consumption.
 */
const EMISSION_BY_EVENT = new Map([
  ["knowledge_entry", (update) => ({
    kind: "evidence",
    label: "Knowledge recorded",
    payload: {
      bodyMarkdown: update.title,
      safeData: {
        event: "knowledge_entry",
        phase: "progress",
        kind: update.kind,
        title: update.title,
        // The body is a nested document; safeData carries only primitives.
        bodyJson: JSON.stringify(update.body),
        supersedes: update.supersedes,
      },
    },
  })],
  ["choice_request", (update) => ({
    kind: "lifecycle",
    label: "Waiting for the user",
    payload: {
      bodyMarkdown: update.prompt,
      safeData: {
        event: "choice_request",
        phase: "progress",
        status: "waiting_for_input",
        questionId: update.questionId,
        prompt: update.prompt,
        // Same reason as the knowledge body: an array would be dropped, and
        // the console cannot offer a choice whose options never arrived.
        optionsJson: JSON.stringify(update.options),
        allowFreeText: update.allowFreeText,
      },
    },
  })],
  ["choice_answered", (update) => ({
    kind: "lifecycle",
    label: "The user answered",
    payload: {
      bodyMarkdown: update.skipped
        ? "The user skipped this question."
        : update.option ?? update.freeText ?? "",
      safeData: {
        event: "choice_answered",
        phase: "progress",
        status: "running",
        questionId: update.questionId,
        skipped: update.skipped,
        option: update.option,
        freeText: update.freeText,
        note: update.note,
      },
    },
  })],
  ["journey_upsert", (update) => ({
    kind: "evidence",
    label: isHookRole(update.role) ? "Hook proposed" : "Journey proposed",
    payload: {
      bodyMarkdown: update.title,
      safeData: {
        event: "journey_upsert",
        phase: "progress",
        journeyId: update.journeyId,
        title: update.title,
        role: update.role,
        journeyJson: update.journeyJson,
      },
    },
  })],
  ["journey_removed", (update) => ({
    kind: "evidence",
    label: isHookRole(update.role) ? "Hook removed" : "Journey removed",
    payload: {
      bodyMarkdown: update.title,
      safeData: {
        event: "journey_removed",
        phase: "progress",
        journeyId: update.journeyId,
        title: update.title,
        role: update.role,
      },
    },
  })],
  ["tool_error", (update) => ({
    kind: "warning",
    label: "Progress tool call rejected",
    payload: {
      bodyMarkdown: `${update.tool}: ${update.message}`,
      safeData: {
        event: "tool_error",
        phase: "progress",
        tool: update.tool,
        message: update.message,
      },
    },
  })],
]);

/** Returns the emission for one Discovery event, or null for anything else. */
export function discoveryEventEmission(update) {
  const emit = EMISSION_BY_EVENT.get(update.event);
  return emit ? emit(update) : null;
}
