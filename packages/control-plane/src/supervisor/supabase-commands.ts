export type LocalSupabaseMaintenanceAction = "stop" | "reset" | "lint";

export function localSupabaseMigrationArgs(workdir: string): string[] {
  return ["migration", "up", "--local", "--workdir", workdir, "--yes"];
}

export function localSupabaseMaintenanceArgs(
  action: LocalSupabaseMaintenanceAction,
  workdir: string,
): string[] {
  if (action === "stop") return ["stop", "--workdir", workdir, "--yes"];
  if (action === "reset") {
    return ["db", "reset", "--local", "--workdir", workdir, "--yes"];
  }
  return [
    "db",
    "lint",
    "--local",
    "--workdir",
    workdir,
    "--level",
    "warning",
    "--fail-on",
    "error",
  ];
}

export function supabaseResetReachedRestartPhase(output: string): boolean {
  return output.includes("Restarting containers...");
}
