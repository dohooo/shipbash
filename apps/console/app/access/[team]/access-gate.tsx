"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { webClient } from "../../../lib/web-client";
import { LoginChassis } from "../../login/login-chassis";
import login from "../../login/login.module.css";
import styles from "./access-gate.module.css";

interface AccessGateProps {
  /** The account this page is judging, named so the reader can switch it. */
  account: string;
  /** Display names. The gate never learns an admin's email address. */
  adminNames: readonly string[];
  /** When this reader's request was filed; null until they ask. */
  requestedAt: string | null;
  /** The run the reader came for, for the sign-in round trip. */
  returnTo: string;
  /** The Team as the address names it. */
  team: string;
  teamName: string;
}

const ADMIN_LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

function admins(names: readonly string[]): string {
  return names.length > 0 ? ADMIN_LIST.format(names) : "its admins";
}

function CheckMark() {
  return (
    <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" viewBox="0 0 24 24">
      <title>Sent</title>
      <path d="m20 6-11 11-5-5" />
    </svg>
  );
}

function Account({ account, switchTo }: { account: string; switchTo: string | null }) {
  return (
    <div className={styles.account}>
      <span aria-hidden="true" className={styles.accountMark}>
        {account.slice(0, 1).toUpperCase()}
      </span>
      <span>Signed in as <b>{account}</b></span>
      {switchTo ? (
        <form action="/auth/logout" method="post">
          <input name="next" type="hidden" value={switchTo} />
          <button type="submit">Use another account</button>
        </form>
      ) : null}
    </div>
  );
}

function Ask({ account, adminNames, busy, error, onRequest, returnTo, teamName }: {
  account: string;
  adminNames: readonly string[];
  busy: boolean;
  error: Error | null;
  onRequest: () => void;
  returnTo: string;
  teamName: string;
}) {
  return (
    <>
      <h1 className={login.title} id="gate-title">You need access to this run.</h1>
      <p className={login.description}>
        It belongs to <b>{teamName}</b>. Ask and we will pass it on — you do not have to work
        out who to chase.
      </p>
      <Account account={account} switchTo={returnTo} />
      {error ? <p className={login.error} role="alert">{error.message}</p> : null}
      <button
        className={`${login.cta} ${login.ctaFull}${busy ? ` ${login.ctaBusy}` : ""}`}
        onClick={onRequest}
        type="button"
      >
        <span>Request access</span>
      </button>
      <p className={styles.aside}>
        Goes to <b>{admins(adminNames)}</b>, who {adminNames.length === 1 ? "administers" : "administer"}{" "}
        that team. Open this link again once one of them says yes.
      </p>
    </>
  );
}

function Sent({ account, adminNames, teamName }: {
  account: string;
  adminNames: readonly string[];
  teamName: string;
}) {
  return (
    <>
      <h1 className={login.title} id="gate-title">Asked. Nothing else to do.</h1>
      <div className={styles.sent}>
        <CheckMark />
        <div>
          <strong>Request sent to {teamName}</strong>
          {/* No one is paged, and a declined request is never announced either.
              This has to read the same whether the ask is still open or has
              been turned down, so it names who can grant it, not its state. */}
          <span>{admins(adminNames)} can let you in.</span>
        </div>
      </div>
      <Account account={account} switchTo={null} />
      <p className={styles.aside}>
        This link will open the run as soon as one of them adds you. You can close this tab.
      </p>
    </>
  );
}

export function AccessGate({ account, adminNames, requestedAt, returnTo, team, teamName }: AccessGateProps) {
  const [sentAt, setSentAt] = useState(requestedAt);
  const request = useMutation({
    mutationFn: () => webClient.requestTeamAccess(team),
    onSuccess: (filed) => setSentAt(filed.requestedAt),
  });
  return (
    <LoginChassis labelledBy="gate-title" load={request.isPending ? 1 : 0}>
      {sentAt ? (
        <Sent account={account} adminNames={adminNames} teamName={teamName} />
      ) : (
        <Ask
          account={account}
          adminNames={adminNames}
          busy={request.isPending}
          error={request.error}
          onRequest={() => request.mutate()}
          returnTo={returnTo}
          teamName={teamName}
        />
      )}
    </LoginChassis>
  );
}
