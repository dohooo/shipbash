/** How the runner reaches the broker: a Docker container's host gateway, or a process beside it on loopback. */
export type TaskBrokerHost = "host.docker.internal" | "127.0.0.1";

/** What a broker answers from: the task API methods it has. A missing one is refused. */
export interface TaskBrokerSource {
  credentialsRead?(input: unknown): Promise<unknown>;
  credentialsOutcome?(input: unknown): Promise<unknown>;
  agentTool?(input: unknown): Promise<unknown>;
  repositoryToken?(): Promise<unknown>;
}

export interface TaskBroker {
  config: { endpoint: string; token: string };
  close(): void;
}

export function createTaskBroker(context: {
  source: TaskBrokerSource;
  host: TaskBrokerHost;
  signal: AbortSignal;
}): Promise<TaskBroker>;

/** A sign-in check's source, and the one account its leg is offered. */
export function signInCheckSource(check: {
  signInId: string;
  signInPageUrl: string;
  credential: { email: string; password: string; totpSecret: string | null };
}): TaskBrokerSource & { signIns: unknown[] };
