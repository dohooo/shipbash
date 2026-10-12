/** Streams entries into a zip one at a time, so a large bundle is never held whole. */
import { Zip, ZipDeflate, ZipPassThrough } from "fflate";

/** Formats already compressed: deflating them costs time and saves nothing. */
const STORED = /\.(?:jpe?g|png|webp|mp4|gz)$/iu;

export interface ZipEntry {
  path: string;
  data: Uint8Array;
}

/**
 * Writes the entries as a zip through `write`. When the entries or the zip
 * throw, the zip is left without its end: an archive no reader takes for whole.
 */
export async function writeZip(entries: AsyncIterable<ZipEntry>, write: (chunk: Uint8Array) => void): Promise<void> {
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    write(chunk);
  });
  for await (const { path, data } of entries) {
    const file = STORED.test(path) ? new ZipPassThrough(path) : new ZipDeflate(path, { level: 6 });
    zip.add(file);
    file.push(data, true);
  }
  zip.end();
}
