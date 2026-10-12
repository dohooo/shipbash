/**
 * The two things the server does with Storage on a task's behalf: sign the
 * upload of one object, which the task then puts itself, and check what was
 * stored there afterwards. Both buckets' clients sign and check through
 * these, so a signed upload never overwrites and reads the same everywhere.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** A body's destination: a signed URL and the headers it must be sent with. */
export interface UploadTarget {
  url: string;
  headers: Record<string, string>;
}

/**
 * A resumable (TUS) upload's destination: Storage's signed endpoint, the
 * token as `x-signature`, and the bucket and path the token was signed for,
 * which the upload's metadata must name again.
 */
export interface ResumableUploadTarget {
  endpoint: string;
  headers: Record<string, string>;
  bucket: string;
  objectPath: string;
}

/**
 * A signed upload of one path, valid two hours, or null when an object is
 * stored there already. `upsert: false` is part of the signature, so the
 * token can only create the object, never replace one.
 */
export async function signUpload(
  supabase: SupabaseClient,
  apiUrl: string,
  bucket: string,
  objectPath: string,
): Promise<{ url: string; token: string } | null> {
  const signed = await supabase.storage.from(bucket).createSignedUploadUrl(objectPath, { upsert: false });
  if (signed.error?.statusCode === "409") return null;
  if (signed.error) throw new Error(`Storage could not sign the upload: ${signed.error.message}`);
  const url = new URL(signed.data.signedUrl, apiUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Storage signed an invalid upload URL.");
  return { url: url.href, token: signed.data.token };
}

/** The signed PUT of one object, sent as supabase-js would send it; null when the object is stored already. */
export async function signedPutTarget(
  supabase: SupabaseClient,
  apiUrl: string,
  bucket: string,
  objectPath: string,
  contentType: string,
): Promise<UploadTarget | null> {
  const signed = await signUpload(supabase, apiUrl, bucket, objectPath);
  return signed && { url: signed.url, headers: { "content-type": contentType, "cache-control": "max-age=3600", "x-upsert": "false" } };
}

/** The size of the object stored at the path, or null when nothing is stored there. */
export async function storedObjectSize(
  supabase: SupabaseClient,
  bucket: string,
  objectPath: string,
): Promise<number | null> {
  const info = await supabase.storage.from(bucket).info(objectPath);
  if (!info.error) return info.data.size ?? null;
  if (info.error.statusCode === "404") return null;
  throw new Error(`Storage could not check the object: ${info.error.message}`);
}
