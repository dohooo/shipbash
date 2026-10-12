import type { SupabaseClient } from "@supabase/supabase-js";

import {
	ARTIFACT_BUCKET,
	ARTIFACT_SIGNED_URL_TTL_SECONDS,
} from "./artifact-storage-contract.ts";
import { createServiceRoleClient } from "./supabase-service-client.ts";

/**
 * How long signing one object may take. supabase-js takes no signal for
 * `createSignedUrl`, so the bound lives on the client's own fetch — which is
 * why signing has a client of its own rather than sharing the one that
 * uploads artifacts of up to 100 MB.
 */
const SIGNING_TIMEOUT_MS = 15_000;

/**
 * How a signed URL reads: for how long, and, with `download`, saved as a file
 * of that name. Storage then answers with an attachment, which a link's own
 * `download` attribute cannot ask for once the API has redirected it to
 * Storage's origin.
 */
export interface SignedUrlOptions {
	expiresInSeconds?: number;
	download?: string;
}

/**
 * Short-lived URLs for objects in the run artifacts bucket, with only the API
 * credentials — no database connection. The artifact store signs through one,
 * and so does anything that only reads artifacts, such as the Slack alert
 * step in the dispatch workflow, which fetches a journey's replay to post it.
 */
export class SupabaseArtifactSigner {
	private readonly supabase: SupabaseClient;
	private readonly apiUrl: string;

	constructor(options: { apiUrl: string; serviceRoleKey: string }) {
		if (!options.apiUrl.trim() || !options.serviceRoleKey.trim()) {
			throw new Error(
				"SupabaseArtifactSigner requires API and service credentials.",
			);
		}
		this.apiUrl = options.apiUrl;
		this.supabase = createServiceRoleClient(
			options.apiUrl,
			options.serviceRoleKey,
			SIGNING_TIMEOUT_MS,
		);
	}

	async signedUrl(
		objectPath: string,
		{ expiresInSeconds = ARTIFACT_SIGNED_URL_TTL_SECONDS, download }: SignedUrlOptions = {},
	): Promise<string> {
		if (!objectPath.trim()) throw new Error("Artifact object path is required.");
		if (
			!Number.isSafeInteger(expiresInSeconds) ||
			expiresInSeconds < 1 ||
			expiresInSeconds > 3_600
		) {
			throw new Error(
				"Artifact signed URL lifetime must be between 1 and 3600 seconds.",
			);
		}
		const signed = await this.supabase.storage
			.from(ARTIFACT_BUCKET)
			.createSignedUrl(objectPath, expiresInSeconds, download ? { download } : undefined);
		if (signed.error || !signed.data?.signedUrl) {
			throw new Error("Artifact signed URL could not be created.");
		}
		const location = new URL(signed.data.signedUrl, this.apiUrl);
		if (location.protocol !== "http:" && location.protocol !== "https:") {
			throw new Error("Artifact signed URL is invalid.");
		}
		return location.href;
	}
}
