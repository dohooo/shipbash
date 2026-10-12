import { createHash } from "node:crypto";
import { basename, extname } from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseArtifactSigner, type SignedUrlOptions } from "./artifact-signer.ts";
import { signedPutTarget, storedObjectSize, type UploadTarget } from "./storage-objects.ts";
import { createServiceRoleClient } from "./supabase-service-client.ts";
import { ARTIFACT_BUCKET } from "./artifact-storage-contract.ts";

export { ARTIFACT_BUCKET_ALLOWED_MIME_TYPES } from "./artifact-storage-contract.ts";
export { verifyArtifactStorageReadiness } from "./artifact-storage-readiness.ts";

export interface StoredArtifactDownload {
	body: Buffer;
	contentType: string;
}

const MIME_TYPES: Readonly<Record<string, string>> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".mp4": "video/mp4",
	".json": "application/json",
	".gz": "application/gzip",
	".zip": "application/zip",
	".txt": "text/plain",
	".log": "text/plain",
};

export function artifactMimeType(path: string): string {
	return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function safeObjectName(path: string): string {
	const sanitized = basename(path).replaceAll(/[^A-Za-z0-9._-]/g, "_");
	return sanitized || "artifact.bin";
}

export function artifactObjectPath(
	runId: string,
	caseRunId: string,
	sourcePath: string,
	sha256: string,
): string {
	const safeId = (value: string): string =>
		value.replaceAll(/[^A-Za-z0-9_-]/g, "_");
	const sourceHash = createHash("sha256").update(sourcePath).digest("hex").slice(0, 16);
	return `runs/${safeId(runId)}/${safeId(caseRunId)}/${sourceHash}/${sha256.slice(0, 16)}-${safeObjectName(sourcePath)}`;
}

/** Where every object an Activity keeps lies: artifactObjectPath under `activity_<id>`. */
export function activityObjectPrefix(activityId: string): string {
	return `runs/activity_${activityId}/`;
}

/** The file's own name in an artifactObjectPath, without the content hash before it. */
export function artifactFileName(objectPath: string): string {
	const name = objectPath.slice(objectPath.lastIndexOf("/") + 1);
	return name.slice(name.indexOf("-") + 1);
}

export class SupabaseArtifactStorage {
	private readonly signer: SupabaseArtifactSigner;
	private readonly supabase: SupabaseClient;
	private readonly apiUrl: string;

	constructor(options: { apiUrl: string; serviceRoleKey: string }) {
		if (!options.apiUrl.trim() || !options.serviceRoleKey.trim()) {
			throw new Error(
				"SupabaseArtifactStorage requires local API and service credentials.",
			);
		}
		// Signing a read has its own time-bounded client; this one downloads large objects.
		this.signer = new SupabaseArtifactSigner(options);
		this.supabase = createServiceRoleClient(options.apiUrl, options.serviceRoleKey);
		this.apiUrl = options.apiUrl;
	}

	/**
	 * Where the task puts one artifact's bytes: a signed upload that can only
	 * create the object, or null when the object is stored already — its path
	 * is content-addressed, so it holds these bytes.
	 */
	signedUploadTarget(objectPath: string, contentType: string): Promise<UploadTarget | null> {
		return signedPutTarget(this.supabase, this.apiUrl, ARTIFACT_BUCKET, objectPath, contentType);
	}

	/**
	 * Stores bytes the host itself holds. Its paths are content-addressed, so
	 * an object stored there already holds these bytes and is kept.
	 */
	async uploadObject(objectPath: string, body: Buffer, contentType: string): Promise<void> {
		const uploaded = await this.supabase.storage
			.from(ARTIFACT_BUCKET)
			.upload(objectPath, body, { contentType, upsert: false });
		if (uploaded.error && uploaded.error.statusCode !== "409")
			throw new Error(`Artifact upload failed: ${uploaded.error.message}`);
	}

	/** What the task stored at the path, or null when it stored nothing. */
	objectSize(objectPath: string): Promise<number | null> {
		return storedObjectSize(this.supabase, ARTIFACT_BUCKET, objectPath);
	}

	async downloadObject(
		objectPath: string,
		contentType = "application/octet-stream",
	): Promise<StoredArtifactDownload> {
		if (!objectPath.trim())
			throw new Error("Artifact object path is required.");
		const downloaded = await this.supabase.storage
			.from(ARTIFACT_BUCKET)
			.download(objectPath);
		if (downloaded.error)
			throw new Error(`Artifact download failed: ${downloaded.error.message}`);
		return {
			body: Buffer.from(await downloaded.data.arrayBuffer()),
			contentType,
		};
	}

	signedUrl(objectPath: string, options?: SignedUrlOptions): Promise<string> {
		return this.signer.signedUrl(objectPath, options);
	}
}
