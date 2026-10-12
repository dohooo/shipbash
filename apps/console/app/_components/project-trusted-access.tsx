"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { toast } from "sonner";

import { type Project, readQuery, type TrustedAccess, useIntentKey, webClient } from "../../lib/web-client";
import { hostnameOf } from "../_lib/hostname";
import { projectError } from "./project-error";
import { useWorkspace } from "./shell";

const cloudflareSecurityRulesHref = "https://dash.cloudflare.com/?to=%2F%3Aaccount%2F%3Azone%2Fsecurity%2Fsecurity-rules";

/** The host the Skip rule matches, named as a placeholder when the Project has no URL to parse. */
function productionHost(project: Project): string {
  return hostnameOf(project.productionUrl) ?? "your-production-host";
}

/** A fresh access key, generated in the browser so the service only ever stores its digest. */
function accessSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Every write the section can make. They live together because they share one
 * cache entry: each writes the row the section reads back, so the page never
 * shows a state the service has already moved past.
 */
function useTrustedAccessControls(project: Project) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { teamHref } = useWorkspace();
  const save = useMutation({
    mutationFn: (secret: string) => webClient.saveTrustedAccess(project.id, {
      mode: "cloudflare_header",
      headerName: "x-shipbash-access",
      secret,
    }),
    onSuccess: (data) => {
      queryClient.setQueryData(readQuery("trustedAccess", project.id).queryKey, data);
      toast.success("Access key created");
    },
    onError: (error) => toast.error(projectError(error)),
  });
  // The secret is the one a save stored, for as long as that save is this
  // page's. Next keeps a page the reader left mounted, hidden, rather than
  // unmounting it; hiding it cleans up its effects, so the save is let go when
  // the page is left, even one that answers after.
  const generatedSecret = save.isSuccess ? save.variables : null;
  useEffect(() => save.reset, [save.reset]);
  const verify = useMutation({
    mutationFn: () => webClient.verifyTrustedAccess(project.id),
    onSuccess: (data) => {
      queryClient.setQueryData(readQuery("trustedAccess", project.id).queryKey, {
        trustedAccess: data.trustedAccess,
      });
      if (data.verified) {
        toast.success("Trusted access verified");
      } else {
        toast.error("ShipBash is still being challenged", {
          description: "Check that the Cloudflare Skip rule is active and placed before the challenge rule.",
          duration: Infinity,
          closeButton: true,
        });
      }
    },
    onError: (error) => toast.error(projectError(error)),
  });
  const remove = useMutation({
    mutationFn: () => webClient.removeTrustedAccess(project.id),
    onSuccess: () => {
      save.reset();
      queryClient.setQueryData(readQuery("trustedAccess", project.id).queryKey, { trustedAccess: null });
      toast.success("Trusted access removed");
    },
    onError: (error) => toast.error(projectError(error)),
  });
  // The Activity is passed in by the control that offers the retry, which only
  // exists while there is one to recover. Each Activity's retry is its own intent.
  const retryKeys = useIntentKey();
  const retry = useMutation({
    mutationFn: (activityId: string) => webClient.retryActivity(project.id, activityId, retryKeys.key(activityId)),
    onSuccess: ({ activity }, activityId) => {
      retryKeys.spend(activityId);
      router.push(teamHref(`/activities/${encodeURIComponent(activity.id)}`));
    },
    onError: (error) => toast.error(projectError(error)),
  });
  return {
    createAccessKey: () => save.mutate(accessSecret()),
    /** Held only until the reader leaves the page; the API never sends a secret back. */
    generatedSecret,
    mutating: save.isPending || verify.isPending || remove.isPending,
    remove,
    retry,
    saving: save.isPending,
    verify,
  };
}

/**
 * The one-time Cloudflare rule while the secret is still in hand, and the note
 * that replaces it once the key is stored and the secret is gone for good.
 */
function TrustedAccessRule({ access, expression }: { access: TrustedAccess | null; expression: string | null }) {
  if (expression) {
    return (
      <div className="trusted-access-rule">
        <p>Open Cloudflare, select the Production zone, then create a custom WAF <strong>Skip</strong> rule before the challenge rule. The expression is copied for you.</p>
        <code>{expression}</code>
        <a
          className="button primary"
          href={cloudflareSecurityRulesHref}
          target="_blank"
          rel="noreferrer"
          onClick={() => void navigator.clipboard.writeText(expression).then(
            () => toast.success("Rule expression copied"),
            () => toast.error("Could not copy the expression"),
          )}
        >
          Copy rule &amp; open Cloudflare
        </a>
      </div>
    );
  }
  if (access) {
    return <p className="trusted-access-note">The access key is stored securely. Rotate it if you need to copy a new Cloudflare rule expression.</p>;
  }
  return null;
}

/** What a stored key can be put through. The Activity retry waits on a verified key. */
function TrustedAccessActions({ access, activityId, controls }: {
  access: TrustedAccess;
  activityId: string | null;
  controls: ReturnType<typeof useTrustedAccessControls>;
}) {
  return (
    <div className="actions-row">
      <button className="button primary" type="button" disabled={controls.mutating} onClick={() => controls.verify.mutate()}>
        {controls.verify.isPending ? "Verifying…" : "Verify access"}
      </button>
      {access.status === "ready" && activityId ? (
        <button className="button" type="button" disabled={controls.retry.isPending} onClick={() => controls.retry.mutate(activityId)}>
          {controls.retry.isPending ? "Retrying…" : "Retry Activity"}
        </button>
      ) : null}
      <button className="button" type="button" disabled={controls.mutating} onClick={controls.createAccessKey}>Rotate key</button>
      <button
        className="button"
        type="button"
        disabled={controls.mutating}
        onClick={() => { if (window.confirm("Remove trusted production access?")) controls.remove.mutate(); }}
      >
        Remove
      </button>
    </div>
  );
}

/**
 * Trusted access: the Cloudflare Skip rule that lets only ShipBash's test
 * browser past the challenge. The stored row is read by the settings page,
 * which is what decides whether this section is on screen at all.
 */
export function TrustedAccessSection({ access, activityId, project }: {
  /** The stored key, read before the section draws; null when there is none. */
  access: TrustedAccess | null;
  /** The Activity waiting on this access, when the reader arrived from one. */
  activityId: string | null;
  project: Project;
}) {
  const controls = useTrustedAccessControls(project);
  const ruleExpression = controls.generatedSecret
    ? `http.host eq "${productionHost(project)}" and any(http.request.headers["x-shipbash-access"][*] eq "${controls.generatedSecret}")`
    : null;

  return (
    <section className="trusted-access" aria-labelledby="trusted-access-title">
      <div className="trusted-access-heading">
        <div>
          <span>Production access</span>
          <h2 id="trusted-access-title">Trusted access</h2>
          <p>Allow only ShipBash&apos;s test browser through the Cloudflare challenge.</p>
        </div>
        {access ? <span className={`trusted-access-status ${access.status}`}>{access.status === "ready" ? "Verified" : "Not verified"}</span> : null}
      </div>
      {!access ? (
        <button className="button primary" type="button" disabled={controls.mutating} onClick={controls.createAccessKey}>
          {controls.saving ? "Creating…" : "Create access key"}
        </button>
      ) : null}
      <TrustedAccessRule access={access} expression={ruleExpression} />
      {access ? <TrustedAccessActions access={access} activityId={activityId} controls={controls} /> : null}
    </section>
  );
}
