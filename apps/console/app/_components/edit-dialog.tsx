"use client";

import { useEffect, useId, type ReactNode } from "react";

/**
 * The modal frame the row editors share: a scrim that closes, a heading
 * naming the row, the host's fields, and a footer of the host's notice, its
 * save error, Cancel and Save. Escape closes.
 */
export function EditDialog({ heading, subject, notice, error, saveLabel, saveDisabled, onSave, onClose, children }: {
  heading: string;
  subject: string | null;
  /** What the host says above its error, if anything. */
  notice?: ReactNode;
  /** The failed save's message; null when the save has not failed. An empty message still shows its alert. */
  error: string | null;
  saveLabel: string;
  saveDisabled: boolean;
  onSave: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const headingId = useId();
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return (
    <>
      <button aria-label="Close the edit dialog" className="edit-scrim" type="button" onClick={onClose} />
      <dialog className="edit-modal" open aria-labelledby={headingId}>
        <div className="edit-head">
          <strong id={headingId}>{heading}</strong>
          {subject ? <code>{subject}</code> : null}
        </div>
        <div className="edit-body">{children}</div>
        <div className="edit-foot">
          {notice}
          {error !== null ? <p className="inline-error" role="alert">{error}</p> : null}
          <div className="edit-acts">
            <button className="button" type="button" onClick={onClose}>Cancel</button>
            <button className="button primary" type="button" disabled={saveDisabled} onClick={onSave}>
              {saveLabel}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
