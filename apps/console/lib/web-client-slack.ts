import {
  abandonSlackInstallContract,
  bindSlackChannelContract,
  confirmSlackConnectContract,
  disconnectSlackWorkspaceContract,
  testSlackBindingContract,
  unbindSlackChannelContract,
} from "@shipbash/contracts/api/slack";
import { callApi } from "./api-client";

export const slackClient = {
  disconnectSlackWorkspace: (teamId: string, workspaceId: string) => callApi(
    disconnectSlackWorkspaceContract,
    { params: { teamId, workspaceId } },
  ),
  abandonSlackInstall: (teamId: string) => callApi(abandonSlackInstallContract, {
    params: { teamId },
  }),
  bindSlackChannel: (
    teamId: string,
    projectId: string,
    channelId: string,
    body: { workspaceId: string },
  ) => callApi(bindSlackChannelContract, { params: { teamId, projectId, channelId }, body }),
  testSlackBinding: (teamId: string, projectId: string, channelId: string) => callApi(
    testSlackBindingContract,
    { params: { teamId, projectId, channelId } },
  ),
  unbindSlackChannel: (teamId: string, projectId: string, channelId: string) => callApi(
    unbindSlackChannelContract,
    { params: { teamId, projectId, channelId } },
  ),
  confirmSlackConnect: (signInId: string) => callApi(confirmSlackConnectContract, {
    params: { signInId },
  }),
};
