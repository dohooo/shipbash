import { useEffect, useState } from "react";

/** What a coding agent sets ShipBash up from. The waitlist admission email carries the same line. */
const SETUP_LINE = "Read shipbash.dev/setup.md and set up ShipBash for this project.";

/** The agents the line is meant for, as the Lobe Icons logos in public/agents. */
const AGENTS = [
  { name: "Claude Code", icon: "/agents/claude-code.svg" },
  { name: "Codex", icon: "/agents/codex.svg" },
  { name: "Cursor", icon: "/agents/cursor.svg" },
];

/** The way in: one line to paste into Claude Code, Codex or Cursor, one press from the clipboard. */
export function AgentSetup({
  onHover,
  onCopied,
}: {
  onHover?: (hovering: boolean) => void;
  onCopied?: () => void;
}) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (copy !== "copied") return;
    const timer = setTimeout(() => setCopy("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copy]);

  const copyLine = async () => {
    try {
      await navigator.clipboard.writeText(SETUP_LINE);
      setCopy("copied");
      onCopied?.();
    } catch {
      setCopy("failed");
    }
  };

  return (
    <>
      <div className="url-cta">
        <code>{SETUP_LINE}</code>
        <button
          type="button"
          aria-label="Copy"
          onClick={() => void copyLine()}
          onPointerEnter={() => onHover?.(true)}
          onPointerLeave={() => onHover?.(false)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            {copy === "copied" ? (
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            ) : (
              <>
                <rect x="9" y="9" width="12" height="12" rx="2" />
                <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
              </>
            )}
          </svg>
        </button>
        <span className="agent-avatars">
          {AGENTS.map((agent) => (
            <img key={agent.name} src={agent.icon} alt={agent.name} title={agent.name} />
          ))}
          <span className="agent-more" title="And more">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="5" cy="12" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="19" cy="12" r="2" />
            </svg>
            <span className="sr-only">And more</span>
          </span>
        </span>
      </div>
      <span className="sr-only" role="status">{copy === "copied" ? "Copied" : ""}</span>
      {copy === "failed" ? <p className="url-error" role="alert">Could not copy. Select the line and copy it.</p> : null}
    </>
  );
}
