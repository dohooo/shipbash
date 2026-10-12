import { command } from "./command.ts";
import {
  DEFAULT_HOST,
  SUPABASE_DATABASE_CONTAINER,
  SUPABASE_DATABASE_DEPENDENTS,
  SUPABASE_NETWORK,
} from "./constants.ts";

export function publiclyBoundSupabasePorts(rawDockerPs: string): string[] {
  return rawDockerPs
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        (/(?:^|[,\s])0\.0\.0\.0:\d+->/.test(line) || /(?:^|[,\s])\[::\]:\d+->/.test(line)),
    );
}

export async function warnIfSupabasePortsArePublic(
  dockerBinary: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const bindings = await command(dockerBinary, [
    "ps",
    "--filter",
    "label=com.supabase.cli.project=shipbash",
    "--format",
    "{{.Names}}\t{{.Ports}}",
  ], { env: environment });
  if (bindings.exitCode !== 0) {
    process.stderr.write(
      `ShipBash warning: could not verify local Supabase port bindings: ${bindings.stderr.trim()}\n`,
    );
    return;
  }
  const publicBindings = publiclyBoundSupabasePorts(bindings.stdout);
  if (publicBindings.length === 0) return;
  process.stderr.write(
    [
      "ShipBash warning: Docker published local Supabase on all network interfaces even though ShipBash requested a loopback-only network.",
      `Exposed bindings: ${publicBindings.join("; ")}`,
      "Supabase Studio is disabled; keep this development machine on a trusted network while these ports are running.",
      "",
    ].join("\n"),
  );
}

export async function ensureLoopbackNetwork(
  dockerBinary: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const inspected = await command(dockerBinary, [
    "network",
    "inspect",
    SUPABASE_NETWORK,
    "--format",
    "{{ index .Options \"com.docker.network.bridge.host_binding_ipv4\" }}",
  ], { env: environment });
  if (inspected.exitCode === 0) {
    if (inspected.stdout.trim() !== DEFAULT_HOST) {
      throw new Error(
        `Docker network ${SUPABASE_NETWORK} exists without loopback-only port binding.`,
      );
    }
    return;
  }
  const created = await command(dockerBinary, [
    "network",
    "create",
    "--opt",
    `com.docker.network.bridge.host_binding_ipv4=${DEFAULT_HOST}`,
    SUPABASE_NETWORK,
  ], { env: environment });
  if (created.exitCode !== 0) {
    throw new Error(`Could not create the ShipBash loopback network: ${created.stderr.trim()}`);
  }
}

export function containerUsesDockerNetwork(rawNetworks: string, network: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawNetworks);
  } catch {
    throw new Error("Docker returned invalid container network metadata.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Docker returned invalid container network metadata.");
  }
  return Object.hasOwn(parsed, network);
}

export async function repairExistingSupabaseDatabaseNetwork(
  dockerBinary: string,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  const inspected = await command(dockerBinary, [
    "inspect",
    "--format",
    "{{json .NetworkSettings.Networks}}",
    SUPABASE_DATABASE_CONTAINER,
  ], { env: environment });
  if (inspected.exitCode !== 0) return false;
  if (containerUsesDockerNetwork(inspected.stdout.trim(), SUPABASE_NETWORK)) return false;
  const connected = await command(dockerBinary, [
    "network",
    "connect",
    "--alias",
    SUPABASE_DATABASE_CONTAINER,
    SUPABASE_NETWORK,
    SUPABASE_DATABASE_CONTAINER,
  ], { env: environment });
  if (connected.exitCode !== 0) {
    throw new Error(
      `Could not attach the existing Supabase database to ${SUPABASE_NETWORK}: ${connected.stderr.trim()}`,
    );
  }
  for (const container of SUPABASE_DATABASE_DEPENDENTS) {
    const dependent = await command(dockerBinary, ["inspect", container], { env: environment });
    if (dependent.exitCode !== 0) continue;
    const restarted = await command(dockerBinary, ["restart", container], { env: environment });
    if (restarted.exitCode !== 0) {
      throw new Error(`Could not restart ${container} after repairing the Supabase network.`);
    }
  }
  return true;
}
