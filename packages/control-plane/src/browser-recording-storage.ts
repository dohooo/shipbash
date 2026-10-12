import { randomBytes, randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SignedUrlOptions } from "./artifact-signer.ts";
import { isRecord } from "./is-record.ts";
import {
	type ResumableUploadTarget,
	signedPutTarget,
	signUpload,
	storedObjectSize,
	type UploadTarget,
} from "./storage-objects.ts";
import { createServiceRoleClient } from "./supabase-service-client.ts";

import {
	type BrowserRecordingPlaybackMetadata,
	parseBrowserRecordingPlaybackMetadata,
} from "@shipbash/contracts/browser-recording-playback";
import type { BrowserRecordingBucketId } from "@shipbash/contracts/database-contract-types";
import {
	BROWSER_RECORDING_FILE,
	BROWSER_RECORDING_MIME_TYPE,
	BROWSER_RECORDING_POSTER_FILE,
} from "@shipbash/contracts/runtime/browser-recording-format.mjs";

const BROWSER_RECORDING_BUCKET: BrowserRecordingBucketId =
	"shipbash-browser-recordings";
export const BROWSER_RECORDING_FILE_SIZE_LIMIT_BYTES = 256 * 1024 * 1024;
/**
 * What the bucket accepts on upload, which is only ever what the runner writes
 * today. Objects an earlier image wrote keep serving whatever type they were
 * stored with; this list gates writes, not reads.
 */
const BROWSER_RECORDING_ALLOWED_MIME_TYPES = [
	BROWSER_RECORDING_MIME_TYPE,
	"image/jpeg",
] as const;
const STORAGE_REQUEST_TIMEOUT_MS = 2 * 60 * 1_000;

export interface BrowserRecordingMetadata {
	width: number;
	height: number;
	durationMs: number;
	poster: boolean;
	playback: BrowserRecordingPlaybackMetadata;
}

interface StorageBucket {
	id: string;
	name: string;
	public: boolean;
	file_size_limit?: number;
	allowed_mime_types?: string[];
}

interface StorageResult<T> {
	data: T | null;
	error: { message?: string } | null;
}

export interface BrowserRecordingStorageClient {
	storage: {
		getBucket(id: string): Promise<StorageResult<StorageBucket>>;
		from(id: string): {
			upload(
				path: string,
				body: Buffer,
				options: {
					contentType: string;
					upsert: boolean;
					cacheControl?: string;
				},
			): Promise<StorageResult<unknown>>;
			download(path: string): Promise<StorageResult<Blob>>;
			remove(paths: string[]): Promise<StorageResult<unknown>>;
			createSignedUrl(
				path: string,
				expiresIn: number,
			): Promise<StorageResult<{ signedUrl: string }>>;
		};
	};
}

/**
 * The runner writes this document beside the recording and the task hands it
 * over as it found it; the server reads it here. Every Sandbox runs the
 * release's own runtime, so the one version it writes is the one read. The
 * playback document inside carries its own version and is parsed on its own.
 */
export function parseBrowserRecordingMetadata(
	parsed: unknown,
): BrowserRecordingMetadata {
	if (
		!isRecord(parsed) ||
		parsed.schemaVersion !== 3 ||
		!Number.isInteger(parsed.width) ||
		Number(parsed.width) < 1 ||
		!Number.isInteger(parsed.height) ||
		Number(parsed.height) < 1 ||
		!Number.isSafeInteger(parsed.durationMs) ||
		Number(parsed.durationMs) < 1 ||
		typeof parsed.poster !== "boolean"
	) {
		throw new Error("Browser recording metadata is invalid.");
	}
	return {
		width: Number(parsed.width),
		height: Number(parsed.height),
		durationMs: Number(parsed.durationMs),
		poster: parsed.poster,
		playback: parseBrowserRecordingPlaybackMetadata(
			parsed.playback,
			Number(parsed.durationMs),
		),
	};
}

function safeObjectSegment(value: string): string {
	const segment = value.replaceAll(/[^A-Za-z0-9_-]/gu, "_");
	if (!segment)
		throw new Error("Browser recording object identifier is invalid.");
	return segment;
}

export function browserRecordingObjectPaths(input: {
	teamId: string;
	projectId: string;
	recordingId: string;
	uploadId: string;
}): { video: string; poster: string } {
	const base = [
		"recordings",
		safeObjectSegment(input.teamId),
		safeObjectSegment(input.projectId),
		safeObjectSegment(input.recordingId),
		safeObjectSegment(input.uploadId),
	].join("/");
	return {
		video: `${base}/${BROWSER_RECORDING_FILE}`,
		poster: `${base}/${BROWSER_RECORDING_POSTER_FILE}`,
	};
}

/** Storage's endpoint for a resumable upload signed by token; a hosted project's goes to its direct storage host. */
export function browserRecordingTusEndpoint(apiUrl: string): string {
	const url = new URL(apiUrl);
	const hosted =
		url.protocol === "https:" && url.hostname.endsWith(".supabase.co")
			? url.hostname.split(".")[0]
			: null;
	if (hosted)
		return `https://${hosted}.storage.supabase.co/storage/v1/upload/resumable/sign`;
	url.pathname = "/storage/v1/upload/resumable/sign";
	url.search = "";
	url.hash = "";
	return url.href;
}

function sorted(values: readonly string[]): string[] {
	return [...values].sort((left, right) => left.localeCompare(right));
}

async function assertBrowserRecordingStorageReady(
	supabase: BrowserRecordingStorageClient,
): Promise<void> {
	const bucket = await supabase.storage.getBucket(BROWSER_RECORDING_BUCKET);
	if (bucket.error || !bucket.data) {
		throw new Error(
			"Supabase browser recording Storage bucket is unavailable.",
		);
	}
	if (
		bucket.data.id !== BROWSER_RECORDING_BUCKET ||
		bucket.data.name !== BROWSER_RECORDING_BUCKET ||
		bucket.data.public !== false ||
		bucket.data.file_size_limit !== BROWSER_RECORDING_FILE_SIZE_LIMIT_BYTES ||
		JSON.stringify(sorted(bucket.data.allowed_mime_types ?? [])) !==
			JSON.stringify(sorted(BROWSER_RECORDING_ALLOWED_MIME_TYPES))
	) {
		throw new Error("Supabase browser recording Storage policy has drifted.");
	}

	const path = `readiness/${randomUUID()}.jpg`;
	const objects = supabase.storage.from(BROWSER_RECORDING_BUCKET);
	const body = randomBytes(32);
	const uploaded = await objects.upload(path, body, {
		contentType: "image/jpeg",
		upsert: false,
		cacheControl: "3600",
	});
	if (uploaded.error)
		throw new Error("Supabase browser recording Storage probe upload failed.");
	let downloadFailure: unknown;
	try {
		const downloaded = await objects.download(path);
		if (downloaded.error || !downloaded.data) {
			throw new Error(
				"Supabase browser recording Storage probe download failed.",
			);
		}
	} catch (error) {
		downloadFailure = error;
	}
	const removed = await objects.remove([path]);
	if (downloadFailure) throw downloadFailure;
	if (removed.error)
		throw new Error("Supabase browser recording Storage probe cleanup failed.");
}

export class SupabaseBrowserRecordingStorage {
	private readonly supabase: SupabaseClient;
	private readonly apiUrl: string;

	constructor(options: { apiUrl: string; serviceRoleKey: string }) {
		if (!options.apiUrl.trim() || !options.serviceRoleKey.trim()) {
			throw new Error(
				"SupabaseBrowserRecordingStorage requires API and service credentials.",
			);
		}
		this.apiUrl = options.apiUrl;
		this.supabase = createServiceRoleClient(
			options.apiUrl,
			options.serviceRoleKey,
			STORAGE_REQUEST_TIMEOUT_MS,
		);
	}

	/**
	 * Where the task puts one recording's files: a resumable upload for the
	 * video and a signed PUT for its poster, each able only to create
	 * its object. An attempt's paths are its own, so none is taken already.
	 */
	async signedUploadTargets(paths: { video: string; poster: string }): Promise<{
		video: ResumableUploadTarget;
		poster: UploadTarget;
	}> {
		const [video, poster] = await Promise.all([
			signUpload(this.supabase, this.apiUrl, BROWSER_RECORDING_BUCKET, paths.video),
			signedPutTarget(this.supabase, this.apiUrl, BROWSER_RECORDING_BUCKET, paths.poster, "image/jpeg"),
		]);
		if (!video || !poster) throw new Error("Browser recording upload paths are taken already.");
		return {
			video: {
				endpoint: browserRecordingTusEndpoint(this.apiUrl),
				headers: { "x-signature": video.token },
				bucket: BROWSER_RECORDING_BUCKET,
				objectPath: paths.video,
			},
			poster,
		};
	}

	/** What the task stored at the path, or null when it stored nothing. */
	objectSize(objectPath: string): Promise<number | null> {
		return storedObjectSize(this.supabase, BROWSER_RECORDING_BUCKET, objectPath);
	}

	async signedUrl(
		objectPath: string,
		{ expiresInSeconds = 3_600 }: Pick<SignedUrlOptions, "expiresInSeconds"> = {},
	): Promise<string> {
		const signed = await this.supabase.storage
			.from(BROWSER_RECORDING_BUCKET)
			.createSignedUrl(objectPath, expiresInSeconds);
		if (signed.error || !signed.data?.signedUrl) {
			throw new Error("Browser recording signed URL could not be created.");
		}
		return new URL(signed.data.signedUrl, this.apiUrl).href;
	}

	async remove(paths: readonly string[]): Promise<void> {
		if (paths.length === 0) return;
		const removed = await this.supabase.storage
			.from(BROWSER_RECORDING_BUCKET)
			.remove([...paths]);
		if (removed.error) throw new Error("Browser recording cleanup failed.");
	}
}

export async function verifyBrowserRecordingStorageReadiness(options: {
	apiUrl: string;
	serviceRoleKey: string;
}): Promise<void> {
	const supabase = createServiceRoleClient(options.apiUrl, options.serviceRoleKey);
	await assertBrowserRecordingStorageReady(supabase);
}
