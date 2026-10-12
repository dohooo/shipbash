/**
 * One shape, two transports: a JobPort is every method of the registry as a
 * plain async function. The local lane runs them in-process against its own
 * store (`localJobPort`), parsing the arguments with each method's own
 * schema, so a call the server would refuse fails the same way on the
 * laptop; a Sandbox sends them over HTTP (remote.ts `remoteJobPort`).
 */
import type { AnyJobMethod, JobArgs, JobContext, JobResult } from "./define.ts";
import { type JobMethodName, type JobMethods, jobMethodNames, jobMethods } from "./registry.ts";

export type JobPort = {
  readonly [Name in JobMethodName]: (...args: JobArgs<JobMethods[Name]>) => Promise<JobResult<JobMethods[Name]>>;
};

function isJobPort(port: Partial<Record<JobMethodName, unknown>>): port is JobPort {
  return jobMethodNames.every((name) => typeof port[name] === "function");
}

export function localJobPort(context: JobContext): JobPort {
  const port: Partial<Record<JobMethodName, (...args: unknown[]) => Promise<unknown>>> = {};
  for (const name of jobMethodNames) {
    const method: AnyJobMethod = jobMethods[name];
    port[name] = async (...args) => method.run(context, ...method.args.parse(args));
  }
  if (!isJobPort(port)) throw new Error("The job API port is missing a method.");
  return port;
}
