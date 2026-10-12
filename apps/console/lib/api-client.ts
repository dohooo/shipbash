import { z } from "zod";

import {
  apiContractPath,
  apiErrorSchema,
  type AnyApiContract,
  type ApiContract,
  type ApiContractInput,
  type ApiContractResponse,
  type ApiMethod,
} from "@shipbash/contracts/api/core";

import { isRecord } from "./is-record";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** The error body as the service sent it, beside the parsed message: a 409 may say where to go next. */
  readonly payload: Record<string, unknown> | null;

  constructor(message: string, status: number, code: string | null = null, payload: Record<string, unknown> | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

async function responsePayload(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  return response.json();
}

async function responseError(response: Response): Promise<ApiError> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return new ApiError(`ShipBash request failed with ${response.status}.`, response.status);
  }
  const parsed = apiErrorSchema.safeParse(payload);
  if (!parsed.success) {
    return new ApiError(`ShipBash request failed with ${response.status}.`, response.status, null, isRecord(payload) ? payload : null);
  }
  return new ApiError(parsed.data.message, response.status, parsed.data.error, isRecord(payload) ? payload : null);
}

export async function readApiResponse<Contract extends AnyApiContract>(
  contract: Contract,
  response: Response,
): Promise<ApiContractResponse<Contract>> {
  if (!response.ok) throw await responseError(response);
  if (!contract.successStatuses.some((status) => status === response.status)) {
    throw new ApiError("ShipBash received an unexpected response.", response.status);
  }
  // Typed by the contract's own schema, so the answer is the contract's.
  return z.parse<Contract["response"]>(contract.response, await responsePayload(response));
}

export async function callApi<
  const Id extends string,
  const Method extends ApiMethod,
  Params extends z.ZodType | null,
  Query extends z.ZodType | null,
  Body extends z.ZodType | null,
  ResponseSchema extends z.ZodType,
  const Status extends number,
>(
  contract: ApiContract<Id, Method, Params, Query, Body, ResponseSchema, Status>,
  input: ApiContractInput<ApiContract<Id, Method, Params, Query, Body, ResponseSchema, Status>>,
): Promise<z.output<ResponseSchema>> {
  const body: unknown = contract.body ? contract.body.parse(input.body) : undefined;
  const headers = new Headers({ accept: "application/json" });
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(apiContractPath(contract, input), {
    method: contract.method,
    cache: "no-store",
    credentials: "same-origin",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return readApiResponse(contract, response);
}

/** How a contract is read: `callApi` in the browser, `serverLoad` on the server. */
export type ApiRead = typeof callApi;

