/**
 * JSON-safe value shapes shared by every column persisted as jsonb.
 *
 * Object-type aliases, not interfaces: only an alias carries the implicit
 * index signature the postgres driver's JSONValue parameter requires, so
 * these shapes reach sql.json without an assertion.
 */
export type JsonValue =
	| null
	| string
	| number
	| boolean
	| readonly JsonValue[]
	| JsonObject;

export type JsonObject = { readonly [key: string]: JsonValue | undefined };
