/**
 * A Slack thread's to-do list, drawn where the bot token is: the Sandbox's
 * throttle (slack-chat/work-progress.ts) asks for a draw of its job's work,
 * and the server builds the painter for that one draw.
 */
import { z } from "zod";

import { threadListPainter } from "../../slack-chat/thread-lists.ts";
import { jobWork } from "../../slack-chat/work-progress.ts";
import { defineJobMethod, type JobContext } from "../define.ts";

/** The job's work as it stands, in the list of the thread that started it; nothing for work no thread started. */
async function drawJobWork({ store, publicOrigin, job }: JobContext): Promise<void> {
  const work = jobWork(job);
  if (work) await threadListPainter({ store: store.internal, publicOrigin }).show(work);
}

export const progressMethods = {
  drawWorkProgress: defineJobMethod<[], void>({ args: z.tuple([]), run: drawJobWork }),
};
