/**
 * Every method of the job API, by its wire name. A method is declared in its
 * group's file once; the server, both ports and the remote worker store loop
 * over this one table.
 */
import type { AnyJobMethod } from "./define.ts";
import { agentMethods } from "./methods/agent.ts";
import { preparationMethods } from "./methods/preparation.ts";
import { progressMethods } from "./methods/progress.ts";
import { storageMethods } from "./methods/storage.ts";
import { storeMethods } from "./methods/store.ts";

export const jobMethods = {
  ...storeMethods,
  ...progressMethods,
  ...preparationMethods,
  ...storageMethods,
  ...agentMethods,
};

export type JobMethods = typeof jobMethods;
export type JobMethodName = keyof JobMethods;

export function isJobMethodName(name: string): name is JobMethodName {
  return Object.hasOwn(jobMethods, name);
}

export const jobMethodNames: readonly JobMethodName[] = Object.keys(jobMethods).filter(isJobMethodName);

/** The method a wire name declares, with its arguments and result erased, or null for a name no group declares. */
export function jobMethod(name: string): AnyJobMethod | null {
  return isJobMethodName(name) ? jobMethods[name] : null;
}
