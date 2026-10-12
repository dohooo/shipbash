import {
  bindGitHubRepositoryContract,
  disconnectGitHubContract,
  readGitHubRepositoryContract,
  unbindGitHubRepositoryContract,
} from "@shipbash/contracts/api/github";
import { callApi } from "./api-client";

export const githubClient = {
  bindGitHubRepository: (
    teamId: string,
    projectId: string,
    body: { connectionId: string; repositoryId: number },
  ) => callApi(bindGitHubRepositoryContract, { params: { teamId, projectId }, body }),
  readGitHubRepository: (teamId: string, projectId: string) => callApi(
    readGitHubRepositoryContract,
    { params: { teamId, projectId } },
  ),
  unbindGitHubRepository: (teamId: string, projectId: string) => callApi(
    unbindGitHubRepositoryContract,
    { params: { teamId, projectId } },
  ),
  disconnectGitHub: (teamId: string, connectionId: string) => callApi(
    disconnectGitHubContract,
    { params: { teamId, connectionId } },
  ),
};
