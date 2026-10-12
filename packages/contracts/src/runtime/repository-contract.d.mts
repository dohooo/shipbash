/** The GitHub repository a task's agents read, as the runtime input names it. */
export interface RuntimeRepository {
  owner: string;
  name: string;
  defaultBranch: string;
}

export declare function validateRuntimeRepository(value: unknown, field?: string): RuntimeRepository | null;
