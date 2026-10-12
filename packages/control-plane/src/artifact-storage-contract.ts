import type { ArtifactBucketId } from "@shipbash/contracts/database-contract-types";

export const ARTIFACT_BUCKET: ArtifactBucketId = "shipbash-run-artifacts";
export const ARTIFACT_BUCKET_FILE_SIZE_LIMIT_BYTES = 100 * 1024 * 1024;
export const ARTIFACT_SIGNED_URL_TTL_SECONDS = 60;
export const ARTIFACT_BUCKET_ALLOWED_MIME_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"video/mp4",
	"application/json",
	"application/gzip",
	"application/zip",
	"text/plain",
	"application/octet-stream",
] as const;

export interface StorageReadinessBucket {
	id: string;
	name: string;
	public: boolean;
	file_size_limit?: number;
	allowed_mime_types?: string[];
}

export interface StorageReadinessResponse<T> {
	data: T | null;
	error: unknown | null;
}

export interface StorageReadinessClient {
	storage: {
		getBucket(
			id: string,
		): Promise<StorageReadinessResponse<StorageReadinessBucket>>;
		from(id: string): {
			upload(
				path: string,
				body: Buffer,
				options: { contentType: string; upsert: boolean },
			): Promise<StorageReadinessResponse<unknown>>;
			download(path: string): Promise<StorageReadinessResponse<Blob>>;
			remove(paths: string[]): Promise<StorageReadinessResponse<unknown>>;
		};
	};
}
