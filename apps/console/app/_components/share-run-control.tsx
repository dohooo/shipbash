"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import type { VerificationShare } from "@shipbash/contracts/api/public-verifications";
import { readQuery, webClient } from "../../lib/web-client";
import { readKey } from "../../lib/queries";
import { placeSearch, type RunPlace } from "../_lib/run-place";
import { readRunPlace, useRunPlace } from "./run-place";

/**
 * The link, opening the shared page where the reader is: the journey by the
 * id the shared page knows it by, and the time into its recording.
 */
function shareLink(share: VerificationShare, place: RunPlace | null): string | null {
  if (!share.shareUrl) return null;
  const journey = place?.journey ? share.caseIds[place.journey] ?? null : null;
  const search = placeSearch({ journey, atMs: place?.atMs ?? null });
  return new URL(`${share.shareUrl}${search}`, window.location.origin).href;
}

function ShareRunSettings({ share, place, pending, saveError, onChange }: {
  share: VerificationShare;
  place: RunPlace | null;
  pending: boolean;
  saveError: boolean;
  onChange: (isPublic: boolean) => void;
}) {
  const [copyError, setCopyError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const link = shareLink(share, place);
  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopyError(null);
      setCopied(true);
    } catch {
      setCopied(false);
      setCopyError("The link could not be copied. Try again.");
    }
  };
  return (
    <div className="share-run-body">
      <label>
        <input checked={!share.isPublic} disabled={pending} name="run-visibility"
          onChange={() => { if (share.isPublic) onChange(false); }} type="radio" />
        Private
      </label>
      <label>
        <input checked={share.isPublic} disabled={pending} name="run-visibility"
          onChange={() => { if (!share.isPublic) onChange(true); }} type="radio" />
        Anyone with the link
      </label>
      <p>Anyone with the link can view this run and its recordings.</p>
      {link ? (
        <div className="share-run-link">
          <input aria-label="Share link" readOnly value={link} />
          <button className="button" onClick={() => void copyLink()} type="button">
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      ) : null}
      {pending ? <p role="status">Saving…</p> : null}
      {saveError ? <p role="alert">The sharing change was not saved. Try again.</p> : null}
      {copyError ? <p role="alert">{copyError}</p> : null}
    </div>
  );
}

function ShareRunDialog({ projectId, runId, onDismiss }: {
  projectId: string;
  runId: string;
  onDismiss: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const queryClient = useQueryClient();
  // Where the reader was as they opened the dialog, as a video's share
  // dialog takes the time the moment it opens.
  const slot = useRunPlace();
  const [place] = useState(() => (slot ? readRunPlace(slot) : null));
  const share = readQuery("verificationShare", projectId, runId);
  const query = useQuery(share);
  const update = useMutation({
    mutationFn: (isPublic: boolean) => webClient.updateVerificationShare(projectId, runId, isPublic),
    onSuccess: async (saved) => {
      queryClient.setQueryData(share.queryKey, saved);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: readKey("verification", projectId, runId) }),
        queryClient.invalidateQueries({ queryKey: readKey("verifications", projectId) }),
        queryClient.invalidateQueries({ queryKey: readKey("overview", projectId) }),
        queryClient.invalidateQueries({ queryKey: readKey("journeys", projectId) }),
        queryClient.invalidateQueries({ queryKey: readKey("journey", projectId) }),
      ]);
    },
  });

  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);

  return (
    <dialog
      aria-labelledby="share-run-title"
      className="share-run-dialog"
      onCancel={(event) => { event.preventDefault(); onDismiss(); }}
      ref={dialog}
    >
      <div className="share-run-head">
        <strong id="share-run-title">Share run</strong>
        <button aria-label="Close Share run" className="button" onClick={onDismiss} type="button">Close</button>
      </div>
      {query.isPending ? <p role="status">Loading sharing settings…</p> : null}
      {query.isLoadingError ? (
        <div role="alert">
          <p>Sharing settings could not be loaded.</p>
          <button className="button" onClick={() => void query.refetch()} type="button">Retry</button>
        </div>
      ) : null}
      {query.data ? (
        <ShareRunSettings
          key={query.data.shareUrl ?? "private"}
          onChange={(isPublic) => update.mutate(isPublic)}
          pending={update.isPending}
          place={place}
          saveError={update.isError}
          share={query.data}
        />
      ) : null}
    </dialog>
  );
}

export function ShareRunControl({ projectId, runId }: { projectId: string; runId: string }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dismiss = () => {
    setOpen(false);
    queueMicrotask(() => trigger.current?.focus());
  };
  return (
    <>
      <button className="button" onClick={() => setOpen(true)} ref={trigger} type="button">Share</button>
      {open ? <ShareRunDialog onDismiss={dismiss} projectId={projectId} runId={runId} /> : null}
    </>
  );
}
