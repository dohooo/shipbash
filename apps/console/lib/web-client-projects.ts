import {
  archiveProjectContract,
  createProjectContract,
  updateProjectContract,
} from "@shipbash/contracts/api/projects";
import {
  updateVerificationShareContract,
} from "@shipbash/contracts/api/public-verifications";
import { callApi } from "./api-client";
import type { AgentRuntime } from "./web-client-types";

export const projectsClient = {
  updateVerificationShare: (projectId: string, runId: string, isPublic: boolean) => callApi(
    updateVerificationShareContract,
    { params: { projectId, runId }, body: { isPublic } },
  ),
  createProject: (
    teamId: string,
    input: {
      productionUrl: string;
      agentRuntime?: AgentRuntime;
      clientIdempotencyKey: string;
    },
  ) => callApi(createProjectContract, { params: { teamId }, body: input }),
  deleteProject: (projectId: string) => callApi(archiveProjectContract, {
    params: { projectId },
  }),
  updateProject: (
    projectId: string,
    input: {
      productionUrl: string;
      testingContext?: string | null;
    },
  ) => callApi(updateProjectContract, { params: { projectId }, body: input }),
};
