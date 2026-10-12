"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Pencil, Plus, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { ApiError, readQuery, webClient } from "../../lib/web-client";
import { readKey } from "../../lib/queries";
import { QueryError, SectionLoading } from "./shell";
import { SignInMark } from "./sign-in-methods";
import styles from "./github-authenticator.module.css";
import { GitHubAuthenticatorCode } from "./github-authenticator-code";

interface AuthenticatorTarget { projectId: string; signInId: string }
type AuthenticatorData = Awaited<ReturnType<typeof webClient.readGitHubAuthenticator>>;

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "ShipBash could not update this authenticator.";
}

/** A compact row action shared by the team and project sign-in lists. */
export function GitHubAuthenticatorAction({ projectId, signInId, onOpen }: AuthenticatorTarget & { onOpen: () => void }) {
  const query = useQuery(readQuery("readGitHubAuthenticator", projectId, signInId));
  const saved = query.data?.authenticator;
  return (
    <>
      {saved ? <span className="status-pill positive">Authenticator configured</span> : null}
      <button className="button" type="button" onClick={onOpen} disabled={query.isPending}>
        {saved ? "Manage authenticator" : "Add authenticator"}
      </button>
    </>
  );
}

/**
 * The team list's authenticator: a fact in the account line, and the fact is
 * the action. It reads nothing until the saved state is known, so the line
 * never shows an "add" that turns into "configured".
 */
export function GitHubAuthenticatorFact({ projectId, signInId, onOpen }: AuthenticatorTarget & { onOpen: () => void }) {
  const query = useQuery(readQuery("readGitHubAuthenticator", projectId, signInId));
  if (!query.data) return null;
  const saved = Boolean(query.data.authenticator);
  const label = saved ? "Manage authenticator" : "Add authenticator";
  return (
    <>
      <i aria-hidden="true">·</i>
      <button
        className={saved ? "signin-fact" : "signin-fact is-empty"}
        type="button"
        title={label}
        aria-label={saved ? "Authenticator configured. Manage authenticator" : label}
        onClick={onOpen}
      >
        {saved ? <KeyRound aria-hidden="true" /> : <Plus aria-hidden="true" />}
        <span>{saved ? "Authenticator" : label}</span>
        {saved ? <Pencil className="signin-fact-edit" aria-hidden="true" /> : null}
      </button>
    </>
  );
}

function useAuthenticatorEditor({ projectId, signInId }: AuthenticatorTarget) {
  const queryClient = useQueryClient();
  const [secret, setSecret] = useState("");
  const read = readQuery("readGitHubAuthenticator", projectId, signInId);
  const { queryKey } = read;
  const query = useQuery(read);
  const save = useMutation({
    mutationFn: () => webClient.saveGitHubAuthenticator(projectId, signInId, { secret: secret.trim() }),
    onError: () => { void queryClient.invalidateQueries({ queryKey }); },
    // The save answers with the authenticator as the read does, so it goes
    // into the cache before the key field is emptied, never after it.
    onSuccess: async (saved) => {
      queryClient.setQueryData(queryKey, saved);
      setSecret("");
      await queryClient.invalidateQueries({ queryKey: readKey("authAttention", projectId) });
    },
  });
  const remove = useMutation({
    mutationFn: () => webClient.removeGitHubAuthenticator(projectId, signInId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
      setSecret("");
    },
  });
  return { query, save, remove, secret, setSecret, accountLogin: query.data?.accountLogin };
}

type EditorState = ReturnType<typeof useAuthenticatorEditor>;

function KeyForm({ state, saved, formId }: { state: EditorState; saved: boolean; formId: string }) {
  if (!state.accountLogin) return null;
  return (
    <form id={formId} onSubmit={(event) => { event.preventDefault(); state.save.mutate(); }}>
      <label className="form-field">
        <input
          type="password"
          aria-label={saved ? "Replacement TOTP setup key" : "TOTP setup key"}
          placeholder={saved ? "Replacement key or otpauth:// link" : "Setup key or otpauth:// link"}
          maxLength={4096}
          autoComplete="off"
          spellCheck={false}
          value={state.secret}
          onChange={(event) => state.setSecret(event.target.value)}
          disabled={state.save.isPending || state.remove.isPending}
          required
        />
      </label>
      {state.save.isError ? <p className="inline-error" role="alert">{errorMessage(state.save.error)}</p> : null}
    </form>
  );
}

function AuthenticatorLoaded({ state, data, formId, target, busy }: { state: EditorState; data: AuthenticatorData; formId: string; target: AuthenticatorTarget; busy: boolean }) {
  const saved = data.authenticator;
  const login = state.accountLogin;
  return (
    <>
      {login ? (
        <div className={styles.account}>
          <SignInMark method="github" />
          <strong title={`@${login}`}>@{login}</strong>
          {saved ? (
            <span className={styles.accountMeta}>
              {!busy ? <GitHubAuthenticatorCode {...target} /> : null}
              <span className={styles.divider} aria-hidden="true" />
              <span className="status-pill positive">Configured</span>
            </span>
          ) : null}
        </div>
      ) : (
        <p className={styles.hint} role="status">
          ShipBash did not read which GitHub account this sign-in belongs to when it was saved.
          Sign in to GitHub again to add an authenticator, then remove this sign-in.
        </p>
      )}
      <KeyForm state={state} saved={Boolean(saved)} formId={formId} />
      {state.remove.isError ? <p className="inline-error" role="alert">{errorMessage(state.remove.error)}</p> : null}
    </>
  );
}

/** The key is write-only, and sealed under the account GitHub named when the session was saved. */
export function GitHubAuthenticatorEditor({ projectId, signInId, onClose }: AuthenticatorTarget & { onClose: () => void }) {
  const state = useAuthenticatorEditor({ projectId, signInId });
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const formId = useId();
  const busy = state.save.isPending || state.remove.isPending;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog className={styles.dialog} ref={dialog} aria-labelledby={headingId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <header className={styles.header}>
        <div>
          <h2 id={headingId}>GitHub authenticator</h2>
          <p>Automatically complete GitHub verification.</p>
        </div>
        <button className={styles.close} type="button" aria-label="Close authenticator" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      <div className={styles.body}>
        {state.query.isPending ? <SectionLoading /> : null}
        {state.query.isLoadingError ? <QueryError error={state.query.error} retry={() => void state.query.refetch()} /> : null}
        {state.query.data ? <AuthenticatorLoaded state={state} data={state.query.data} formId={formId} target={{ projectId, signInId }} busy={busy} /> : null}
      </div>
      <footer className={styles.footer}>
        {state.query.data?.authenticator ? (
          <button className={styles.remove} type="button" onClick={() => state.remove.mutate()} disabled={busy}>
            {state.remove.isPending ? "Removing…" : "Remove authenticator"}
          </button>
        ) : null}
        {state.accountLogin ? (
          <button className="button primary" type="submit" form={formId} disabled={busy || !state.secret.trim()}>
            {state.save.isPending ? "Saving…" : "Save"}
          </button>
        ) : null}
      </footer>
    </dialog>
  );
}
