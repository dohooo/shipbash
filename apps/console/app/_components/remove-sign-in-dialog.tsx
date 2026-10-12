"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";

import styles from "./github-authenticator.module.css";

/**
 * Removing a way in deletes the team's saved session, and it sits in the row's
 * menu rather than beside its status, so it asks first and says what it costs.
 */
export function RemoveSignInDialog({ name, products, pending, error, onConfirm, onClose }: {
  name: string;
  /** The names of the products that use this way in. */
  products: readonly string[];
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog className={`${styles.dialog} ${styles.confirm}`} ref={dialog} aria-labelledby={headingId}
      onCancel={(event) => { event.preventDefault(); if (!pending) onClose(); }}>
      <header className={styles.header}>
        <div><h2 id={headingId}>Remove {name}?</h2></div>
        <button className={styles.close} type="button" aria-label="Cancel" onClick={onClose} disabled={pending}>
          <X aria-hidden="true" />
        </button>
      </header>
      <div className={styles.body}>
        <p>
          {products.length > 0 ? (
            <>
              <b>{products.join(", ")}</b> {products.length === 1 ? "uses" : "use"} this way in. Runs there
              won’t be able to sign in with it, and the saved session is deleted for the whole team.
            </>
          ) : "No product uses this way in. The saved session is deleted for the whole team."}
        </p>
        {error ? <p className="inline-error" role="alert">{error}</p> : null}
      </div>
      <footer className={styles.footer}>
        <button className="button" type="button" onClick={onClose} disabled={pending}>Cancel</button>
        <button className="button destructive" type="button" onClick={onConfirm} disabled={pending}>
          {pending ? "Removing…" : "Remove"}
        </button>
      </footer>
    </dialog>
  );
}
