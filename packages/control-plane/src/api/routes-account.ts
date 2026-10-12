import { firstHandled } from "./route-handler.ts";
import { handleAccountCore } from "./routes-account-core.ts";
import { handleAccountGitHub } from "./routes-account-github.ts";
import { handleAccountSlack } from "./routes-account-slack.ts";
import {
	handleCreateInvitation,
	handleMemberMutation,
	handleMembers,
	handleRevokeInvitation,
	handleRunAllowance,
	handleRunDays,
} from "./routes-account-team.ts";

export const handleAccount = firstHandled(
	handleAccountCore,
	handleMembers,
	handleRunAllowance,
	handleRunDays,
	handleCreateInvitation,
	handleAccountGitHub,
	handleAccountSlack,
	handleRevokeInvitation,
	handleMemberMutation,
);
