"use client";

import { Streamdown } from "streamdown";

/**
 * Links are plain anchors that open in a new tab. Streamdown's default link
 * safety renders each one as a button behind an "Open external link?" dialog,
 * drawn with utility classes this build never generates.
 */
const LINKS = { enabled: false };

/**
 * Markdown inside a conversation part. The flow sets its own typography
 * (13px/1.55, no paragraph margins) — the class is the hook the `.conv-md`
 * rules hang off; a part's own class beside it sets that part's tone.
 */
export function ConversationMarkdown({
  children,
  streaming = false,
  className,
}: {
  children: string;
  streaming?: boolean;
  className?: string | undefined;
}) {
  return (
    <Streamdown
      className={className ? `conv-md ${className}` : "conv-md"}
      mode={streaming ? "streaming" : "static"}
      linkSafety={LINKS}
      skipHtml
    >
      {children}
    </Streamdown>
  );
}
