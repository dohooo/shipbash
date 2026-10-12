import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
	ARTIFACT_BUCKET,
	ARTIFACT_BUCKET_ALLOWED_MIME_TYPES,
	ARTIFACT_BUCKET_FILE_SIZE_LIMIT_BYTES,
	type StorageReadinessClient,
	type StorageReadinessResponse,
} from "./artifact-storage-contract.ts";
import { createServiceRoleClient } from "./supabase-service-client.ts";

function storageReadinessError(stage: string): Error {
	return new Error(
		`Supabase artifact Storage readiness check failed during ${stage}.`,
	);
}

async function storageReadinessOperation<T>(
	stage: string,
	operation: () => Promise<StorageReadinessResponse<T>>,
): Promise<T> {
	let result: StorageReadinessResponse<T>;
	try {
		result = await operation();
	} catch {
		throw storageReadinessError(stage);
	}
	if (result.error || result.data === null) throw storageReadinessError(stage);
	return result.data;
}

function sorted(values: readonly string[]): string[] {
	return [...values].sort((left, right) => left.localeCompare(right));
}

function sameValues(
	left: readonly string[],
	right: readonly string[],
): boolean {
	const sortedLeft = sorted(left);
	const sortedRight = sorted(right);
	return (
		sortedLeft.length === sortedRight.length &&
		sortedLeft.every((value, index) => value === sortedRight[index])
	);
}

function assertBucketPolicy(bucket: {
	id: string;
	name: string;
	public: boolean;
	file_size_limit?: number;
	allowed_mime_types?: string[];
}): void {
	if (bucket.id !== ARTIFACT_BUCKET || bucket.name !== ARTIFACT_BUCKET) {
		throw new Error(
			"Supabase artifact Storage readiness check found the wrong bucket.",
		);
	}
	if (bucket.public !== false) {
		throw new Error("Supabase artifact Storage bucket must be private.");
	}
	if (bucket.file_size_limit !== ARTIFACT_BUCKET_FILE_SIZE_LIMIT_BYTES) {
		throw new Error(
			"Supabase artifact Storage bucket file-size limit has drifted.",
		);
	}
	if (
		!sameValues(
			bucket.allowed_mime_types ?? [],
			ARTIFACT_BUCKET_ALLOWED_MIME_TYPES,
		)
	) {
		throw new Error(
			"Supabase artifact Storage bucket MIME policy has drifted.",
		);
	}
}

export async function assertArtifactStorageReady(
	supabase: StorageReadinessClient,
): Promise<void> {
	const bucket = await storageReadinessOperation("bucket policy lookup", () =>
		supabase.storage.getBucket(ARTIFACT_BUCKET),
	);
	assertBucketPolicy(bucket);

	const probePath = `readiness/${randomUUID()}.bin`;
	const probeBody = randomBytes(32);
	const expectedSha256 = createHash("sha256").update(probeBody).digest("hex");
	const objects = supabase.storage.from(ARTIFACT_BUCKET);
	let uploaded = false;
	let failure: unknown;
	try {
		await storageReadinessOperation("probe upload", () =>
			objects.upload(probePath, probeBody, {
				contentType: "application/octet-stream",
				upsert: false,
			}),
		);
		uploaded = true;
		const downloaded = await storageReadinessOperation("probe download", () =>
			objects.download(probePath),
		);
		const downloadedBody = Buffer.from(await downloaded.arrayBuffer());
		const actualSha256 = createHash("sha256")
			.update(downloadedBody)
			.digest("hex");
		if (actualSha256 !== expectedSha256) {
			throw new Error(
				"Supabase artifact Storage readiness probe hash did not round-trip.",
			);
		}
	} catch (error) {
		failure = error;
	}

	if (uploaded) {
		try {
			await storageReadinessOperation("probe delete", () =>
				objects.remove([probePath]),
			);
		} catch (error) {
			failure = error;
		}
	}
	if (failure) throw failure;
}

export async function verifyArtifactStorageReadiness(options: {
	apiUrl: string;
	serviceRoleKey: string;
}): Promise<void> {
	if (!options.apiUrl.trim() || !options.serviceRoleKey.trim()) {
		throw new Error(
			"Supabase artifact Storage readiness requires local API credentials.",
		);
	}
	const supabase = createServiceRoleClient(options.apiUrl, options.serviceRoleKey);
	await assertArtifactStorageReady(supabase);
}
