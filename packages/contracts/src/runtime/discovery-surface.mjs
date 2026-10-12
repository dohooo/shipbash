import { SCENARIOS } from "./capabilities.mjs";

/**
 * How an Activity kind relates to its owner, beside the tools the capability
 * table gives it (capabilities.mjs).
 *
 * The kinds that converse — Discovery, a conversation with the owner in a
 * chat, and the walks that conversation starts — have an owner who answers
 * mid-run: Discovery and a walk stop mid-walk on a question and wait for the
 * answer, Discovery on its page, a walk through the conversation that started
 * it, whose agent asks in the chat and answers with tell_walk; their rounds
 * end on a closing message. The other kinds run unattended and deliver a
 * document. A conversation is a chat and runs on the host, not in a Sandbox
 * (HOST_KINDS). A walk's closing words are its report to the conversation,
 * posted as the agent said them.
 */
const INTERACTIVE_KINDS = new Set(["initial_discovery", "conversation", "walk"]);
const CHAT_KINDS = new Set(["conversation", "walk"]);
/** The kinds whose legs run on the host, in-process, never in a Sandbox. */
export const HOST_KINDS = Object.freeze(Object.entries(SCENARIOS).filter(([, scenario]) => scenario.runs === "host").map(([kind]) => kind));

export function activityKnowledgeSurface(kind) {
  return {
    interacts: INTERACTIVE_KINDS.has(kind),
    /** A leg of the owner's chat — the conversation, or a walk it started: its words go to the chat as they are. */
    inChat: CHAT_KINDS.has(kind),
  };
}

/**
 * The Prompt contract an Activity kind runs under: Discovery, a conversation
 * and a walk have their own, every other kind is the Suite maintainer.
 */
export function promptContractKindFor(kind) {
  if (kind === "initial_discovery" || kind === "conversation" || kind === "walk") return kind;
  return "suite_maintainer";
}

// How a saved way in is named to the agent: the method's display name and the
// account label, the same in the brief and in the first frame.
const SIGN_IN_METHODS = Object.freeze({
  github: "GitHub", google: "Google", apple: "Apple", email_password: "Email + password", sso: "SSO",
  phone_code: "Phone + code", magic_link: "Magic link", any_login_page: "Any login page",
});

/** @param {ReadonlyArray<{ method: string, label?: string | null }>} signIns */
export function savedWaysInList(signIns) {
  return signIns.map((item) => `${SIGN_IN_METHODS[item.method] ?? item.method}${item.label ? ` (${item.label})` : ""}`).join("; ");
}

/**
 * The one rule for a login gate the project has saved ways into: the agent
 * signs in itself and asks only about an ambiguous account. Only a kind that
 * can ask holds request_choice; one that cannot names the account it chose in
 * its result. A lower-case clause, so each caller leads into it with its
 * own "At a login gate, …".
 * @param {boolean} asks
 */
export function savedWaysInRule(asks) {
  const ambiguous = asks
    ? "ask the owner with request_choice only when the intended account is ambiguous"
    : "when the intended account is ambiguous, use the likeliest one and name that choice in your result";
  return "sign in with them yourself in the same browser: use the account the task calls for, try its saved browser "
    + "session first, and when login is required get its fields from the credentials tool, fill and submit them with browser "
    + `tools, and judge the result from the page; ${ambiguous}.`;
}

/**
 * Creates the question channel and clears anything a previous container left
 * behind. A stale answer file would be read as a reply to a question this run
 * has not asked yet.
 */
export async function prepareDiscoveryChannels(controlRoot, { mkdir, rm, join }) {
  await mkdir(join(controlRoot, "choice"), { recursive: true });
  await Promise.all([
    rm(join(controlRoot, "choice", "request.json"), { force: true }),
    rm(join(controlRoot, "choice", "answer.json"), { force: true }),
  ]);
}
