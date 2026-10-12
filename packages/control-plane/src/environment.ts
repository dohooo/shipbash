export function shipbashEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  return environment[`SHIPBASH_${name}`];
}

export function shipbashProcessEnvironmentValue(name: string): string | undefined {
  return shipbashEnvironmentValue(process.env, name);
}

/**
 * The full variable name behind a suffix, for the places that have to show an
 * operator what to set or write the assignment into a file.
 */
export function shipbashEnvironmentName(name: string): string {
  return `SHIPBASH_${name}`;
}
