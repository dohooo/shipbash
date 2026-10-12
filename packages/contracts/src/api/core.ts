import { z } from "zod";

export const apiErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  message: z.string(),
});

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiContract<
  Id extends string = string,
  Method extends ApiMethod = ApiMethod,
  Params extends z.ZodType | null = z.ZodType | null,
  Query extends z.ZodType | null = z.ZodType | null,
  Body extends z.ZodType | null = z.ZodType | null,
  Response extends z.ZodType = z.ZodType,
  Status extends number = number,
> {
  id: Id;
  method: Method;
  path: string;
  params: Params;
  query: Query;
  body: Body;
  response: Response;
  successStatuses: readonly Status[];
}

export function defineApiContract<
  const Id extends string,
  const Method extends ApiMethod,
  Params extends z.ZodType | null,
  Query extends z.ZodType | null,
  Body extends z.ZodType | null,
  Response extends z.ZodType,
  const Status extends number,
>(contract: ApiContract<Id, Method, Params, Query, Body, Response, Status>) {
  return contract;
}

export type AnyApiContract = ApiContract<
  string,
  ApiMethod,
  z.ZodType | null,
  z.ZodType | null,
  z.ZodType | null,
  z.ZodType,
  number
>;

type ContractField<Name extends string, Schema extends z.ZodType | null> =
  Schema extends z.ZodType
    ? { [Key in Name]: z.input<Schema> }
    : { [Key in Name]?: never };

export type ApiContractInput<Contract extends AnyApiContract> =
  & ContractField<"params", Contract["params"]>
  & ContractField<"query", Contract["query"]>
  & ContractField<"body", Contract["body"]>;

export type ApiContractResponse<Contract extends AnyApiContract> =
  z.output<Contract["response"]>;

const recordSchema = z.record(z.string(), z.unknown());

function pathValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`API path parameter ${name} is unavailable.`);
  }
  return encodeURIComponent(value);
}

function appendQueryValue(search: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const entry of value) appendQueryValue(search, key, entry);
    return;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    search.append(key, String(value));
    return;
  }
  throw new Error(`API query parameter ${key} is invalid.`);
}

export function apiContractPath<Contract extends AnyApiContract>(
  contract: Contract,
  input: ApiContractInput<Contract>,
): string {
  const parsedParams = contract.params ? recordSchema.parse(contract.params.parse(input.params)) : {};
  const pathname = contract.path.replace(/:([A-Za-z][A-Za-z0-9]*)/gu, (_match, name: string) =>
    pathValue(parsedParams[name], name));
  if (!contract.query) return pathname;
  const parsedQuery = recordSchema.parse(contract.query.parse(input.query));
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(parsedQuery)) appendQueryValue(search, key, value);
  const query = search.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** A URL's query as a record: a key given once is a string, a repeated key an array. */
export function queryRecord(url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    query[key] = values.length === 1 ? (values[0] ?? "") : values;
  }
  return query;
}
