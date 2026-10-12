/**
 * A project's journeys and hooks as `GET /api/projects/:id/journeys` returns
 * them: the one active suite with its cases, and the proposals on the
 * project, read strictly to the contract.
 */
import type { Team } from "./account.ts";
import {
	field,
	flag,
	integer,
	isRecord,
	list,
	nullableText,
	requestAs,
	text,
	unexpected,
} from "./api.ts";
import { type Credentials, requireCredentials } from "./config.ts";
import { CliError } from "./errors.ts";
import { activeSuite, type Project, resolveProject } from "./project.ts";

export type HookRole =
	| "before_all"
	| "before_each"
	| "after_each"
	| "after_all";

/** The four hook slots, in the order a run walks them. */
export const HOOK_ROLES: readonly HookRole[] = [
	"before_all",
	"before_each",
	"after_each",
	"after_all",
];

/** The slots as the console names them; display only. */
export const SLOT_LABELS: Record<HookRole, string> = {
	before_all: "Before every run",
	before_each: "Before each journey",
	after_each: "After each journey",
	after_all: "After every run",
};

export function isHookRole(value: unknown): value is HookRole {
	return HOOK_ROLES.some((role) => role === value);
}

export interface Step {
	id: string;
	instruction: string;
}

/** A statement that must hold after its step; `afterStep` null holds before the first step, absent after the last. */
export interface Checkpoint {
	id: string;
	goal: string;
	afterStep?: string | null;
}

export interface SuiteCase {
	id: string;
	title: string;
	category: string;
	role: "journey" | HookRole;
	/** The one journey a before_each or after_each hook runs around; null for every journey. */
	scopeCaseId: string | null;
	whyItMatters: string | null;
	preconditions: string[];
	steps: Step[];
	checkpoints: Checkpoint[];
	enabled: boolean;
	archived: boolean;
	position: number;
	latestVerdict: string | null;
	latestRunAt: string | null;
	verificationState: string;
}

export type Hook = SuiteCase & { role: HookRole };

export function isHook(entry: SuiteCase): entry is Hook {
	return entry.role !== "journey";
}

export interface Schedule {
	cadence: string;
	localTime: string | null;
	cronExpression: string | null;
	timezone: string | null;
	nextRunAt: string | null;
}

export interface Suite {
	id: string;
	name: string;
	definitionRevision: number;
	schedule: Schedule | null;
	cases: SuiteCase[];
}

/** A case as a proposal proposes it; a new case has no id. */
export interface Candidate
	extends Pick<
		SuiteCase,
		"title" | "category" | "whyItMatters" | "steps" | "checkpoints"
	> {
	id: string | null;
	archived: boolean;
}

export interface Proposal {
	id: string;
	status: string;
	/** Its version: what a keep sends back as expectedUpdatedAt. */
	updatedAt: string;
	/** The walk that produced it. */
	sourceActivityId: string | null;
	/** A staging draft's instruction for each case it holds an edit to; null for any other proposal. */
	staged: Record<string, string> | null;
	candidates: Candidate[];
	/** The candidates a keep decides on: none on a staging draft. */
	draftCaseIds: string[];
	/** A staging draft's latest walk; null before one started, and on every other proposal. */
	walk: { activityId: string; status: string } | null;
	/** The staging draft whose edit walk delivered this proposal; it is kept or discarded only with that draft. */
	editWalkDraftId: string | null;
}

/** The team, project and token every project command acts with. */
export interface ProjectScope {
	credentials: Credentials;
	team: Team;
	project: Project;
}

function strings(payload: unknown, ...path: string[]): string[] {
	return list(payload, ...path).map((entry) => text(entry));
}

function parseCheckpoint(entry: unknown): Checkpoint {
	const checkpoint = { id: text(entry, "id"), goal: text(entry, "goal") };
	return field(entry, "afterStep") === undefined
		? checkpoint
		: { ...checkpoint, afterStep: nullableText(entry, "afterStep") };
}

function parseScript(entry: unknown): Pick<SuiteCase, "steps" | "checkpoints"> {
	return {
		steps: list(entry, "steps").map((step) => ({
			id: text(step, "id"),
			instruction: text(step, "instruction"),
		})),
		checkpoints: list(entry, "checkpoints").map(parseCheckpoint),
	};
}

export function parseRole(entry: unknown): SuiteCase["role"] {
	const role = text(entry, "role");
	if (role === "journey" || isHookRole(role)) return role;
	throw unexpected();
}

function parseCase(entry: unknown): SuiteCase {
	return {
		id: text(entry, "id"),
		title: text(entry, "title"),
		category: text(entry, "category"),
		role: parseRole(entry),
		scopeCaseId: nullableText(entry, "scopeCaseId"),
		whyItMatters: nullableText(entry, "whyItMatters"),
		preconditions: strings(entry, "preconditions"),
		...parseScript(entry),
		enabled: flag(entry, "enabled"),
		archived: flag(entry, "archived"),
		position: integer(entry, "position"),
		latestVerdict: nullableText(entry, "latestVerdict"),
		latestRunAt: nullableText(entry, "latestRunAt"),
		verificationState: text(entry, "verificationState"),
	};
}

/** The `schedule` field of a suite, or of the schedule a PUT answered with. */
export function parseSchedule(entry: unknown): Schedule | null {
	if (field(entry, "schedule") === null) return null;
	return {
		cadence: text(entry, "schedule", "cadence"),
		localTime: nullableText(entry, "schedule", "localTime"),
		cronExpression: nullableText(entry, "schedule", "cronExpression"),
		timezone: nullableText(entry, "schedule", "timezone"),
		nextRunAt: nullableText(entry, "schedule", "nextRunAt"),
	};
}

function parseSuite(entry: unknown): Suite & { lifecycleStatus: string } {
	return {
		id: text(entry, "id"),
		name: text(entry, "name"),
		definitionRevision: integer(entry, "definitionRevision"),
		lifecycleStatus: text(entry, "lifecycleStatus"),
		schedule: parseSchedule(entry),
		cases: list(entry, "cases").map(parseCase),
	};
}

/** A draft candidate: the contract leaves its id (a new case has none) and `archived` optional. */
function parseCandidate(entry: unknown): Candidate {
	return {
		id: field(entry, "id") === undefined ? null : text(entry, "id"),
		title: text(entry, "title"),
		category: text(entry, "category"),
		whyItMatters: nullableText(entry, "whyItMatters"),
		...parseScript(entry),
		archived:
			field(entry, "archived") === undefined ? false : flag(entry, "archived"),
	};
}

/** A proposal as the journeys read lists it, or as a write answers with it. */
export function parseProposal(entry: unknown): Proposal {
	const instructions = field(entry, "journeyEditInstructions");
	if (instructions !== null && !isRecord(instructions)) throw unexpected();
	return {
		id: text(entry, "id"),
		status: text(entry, "status"),
		updatedAt: text(entry, "updatedAt"),
		sourceActivityId: nullableText(entry, "sourceActivityId"),
		staged:
			instructions &&
			Object.fromEntries(
				Object.keys(instructions).map((id) => [id, text(instructions, id)]),
			),
		candidates: list(entry, "candidateDefinition").map(parseCandidate),
		draftCaseIds: strings(entry, "draftCaseIds"),
		editWalkDraftId: nullableText(entry, "editWalkDraftId"),
		walk:
			field(entry, "walk") === null
				? null
				: {
						activityId: text(entry, "walk", "activityId"),
						status: text(entry, "walk", "status"),
					},
	};
}

/** Signs in, resolves `--project`, and names what the command acts with. */
export async function projectScope(
	projectFlag: string | null,
): Promise<ProjectScope> {
	const credentials = await requireCredentials();
	return { credentials, ...(await resolveProject(credentials, projectFlag)) };
}

export function projectPath(scope: ProjectScope, path: string): string {
	return `/api/projects/${encodeURIComponent(scope.project.id)}${path}`;
}

/** A page of the project in the console, such as `/verifications/<id>`. */
export function consoleUrl(scope: ProjectScope, path: string): string {
	return `${scope.credentials.origin}/${scope.team.slug}/${scope.project.slug}${path}`;
}

/** What a command that acts on the suite says while the project has no journeys. */
export function noJourneysYet(scope: ProjectScope, what: string): CliError {
	return new CliError(
		"NOT_FOUND",
		`${scope.team.slug}/${scope.project.slug} has no journeys yet, so there is nothing to ${what}.`,
		{
			nextSteps: [
				`Run \`npx shipbash journeys add --project ${scope.project.slug}\` first.`,
			],
		},
	);
}

/** The project's active suite (null before it has journeys) and its proposals. */
export async function readJourneys(
	scope: ProjectScope,
): Promise<{ suite: Suite | null; proposals: Proposal[] }> {
	const payload = await requestAs(
		scope.credentials,
		projectPath(scope, "/journeys"),
	);
	return {
		suite: activeSuite(list(payload, "suites").map(parseSuite)),
		proposals: list(payload, "proposals").map(parseProposal),
	};
}

/** The suite a write answered with. */
export function writtenSuite(payload: unknown): Suite {
	return parseSuite(field(payload, "suite"));
}

function live(suite: Suite | null): SuiteCase[] {
	return (suite?.cases ?? [])
		.filter((entry) => !entry.archived)
		.sort((left, right) => left.position - right.position);
}

/** The suite's live journeys, most important first. */
export function journeysOf(suite: Suite | null): SuiteCase[] {
	return live(suite).filter((entry) => !isHook(entry));
}

/** The suite's live hooks, in position order. */
export function hooksOf(suite: Suite | null): Hook[] {
	return live(suite).filter(isHook);
}

/** The suite's one staging draft: the draft that holds the journeys' staged edits, if any. */
export function stagingDraft(
	proposals: readonly Proposal[],
): Proposal | undefined {
	return proposals.find(
		(proposal) => proposal.status === "draft" && proposal.staged !== null,
	);
}
