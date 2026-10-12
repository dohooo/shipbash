/**
 * The service-role Supabase client the storage modules share: it keeps,
 * refreshes and reads no session. Given a request timeout, every request is
 * also bounded by it, alongside the caller's own signal.
 */
import { createClient } from "@supabase/supabase-js";

function boundedFetch(timeoutMs: number) {
	return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const signals = [AbortSignal.timeout(timeoutMs)];
		if (init?.signal) signals.push(init.signal);
		if (input instanceof Request) signals.push(input.signal);
		return fetch(input, { ...init, signal: AbortSignal.any(signals) });
	};
}

export function createServiceRoleClient(
	apiUrl: string,
	serviceRoleKey: string,
	requestTimeoutMs?: number,
) {
	return createClient(apiUrl, serviceRoleKey, {
		auth: {
			persistSession: false,
			autoRefreshToken: false,
			detectSessionInUrl: false,
		},
		...(requestTimeoutMs === undefined
			? {}
			: { global: { fetch: boundedFetch(requestTimeoutMs) } }),
	});
}
