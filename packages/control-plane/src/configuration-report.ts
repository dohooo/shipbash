/**
 * What reading the configuration found wrong, gathered across every group so
 * an operator hears about all of it at once: each variable that is absent,
 * and a sentence for each value that is present but unusable.
 */
export interface ConfigurationReport {
  missing: string[];
  invalid: string[];
}

type Environment = NodeJS.ProcessEnv;

/** The trimmed value, or null after noting the variable as missing. */
export function requiredValue(environment: Environment, name: string, report: ConfigurationReport): string | null {
  const value = environment[name]?.trim();
  if (value) return value;
  report.missing.push(name);
  return null;
}

export function optionalValue(environment: Environment, name: string): string | null {
  return environment[name]?.trim() || null;
}

/**
 * Whether a group of variables that go together, all of them or none, is
 * configured: false when none is set, and false after noting the rest when
 * only some are.
 */
export function configuredGroup(environment: Environment, names: readonly string[], report: ConfigurationReport): boolean {
  const present = names.filter((name) => optionalValue(environment, name));
  if (present.length === 0) return false;
  const absent = names.filter((name) => !present.includes(name));
  if (absent.length === 0) return true;
  report.invalid.push(`${absent.join(", ")} must be configured with ${present.join(", ")}.`);
  return false;
}

/** Runs a parser that refuses with a sentence, keeping the sentence in the report. */
export function parsed<T>(report: ConfigurationReport, parse: () => T): T | null {
  try {
    return parse();
  } catch (error) {
    report.invalid.push(error instanceof Error ? error.message : String(error));
    return null;
  }
}

export function hasProblems(report: ConfigurationReport): boolean {
  return report.missing.length > 0 || report.invalid.length > 0;
}

/** One error naming everything the configuration lacks or gets wrong. */
export class ConfigurationError extends Error {
  readonly missing: readonly string[];
  readonly invalid: readonly string[];

  constructor(report: ConfigurationReport) {
    super([
      "ShipBash is not configured completely:",
      ...(report.missing.length > 0 ? [`  missing: ${report.missing.join(", ")}`] : []),
      ...report.invalid.map((sentence) => `  ${sentence}`),
      "Set them in .env or .env.local (see .env.example and .env.local.example), or in the deployment's environment.",
    ].join("\n"));
    this.name = "ConfigurationError";
    this.missing = report.missing;
    this.invalid = report.invalid;
  }
}
