import { z } from "zod";

import {
	ApiError,
	type ApiRequest,
	type ApiResponse,
	readJsonObject,
	sendJson,
} from "../http.ts";
import {
	type AnyApiContract,
	type ApiContractResponse,
	queryRecord,
} from "@shipbash/contracts/api/core";

function invalidRequest(
	code: "INVALID_BODY" | "INVALID_PATH" | "INVALID_QUERY",
): ApiError {
	const subject =
		code === "INVALID_BODY"
			? "Request body"
			: code === "INVALID_PATH"
				? "Request path"
				: "Request query";
	return new ApiError(400, code, `${subject} is invalid.`);
}

function parseRequestValue<Schema extends z.ZodType>(
	schema: Schema,
	value: unknown,
	code: "INVALID_BODY" | "INVALID_PATH" | "INVALID_QUERY",
): z.output<Schema> {
	const result = schema.safeParse(value);
	if (!result.success) throw invalidRequest(code);
	return result.data;
}

export async function parseBody<Schema extends z.ZodType>(
	request: ApiRequest,
	schema: Schema,
	maximumBytes?: number,
): Promise<z.output<Schema>> {
	return parseRequestValue(
		schema,
		await readJsonObject(request, maximumBytes),
		"INVALID_BODY",
	);
}

export function parseParams<Schema extends z.ZodType>(
	schema: Schema,
	value: unknown,
): z.output<Schema> {
	const record = z.record(z.string(), z.unknown()).safeParse(value);
	if (!record.success) throw invalidRequest("INVALID_PATH");
	let decoded: Record<string, unknown>;
	try {
		decoded = Object.fromEntries(
			Object.entries(record.data).map(([key, entry]) => [
				key,
				typeof entry === "string" ? decodeURIComponent(entry) : entry,
			]),
		);
	} catch {
		throw invalidRequest("INVALID_PATH");
	}
	return parseRequestValue(schema, decoded, "INVALID_PATH");
}

export function parseQuery<Schema extends z.ZodType>(
	schema: Schema,
	url: URL,
): z.output<Schema> {
	return parseRequestValue(schema, queryRecord(url), "INVALID_QUERY");
}

export function sendContractJson<Contract extends AnyApiContract>(
	response: ApiResponse,
	status: Contract["successStatuses"][number],
	contract: Contract,
	payload: ApiContractResponse<Contract>,
): void {
	if (!contract.successStatuses.includes(status)) {
		throw new ApiError(
			500,
			"INVALID_API_RESPONSE",
			"The request could not be completed.",
		);
	}
	const result = contract.response.safeParse(payload);
	if (!result.success) {
		// The client gets a generic envelope by design; the server log must
		// name the exact failure — a validator rejecting in silence leaves a
		// failure that cannot be reproduced from the log. Issue paths only: payload
		// values never reach the log.
		console.error(
			`[contract] response for ${contract.id} rejected:`,
			result.error.issues
				.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
				.join("; "),
		);
		throw new ApiError(
			500,
			"INVALID_API_RESPONSE",
			"The request could not be completed.",
		);
	}
	sendJson(response, status, result.data);
}

export function sendContractNoContent<Contract extends AnyApiContract>(
	response: ApiResponse,
	status: Contract["successStatuses"][number],
	contract: Contract,
): void {
	if (
		!contract.successStatuses.includes(status) ||
		!contract.response.safeParse(undefined).success
	) {
		throw new ApiError(
			500,
			"INVALID_API_RESPONSE",
			"The request could not be completed.",
		);
	}
	response.writeHead(status, { "cache-control": "no-store" });
	response.end();
}
