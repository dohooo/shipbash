"use client";

import { useEffect, useRef, useState } from "react";

import { webClient } from "../../lib/web-client";
import styles from "./github-authenticator.module.css";

type DisplayCode = { code: string; deadline: number };

/** Keep codes in the open dialog only, outside the shared query cache. */
function useAuthenticatorCode(projectId: string, signInId: string) {
  const [data, setData] = useState<DisplayCode | null>(null);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(true);
  const reload = useRef<() => void>(() => {});
  useEffect(() => {
    let active = true;
    let loading = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      if (loading) return;
      loading = true;
      clearTimeout(timer);
      setRefreshing(true);
      setError(false);
      const started = performance.now();
      try {
        const result = await webClient.readGitHubAuthenticatorCode(projectId, signInId);
        if (!active) return;
        // Subtract the whole request duration so transport delay cannot extend validity.
        const deadline = started + Date.parse(result.expiresAt) - Date.parse(result.serverTime);
        setData({ code: result.code, deadline });
        timer = setTimeout(() => void load(), Math.max(250, deadline - performance.now()));
      } catch {
        if (active) { setData(null); setError(true); }
      } finally {
        loading = false;
        if (active) setRefreshing(false);
      }
    };
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    reload.current = () => void load();
    void load();
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      reload.current = () => {};
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [projectId, signInId]);
  return { data, error, refreshing, retry: () => reload.current() };
}

function CodeDigits({ data }: { data: DisplayCode }) {
  const [elapsed] = useState(() => Math.max(0, Math.min(30, 30 - (data.deadline - performance.now()) / 1000)));
  const text = `${data.code.slice(0, 3)} ${data.code.slice(3)}`;
  return <>
    <output className={styles.codeText} aria-label="Current verification code">{text}</output>
    <span className={styles.codeMask} aria-hidden="true" style={{ animationDelay: `-${elapsed}s` }}>{text}</span>
  </>;
}

export function GitHubAuthenticatorCode({ projectId, signInId }: { projectId: string; signInId: string }) {
  const { data, error, refreshing, retry } = useAuthenticatorCode(projectId, signInId);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    if (!data || performance.now() >= data.deadline) return;
    try {
      await navigator.clipboard.writeText(data.code);
      setCopied(data.code);
      setCopyError(false);
    } catch { setCopyError(true); }
  };
  if (error) return <button className={styles.codeRetry} type="button" onClick={retry} title="Could not load code">Retry code</button>;
  return (
    <span className={styles.codeControl}>
      <button className={styles.code} type="button" aria-label="Copy verification code"
        title="Click to copy code" onClick={() => void copy()} disabled={!data || refreshing}>
        {data ? <CodeDigits key={data.deadline} data={data} /> : <span className={styles.codeText}>••• •••</span>}
      </button>
      {data && copied === data.code ? <span className={styles.codeFeedback} role="status">Copied</span> : null}
      {copyError ? <span className={styles.codeFeedback} role="alert">Could not copy</span> : null}
    </span>
  );
}
