/** Returns the http(s) origin of a Production URL, or null when unparseable. */
function productionUrlOrigin(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** The live project whose Production URL shares an origin with the candidate URL, if any. */
export function duplicateProductionProject<Project extends { id: string; productionUrl: string | null }>(
  projects: readonly Project[],
  candidateUrl: string,
  excludeProjectId?: string,
): Project | null {
  const origin = productionUrlOrigin(candidateUrl);
  if (!origin) return null;
  return projects.find((project) =>
    project.id !== excludeProjectId
      && project.productionUrl !== null
      && productionUrlOrigin(project.productionUrl) === origin,
  ) ?? null;
}
