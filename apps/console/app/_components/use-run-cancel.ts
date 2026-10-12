"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RunEventView } from "@shipbash/contracts/api/view-types";

import { readKey } from "../../lib/queries";
import { cancelVerification } from "../../lib/run-control-client";
import { eventTimestamp } from "./live-run-stream";

/**
 * Cancel on the live run. The run is read again once the service has taken
 * the request, so the page itself says it is canceling; a refusal becomes a
 * row in the execution log.
 */
export function useRunCancel({
	projectId,
	runId,
	appendEvent,
}: {
	projectId: string;
	runId: string;
	appendEvent: (event: RunEventView) => void;
}) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => cancelVerification(projectId, runId),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: readKey("verification", projectId, runId) }),
		onError: (cause) =>
			appendEvent({
				id: "",
				eventType: "control_error",
				kind: "system",
				level: "error",
				summary: cause instanceof Error ? cause.message : "Request failed",
				timestamp: eventTimestamp(new Date()),
			}),
	});
}
