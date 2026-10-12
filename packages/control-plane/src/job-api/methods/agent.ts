/**
 * The agent's data on demand: a leg's or a run's opening, the read tools,
 * record_knowledge and propose_edit, each answered from the record under the
 * job's scope (agent-data/). Only those two write; the job API client sends a
 * call to one again only when it provably never left (job-api.mjs).
 */
import { z } from "zod";

import { AGENT_DATA_TOOLS, AGENT_WRITE_TOOLS } from "@shipbash/contracts/runtime/agent-data-contract.mjs";

import type { AgentDataAnswer, AgentDataToolCall } from "../../agent-data/index.ts";
import type { SignedLegOpening, SuiteRunOpening } from "../../agent-data/opening.ts";
import { signSteerImages } from "../../agent-data/steer-images.ts";
import { defineJobMethod } from "../define.ts";

// Each tool's own schema checks `args` (runAgentDataTool); here only its shape.
const toolCall = z.object({
  name: z.enum([...AGENT_DATA_TOOLS, ...AGENT_WRITE_TOOLS]),
  args: z.record(z.string(), z.unknown()),
  caseId: z.string().min(1).max(200).nullable(),
});

export const agentMethods = {
  activityOpening: defineJobMethod<[], SignedLegOpening>({
    args: z.tuple([]),
    run: async ({ store, artifactStorage, capability }) => {
      const execution = await store.jobs.loadDispatchExecutionInput(capability);
      if (execution.kind !== "activity") throw new Error("Dispatch Job is not an Activity.");
      const opening = await store.agentData.activityOpening(capability, execution);
      // The images its steers carry are read by the task, over signed reads of this leg's own.
      return { ...opening, pendingSteers: await signSteerImages(opening.pendingSteers, artifactStorage) };
    },
  }),
  suiteOpening: defineJobMethod<[], SuiteRunOpening>({
    args: z.tuple([]),
    run: async ({ store, artifactStorage, capability }) => {
      const execution = await store.jobs.loadDispatchExecutionInput(capability);
      if (execution.kind !== "suite_run") throw new Error("Dispatch Job is not a Suite Run.");
      return store.agentData.suiteOpening(capability, execution, artifactStorage);
    },
  }),
  agentTool: defineJobMethod<[AgentDataToolCall], AgentDataAnswer>({
    args: z.tuple([toolCall]),
    run: ({ store, artifactStorage, capability }, call) => store.agentData.runTool(capability, call, artifactStorage),
  }),
};
