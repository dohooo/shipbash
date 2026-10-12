"use client";

import type { ChatStatus } from "ai";

import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "../../components/ai-elements/prompt-input";

// The submit control is vendored (ai-elements); its `status?: ChatStatus` stays as shipped, so the
// prop is present only while streaming instead of being passed as undefined.
const submitStatus: ChatStatus = "streaming";

/** The free-text composer under an agent conversation: a trimmed, non-empty message goes to onSend. */
export function ChatComposer({ onSend, sendBusy, streaming = false, onStop = null }: {
  onSend: (text: string) => void;
  sendBusy: boolean;
  /** The agent is working, so the submit control shows as streaming. */
  streaming?: boolean;
  /** Cancels the running activity; wired to the submit control's Stop affordance. */
  onStop?: (() => void) | null;
}) {
  return (
    <PromptInput
      className="agent-chat-input"
      onSubmit={(message) => {
        const text = message.text.trim();
        if (text) onSend(text);
      }}
    >
      <PromptInputBody>
        <PromptInputTextarea placeholder="Tell the agent what to explore next…" disabled={sendBusy} />
      </PromptInputBody>
      <PromptInputFooter className="agent-chat-input-footer">
        <PromptInputSubmit
          disabled={sendBusy}
          {...(streaming ? { status: submitStatus } : {})}
          {...(onStop ? { onStop } : {})}
        />
      </PromptInputFooter>
    </PromptInput>
  );
}
