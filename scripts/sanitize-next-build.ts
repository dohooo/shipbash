import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

const SERVER_FILES_PREFIX = "self.__SERVER_FILES_MANIFEST=";

export interface BuildRootRelocation {
  source: string;
  destination: string;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isJsonRecord(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
}

function collectEmbeddedBuildRoots(
  value: unknown,
  roots: readonly string[],
  path: readonly string[] = [],
): string[] {
  if (typeof value === "string") {
    return roots.some((root) => value.includes(root)) ? [path.join(".")] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      collectEmbeddedBuildRoots(entry, roots, [...path, String(index)]),
    );
  }
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) =>
    collectEmbeddedBuildRoots(entry, roots, [...path, key]),
  );
}

function relocateRootField(
  owner: JsonRecord,
  key: string,
  label: string,
  roots: readonly BuildRootRelocation[],
): void {
  const value = owner[key];
  if (typeof value !== "string") {
    throw new Error(`${label} did not contain the expected absolute Next build root.`);
  }
  if (roots.some((root) => value === root.destination)) return;
  if (!isAbsolute(value)) {
    throw new Error(`${label} did not contain the expected absolute Next build root.`);
  }
  const root = roots.find((candidate) => candidate.source === resolve(value));
  if (!root) throw new Error(`${label} did not contain the expected absolute Next build root.`);
  owner[key] = root.destination;
}

function portablePath(value: string): string {
  return value.split(sep).join("/");
}

function relocateTurbopackLoaders(
  turbopack: JsonRecord,
  roots: readonly BuildRootRelocation[],
): void {
  const rules = requireRecord(turbopack.rules, "Next server files manifest turbopack rules");
  for (const [pattern, ruleValue] of Object.entries(rules)) {
    const rule = requireRecord(ruleValue, `Next server files manifest turbopack rule ${pattern}`);
    if (!Array.isArray(rule.loaders)) continue;
    rule.loaders = rule.loaders.map((loader, index) => {
      if (typeof loader !== "string") {
        throw new Error(`Turbopack loader ${pattern}[${index}] must be a string.`);
      }
      if (!isAbsolute(loader)) return loader;
      const normalizedLoader = resolve(loader);
      const ownerRoot = roots
        .filter((root) => (
          normalizedLoader === root.source || normalizedLoader.startsWith(`${root.source}${sep}`)
        ))
        .sort((left, right) => right.source.length - left.source.length)[0];
      if (!ownerRoot) {
        throw new Error(`Turbopack loader ${pattern}[${index}] is outside the Next build root.`);
      }
      const relocated = portablePath(join(
        ownerRoot.destination,
        relative(ownerRoot.source, normalizedLoader),
      ));
      return relocated.startsWith(".") ? relocated : `./${relocated}`;
    });
  }
}

export function sanitizeRequiredServerFilesManifest(
  input: unknown,
  rootRelocations: readonly BuildRootRelocation[],
): JsonRecord {
  if (
    rootRelocations.length === 0
    || rootRelocations.some((root) => (
      !isAbsolute(root.source)
      || isAbsolute(root.destination)
      || root.destination.length === 0
    ))
  ) {
    throw new Error("Next build root relocations must use absolute sources and relative destinations.");
  }
  const roots = rootRelocations.map((root) => ({
    source: resolve(root.source),
    destination: portablePath(root.destination),
  }));
  const acceptedRoots = [...new Set(roots.map((root) => root.source))];
  const manifest = structuredClone(requireRecord(input, "Next server files manifest"));
  const config = requireRecord(manifest.config, "Next server files manifest config");

  relocateRootField(manifest, "appDir", "appDir", roots);
  relocateRootField(
    config,
    "outputFileTracingRoot",
    "config.outputFileTracingRoot",
    roots,
  );
  // Next 16.3 records the build machine's repository root here. Older builds
  // have no such key, so it is relocated only when present.
  if (config.repoRoot !== undefined) {
    relocateRootField(config, "repoRoot", "config.repoRoot", roots);
  }
  if (config.turbopack !== undefined && config.turbopack !== null) {
    const turbopack = requireRecord(
      config.turbopack,
      "Next server files manifest turbopack config",
    );
    relocateRootField(turbopack, "root", "config.turbopack.root", roots);
    if (turbopack.rules !== undefined) relocateTurbopackLoaders(turbopack, roots);
  }

  const remaining = collectEmbeddedBuildRoots(manifest, acceptedRoots);
  if (remaining.length > 0) {
    throw new Error(
      `Next server files manifest still contains the build root at: ${remaining.join(", ")}.`,
    );
  }
  return manifest;
}

function isAncestorPath(ancestor: string, descendant: string): boolean {
  const path = relative(ancestor, descendant);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function addRootRelocation(
  roots: BuildRootRelocation[],
  source: string,
  destination: string,
): void {
  const normalizedSource = resolve(source);
  const existing = roots.find((root) => root.source === normalizedSource);
  if (existing) {
    if (existing.destination !== destination) {
      throw new Error(`Next build root ${normalizedSource} had conflicting destinations.`);
    }
    return;
  }
  roots.push({ source: normalizedSource, destination });
}

export async function sanitizeRequiredServerFiles(buildRoot: string): Promise<void> {
  const resolvedRoot = resolve(buildRoot);
  const canonicalRoot = await realpath(resolvedRoot);
  const nextDirectory = join(resolvedRoot, ".next");
  const jsonPath = join(nextDirectory, "required-server-files.json");
  const javascriptPath = join(nextDirectory, "required-server-files.js");
  const [jsonSource, javascriptSource] = await Promise.all([
    readFile(jsonPath, "utf8"),
    readFile(javascriptPath, "utf8"),
  ]);
  if (!javascriptSource.startsWith(SERVER_FILES_PREFIX)) {
    throw new Error("Next required-server-files.js had an unexpected format.");
  }

  const sourceManifest = requireRecord(
    JSON.parse(jsonSource),
    "Next server files manifest",
  );
  const sourceConfig = requireRecord(
    sourceManifest.config,
    "Next server files manifest config",
  );
  const tracingRootValue = sourceConfig.outputFileTracingRoot;
  if (typeof tracingRootValue !== "string" || !isAbsolute(tracingRootValue)) {
    throw new Error("config.outputFileTracingRoot did not contain an absolute path.");
  }
  const resolvedTracingRoot = resolve(tracingRootValue);
  const canonicalTracingRoot = await realpath(resolvedTracingRoot);
  if (
    !isAncestorPath(resolvedTracingRoot, resolvedRoot)
    || !isAncestorPath(canonicalTracingRoot, canonicalRoot)
  ) {
    throw new Error("config.outputFileTracingRoot must contain the Next application directory.");
  }

  const tracingDestination = portablePath(relative(resolvedRoot, resolvedTracingRoot) || ".");
  const rootRelocations: BuildRootRelocation[] = [];
  addRootRelocation(rootRelocations, resolvedRoot, ".");
  addRootRelocation(rootRelocations, canonicalRoot, ".");
  addRootRelocation(rootRelocations, resolvedTracingRoot, tracingDestination);
  addRootRelocation(rootRelocations, canonicalTracingRoot, tracingDestination);

  const manifest = sanitizeRequiredServerFilesManifest(sourceManifest, rootRelocations);
  const serialized = JSON.stringify(manifest, null, 2);
  const jsonTemporaryPath = `${jsonPath}.${String(process.pid)}.tmp`;
  const javascriptTemporaryPath = `${javascriptPath}.${String(process.pid)}.tmp`;
  await Promise.all([
    writeFile(jsonTemporaryPath, `${serialized}\n`, { encoding: "utf8", mode: 0o644 }),
    writeFile(javascriptTemporaryPath, `${SERVER_FILES_PREFIX}${serialized}\n`, {
      encoding: "utf8",
      mode: 0o644,
    }),
  ]);
  await Promise.all([
    rename(jsonTemporaryPath, jsonPath),
    rename(javascriptTemporaryPath, javascriptPath),
  ]);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url) && process.env.VERCEL !== "1") {
  await sanitizeRequiredServerFiles(process.cwd());
}
