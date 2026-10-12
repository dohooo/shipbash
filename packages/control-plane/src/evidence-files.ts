/**
 * The evidence pipeline names every file it writes of a walk `evidence-…`:
 * the recorder's step frames, page console and manifest, and the evidence
 * review. Any other file a walk keeps is one the run curated.
 */
export function isEvidenceFile(name: string): boolean {
  return name.startsWith("evidence-");
}
