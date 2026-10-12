"use client";

/**
 * A primary action with the rest of its family behind one chevron.
 *
 * The report's topbar re-runs through one: the obvious action and the
 * neighbours nobody should have to hunt for, which is exactly the shape a
 * split control is for — the alternative was a row of equal buttons where the
 * obvious one stopped being obvious.
 *
 * The obvious action is the caller's own button (`children`, classed
 * `button primary rp-split-main`), an ActionButton, which keeps a press made
 * before the page's code runs.
 */

import type { ReactNode } from "react";

import { Dropdown } from "./dropdown";

export interface SplitOption {
  label: string;
  onPick: () => void;
}

function ChevronDown() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function SplitControl({
  children,
  compact = false,
  disabled = false,
  menuLabel,
  options,
}: {
  /** The obvious action: the caller's own button. */
  children: ReactNode;
  /** The 30px metrics the topbar and the workbench share; 32px otherwise. */
  compact?: boolean;
  /** Every option in the menu, while a press is in flight. */
  disabled?: boolean;
  menuLabel: string;
  options: readonly SplitOption[];
}) {
  return (
    <Dropdown.Root className={`rp-split${compact ? " rp-split-sm" : ""}`}>
      {children}
      {options.length ? (
        <>
          {/* Named by structure, not by class: the icon-only control is the one
              carrying data-menu-trigger, so the 30px/0-padding exception cannot
              go stale when this control is renamed. */}
          <Dropdown.Trigger className="button primary rp-split-more" aria-label={menuLabel} data-menu-trigger>
            <ChevronDown />
          </Dropdown.Trigger>
          <Dropdown.Content className="row-menu-content row-menu rp-split-menu">
            {options.map((option) => (
              <Dropdown.Close key={option.label}>
                <button type="button" disabled={disabled} onClick={option.onPick}>{option.label}</button>
              </Dropdown.Close>
            ))}
          </Dropdown.Content>
        </>
      ) : null}
    </Dropdown.Root>
  );
}
