"use client";

import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "../../components/ai-elements/prompt-input";
import { connectingCopy, connectingDetail, fallbackTitleFor } from "./activity-browser-panes";
import { BrowserIdlePlaceholder } from "./browser-idle-placeholder";
import { BrowserMockupChrome } from "./browser-mockup-chrome";
import { ConversationFlow } from "./conversation/conversation-flow";
import { ConversationSplit } from "./conversation/conversation-split";
import { COLD_BOOT, openingFlow } from "./discovery-conversation";
import { Status } from "./shell";

/**
 * The takeover page before its run has answered: a run's stage beside its
 * conversation — the mockup chrome, the empty frame, the conversation's first
 * boot row. The takeover page is always split, so this is the layout it
 * opens on. It stands in for the page while the server reads (the page's
 * ProductPage fallback), which is before the workspace is known, so it draws
 * no product address; the page, while its run or session is still pending
 * (run-takeover-session.tsx), draws the same stage. The Activity page draws
 * no such picture: its layout depends on the Activity (PendingActivityPage).
 * Nothing here is live: the controls are drawn, not wired, and the whole stage
 * is inert — a picture of the page, not a second copy of its surfaces.
 */
export function TakeoverPageSkeleton() {
  return (
    <div className="page activity-page" aria-busy="true" aria-hidden="true" inert>
      <ConversationSplit
        stage={(
          <div className="activity-main">
            <section className="workbench" aria-label="Discovery workspace">
              <header className="workbench-head">
                <fieldset className="activity-filters" aria-label="Discovery view">
                  <button type="button" aria-pressed="true">Browser</button>
                  <button type="button" aria-pressed="false">Journeys (0)</button>
                </fieldset>
                <span className="workbench-status"><Status status="starting" pill /></span>
              </header>
              <div className="workbench-body" data-tab="browser">
                <section className="activity-browser browser-mockup" aria-label="Live Activity browser">
                  <BrowserMockupChrome address="" title={fallbackTitleFor("")} />
                  <div className="browser-stage">
                    <div className="browser-frame">
                      <BrowserIdlePlaceholder working title={connectingCopy(false)} copy={connectingDetail(false, false)} />
                    </div>
                  </div>
                </section>
              </div>
              <footer className="workbench-foot">
                <button className="workbench-follow" type="button" role="switch" aria-checked="true" disabled>
                  <span className="follow-track" aria-hidden="true"><span className="follow-knob" /></span>
                  <span className="follow-label">Follow agent</span>
                </button>
                <div className="workbench-actions" />
              </footer>
            </section>
          </div>
        )}
        conversation={(
          <div className="activity-side">
            <section className="agent-chat" aria-label="Agent conversation">
              <ConversationFlow messages={openingFlow(COLD_BOOT)} streaming />
              <PromptInput className="agent-chat-input" onSubmit={() => undefined}>
                <PromptInputBody>
                  <PromptInputTextarea placeholder="The agent is starting…" disabled />
                </PromptInputBody>
                <PromptInputFooter className="agent-chat-input-footer">
                  <PromptInputSubmit disabled />
                </PromptInputFooter>
              </PromptInput>
            </section>
          </div>
        )}
      />
    </div>
  );
}
