import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { App } from "@octokit/app";
import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";

import type { GitHubIntegration } from "./configuration-integrations.ts";
import { isErrno } from "./errno.ts";
import { createGitHubApp, type GitHubAppConfiguration } from "./github-app.ts";
import { LocalSecretStore } from "./local-secret-store.ts";

const APP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,99})$/u;
const SECRET_REFERENCE_PATTERN = /^local-secret:\/\/[0-9a-f-]{36}$/u;
const MAX_METADATA_BYTES = 16 * 1024;

export type GitHubAppMode = "managed" | "local_manifest";

interface LocalGitHubAppMetadata {
  version: 2;
  appId: number;
  slug: string;
  privateKeyReference: string;
  clientId: string;
  clientSecretReference: string;
  createdAt: string;
}

export interface GitHubAppProviderStatus {
  mode: GitHubAppMode;
  configured: boolean;
  registrationAllowed: boolean;
  configurationInvalid: boolean;
}

export interface GitHubAppProviderOptions {
  /** The deployment's own App, or the manifest flow's, as the configuration decided (configuration-integrations.ts). */
  integration: GitHubIntegration;
  /** Where the manifest flow keeps the App it registers. */
  shipbashDirectory: string;
  createApp?: (configuration: GitHubAppConfiguration) => App;
}

/** Where the hosted runtime keeps a manifest-registered App: the function's own scratch directory. */
const HOSTED_SHIPBASH_DIRECTORY = "/tmp/shipbash-control";

/** The App provider of the hosted runtime, for the console's resources and a conversation's turn alike. */
export function hostedGitHubAppProvider(integration: GitHubIntegration): GitHubAppProvider {
  return new GitHubAppProvider({ integration, shipbashDirectory: HOSTED_SHIPBASH_DIRECTORY });
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("GitHub App private directory must be a real directory.");
  }
  await chmod(path, 0o700);
}

function parseMetadata(value: string, path: string): LocalGitHubAppMetadata {
  if (Buffer.byteLength(value, "utf8") > MAX_METADATA_BYTES) {
    throw new Error("Local GitHub App metadata is too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Local GitHub App metadata is invalid.");
  }
  if (!isRecord(parsed)) {
    throw new Error("Local GitHub App metadata is invalid.");
  }
  if (parsed.version === 1) {
    // Version 1 kept no OAuth client, and connecting needs one.
    throw new Error(`The local GitHub App was registered before connecting needed its OAuth client: delete ${path} and register the App again from Settings › GitHub.`);
  }
  if (!isLocalGitHubAppMetadata(parsed)) {
    throw new Error("Local GitHub App metadata is invalid.");
  }
  return parsed;
}

// A value has to clear every field check before the record is read as
// metadata.
function isLocalGitHubAppMetadata(
  record: Record<string, unknown>,
): record is Record<string, unknown> & LocalGitHubAppMetadata {
  return record.version === 2
    && Number.isSafeInteger(record.appId)
    && Number(record.appId) >= 1
    && typeof record.slug === "string"
    && APP_SLUG_PATTERN.test(record.slug)
    && typeof record.privateKeyReference === "string"
    && SECRET_REFERENCE_PATTERN.test(record.privateKeyReference)
    && typeof record.clientId === "string"
    && record.clientId.length > 0
    && typeof record.clientSecretReference === "string"
    && SECRET_REFERENCE_PATTERN.test(record.clientSecretReference)
    && typeof record.createdAt === "string"
    && Number.isFinite(Date.parse(record.createdAt));
}

export class GitHubAppProvider {
  readonly #createApp: (configuration: GitHubAppConfiguration) => App;
  readonly #metadataPath: string;
  readonly #privateDirectory: string;
  readonly #secretStore: LocalSecretStore;
  readonly #managedConfiguration: GitHubAppConfiguration | null;
  #cachedApp: App | null | undefined;

  constructor(options: GitHubAppProviderOptions) {
    this.#createApp = options.createApp ?? createGitHubApp;
    this.#privateDirectory = resolve(options.shipbashDirectory, "private");
    this.#metadataPath = join(this.#privateDirectory, "github-app.json");
    this.#secretStore = new LocalSecretStore(this.#privateDirectory, "github-app-secrets");
    this.#managedConfiguration = "app" in options.integration ? options.integration.app : null;
  }

  get mode(): GitHubAppMode {
    return this.#managedConfiguration ? "managed" : "local_manifest";
  }

  async status(): Promise<GitHubAppProviderStatus> {
    let configured: boolean;
    try {
      configured = Boolean(await this.getApp());
    } catch {
      return {
        mode: this.mode,
        configured: false,
        registrationAllowed: false,
        configurationInvalid: true,
      };
    }
    return {
      mode: this.mode,
      configured,
      registrationAllowed: this.mode === "local_manifest" && !configured,
      configurationInvalid: false,
    };
  }

  async getApp(): Promise<App | null> {
    if (this.#managedConfiguration) {
      this.#cachedApp ??= this.#createApp(this.#managedConfiguration);
      return this.#cachedApp;
    }
    if (this.#cachedApp !== undefined) return this.#cachedApp;
    const metadata = await this.#readMetadata();
    if (!metadata) {
      this.#cachedApp = null;
      return null;
    }
    const privateKey = await this.#secretStore.resolve(metadata.privateKeyReference);
    const clientSecret = await this.#secretStore.resolve(metadata.clientSecretReference);
    this.#cachedApp = this.#createApp({
      appId: metadata.appId,
      privateKey,
      oauth: { clientId: metadata.clientId, clientSecret },
    });
    return this.#cachedApp;
  }

  registrationName(): string {
    if (this.mode !== "local_manifest") {
      throw new Error("Local GitHub App registration is unavailable.");
    }
    return `ShipBash Local ${randomBytes(8).toString("hex")}`;
  }

  async saveLocalApp(input: {
    appId: number;
    slug: string;
    privateKey: string;
    createdAt: string;
    oauth: { clientId: string; clientSecret: string };
  }): Promise<void> {
    if (this.mode !== "local_manifest") {
      throw new Error("Local GitHub App registration is unavailable.");
    }
    if (
      !Number.isSafeInteger(input.appId)
      || input.appId < 1
      || !APP_SLUG_PATTERN.test(input.slug)
      || !/-----BEGIN (?:RSA )?PRIVATE KEY-----/u.test(input.privateKey)
      || !/-----END (?:RSA )?PRIVATE KEY-----/u.test(input.privateKey)
      || !Number.isFinite(Date.parse(input.createdAt))
    ) {
      throw new Error("GitHub returned invalid App credentials.");
    }
    const app = this.#createApp({ appId: input.appId, privateKey: input.privateKey, oauth: input.oauth });
    const previous = await this.#readMetadata();
    const privateKeyReference = await this.#secretStore.put(input.privateKey);
    const clientSecretReference = await this.#secretStore.put(input.oauth.clientSecret);
    const metadata: LocalGitHubAppMetadata = {
      version: 2,
      appId: input.appId,
      slug: input.slug,
      privateKeyReference,
      clientId: input.oauth.clientId,
      clientSecretReference,
      createdAt: input.createdAt,
    };
    const temporaryPath = `${this.#metadataPath}.${randomUUID()}.tmp`;
    try {
      await secureDirectory(dirname(this.#metadataPath));
      await writeFile(temporaryPath, `${JSON.stringify(metadata)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporaryPath, this.#metadataPath);
      this.#cachedApp = app;
    } catch (error) {
      await Promise.allSettled([
        rm(temporaryPath, { force: true }),
        this.#secretStore.delete(privateKeyReference),
        this.#secretStore.delete(clientSecretReference),
      ]);
      throw error;
    }
    if (previous) {
      await Promise.allSettled([
        this.#secretStore.delete(previous.privateKeyReference),
        this.#secretStore.delete(previous.clientSecretReference),
      ]);
    }
  }

  async #readMetadata(): Promise<LocalGitHubAppMetadata | null> {
    let raw: string;
    try {
      const metadata = await lstat(this.#metadataPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("Local GitHub App metadata must be a real file.");
      }
      raw = await readFile(this.#metadataPath, "utf8");
      await chmod(this.#metadataPath, 0o600);
    } catch (error) {
      if (isErrno(error) && error.code === "ENOENT") return null;
      throw error;
    }
    return parseMetadata(raw, this.#metadataPath);
  }
}
