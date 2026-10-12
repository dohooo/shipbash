"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";

/**
 * The one way in ShipBash uses by itself, which is why it is a form and not a
 * browser. Two fields are required. The other two are stated rather than
 * hidden — an account with two-step codes cannot be signed into without its
 * secret, and asking for it only after the first failure is worse than asking
 * for it now — but they are folded away behind one line.
 */

export interface PasswordDraft {
  email: string;
  password: string;
  totpSecret: string;
  loginUrl: string;
}

const DISCLOSURE_LABEL = "Two-step codes, or a login page elsewhere";

export function emptyPasswordDraft(loginUrl: string): PasswordDraft {
  return { email: "", password: "", totpSecret: "", loginUrl };
}

export function SignInPasswordForm({ draft, onChange, disclosed = false }: {
  draft: PasswordDraft;
  onChange: (draft: PasswordDraft) => void;
  /** A failure that names the login page opens the second line for the reader. */
  disclosed?: boolean;
}) {
  const [open, setOpen] = useState(disclosed);
  const field = (key: keyof PasswordDraft) => (event: { target: { value: string } }) =>
    onChange({ ...draft, [key]: event.target.value });
  return (
    <div className="auth-card-form">
      <div className="auth-form">
        <label className="form-field">
          <span>Account</span>
          <input type="text" value={draft.email} spellCheck={false} onChange={field("email")} />
        </label>
        <label className="form-field">
          <span>Password</span>
          <input type="password" value={draft.password} onChange={field("password")} />
        </label>
      </div>
      <button className="auth-disclosure" type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronDown aria-hidden="true" />{DISCLOSURE_LABEL}
      </button>
      {open || disclosed ? (
        <div className="auth-form">
          <label className="form-field">
            <span>TOTP secret <em>optional</em></span>
            <input type="text" value={draft.totpSecret} spellCheck={false} onChange={field("totpSecret")} />
          </label>
          <label className="form-field">
            <span>Login page <em>optional</em></span>
            <input type="text" value={draft.loginUrl} spellCheck={false} onChange={field("loginUrl")} />
          </label>
        </div>
      ) : null}
    </div>
  );
}
