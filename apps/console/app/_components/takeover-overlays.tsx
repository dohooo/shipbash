"use client";

import { useState } from "react";

/** What the page's dialog is asking of the reader. */
function dialogTitle(kind: string): string {
  if (kind === "confirm") return "The page asks";
  if (kind === "prompt") return "The page needs input";
  return "The page says";
}

/** Why control ended, when the reason is one the viewer can act on. */
function interruptionNote(denied: string | null): string {
  return denied === "superseded" ? " — another tab took over" : "";
}

/**
 * The page asked for a file. Mounted for the whole takeover so an upload in
 * flight and the error it left behind outlive the chooser closing.
 */
function TakeoverFileChooser({ open, uploadFile, onFilesChosen }: {
  open: boolean;
  uploadFile?: ((file: File) => Promise<string>) | undefined;
  onFilesChosen: (names: string[]) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  if (!open) return null;
  return (
    <div className="takeover-dialog" role="dialog" aria-label="Choose a file">
      <div>
        <strong>The page asks for a file</strong>
        {uploadFile ? (
          <>
            <p>{uploading ? "Uploading…" : "Pick a file from this computer; it is copied into the sandbox browser."}</p>
            {uploadError ? <p className="inline-error" role="alert">{uploadError}</p> : null}
            <input
              type="file"
              disabled={uploading}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                setUploading(true);
                setUploadError(null);
                uploadFile(file)
                  .then((name) => onFilesChosen([name]))
                  .catch(() => setUploadError("The file could not be uploaded. Try a smaller file."))
                  .finally(() => setUploading(false));
              }}
            />
          </>
        ) : (
          <p>File uploads are unavailable for this takeover.</p>
        )}
        <div className="takeover-dialog-actions">
          <button type="button" className="button" disabled={uploading} onClick={() => onFilesChosen([])}>
            Continue without a file
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * What a takeover surfaces over the live canvas: control-interruption chips,
 * page dialogs the remote browser raised, the file chooser it opened, and
 * download notes. The happy path renders nothing at all — a takeover in good
 * health shows only the page.
 */
export function TakeoverOverlays({
  controlling,
  preparing,
  denied,
  error,
  onRetryPrepare,
  dialog,
  dialogPromptText,
  onDialogPromptText,
  onDialogRespond,
  fileChooserOpen,
  uploadFile,
  onFilesChosen,
  downloadNote,
}: {
  controlling: boolean;
  preparing: boolean;
  denied: string | null;
  error: string | null;
  onRetryPrepare?: (() => void) | undefined;
  dialog: { kind: string; message: string; defaultPrompt: string } | null;
  dialogPromptText: string;
  onDialogPromptText: (value: string) => void;
  onDialogRespond: (accept: boolean) => void;
  fileChooserOpen: boolean;
  uploadFile?: ((file: File) => Promise<string>) | undefined;
  onFilesChosen: (names: string[]) => void;
  downloadNote: string | null;
}) {
  return (
    <>
      {/* A takeover on a parked walk starts a browser on demand, and that
          takes a moment. Saying so is the whole difference between a wait
          that reads as progress and one that reads as nothing happening. */}
      {preparing && !error ? (
        <div className="takeover-statusbar">
          <span className="takeover-chip" role="status">Restoring the browser…</span>
        </div>
      ) : null}
      {/* The happy path stays chrome-free: only trouble surfaces a chip. */}
      {error || (!controlling && !preparing && denied) ? (
        <div className="takeover-statusbar">
          {error ? (
            <span className="takeover-chip error" role="alert">
              {error}
              {onRetryPrepare ? (
                <button type="button" onClick={onRetryPrepare}>Retry</button>
              ) : null}
            </span>
          ) : (
            <span className="takeover-chip error" role="alert">
              Control was interrupted{interruptionNote(denied)}.
            </span>
          )}
        </div>
      ) : null}
      {downloadNote ? (
        <div className="takeover-note" role="status">{downloadNote}</div>
      ) : null}
      {dialog ? (
        <div className="takeover-dialog" role="alertdialog" aria-label="Page dialog">
          <div>
            <strong>{dialogTitle(dialog.kind)}</strong>
            <p>{dialog.message || "(no message)"}</p>
            {dialog.kind === "prompt" ? (
              <input
                type="text"
                value={dialogPromptText}
                onChange={(event) => onDialogPromptText(event.target.value)}
                // biome-ignore lint/a11y/noAutofocus: the page raised this prompt over the takeover; the field is the only thing to act on, and the reader did not choose to open it.
                autoFocus
              />
            ) : null}
            <div className="takeover-dialog-actions">
              {dialog.kind !== "alert" ? (
                <button type="button" className="button" onClick={() => onDialogRespond(false)}>Cancel</button>
              ) : null}
              <button type="button" className="button primary" onClick={() => onDialogRespond(true)}>OK</button>
            </div>
          </div>
        </div>
      ) : null}
      <TakeoverFileChooser open={fileChooserOpen} uploadFile={uploadFile} onFilesChosen={onFilesChosen} />
    </>
  );
}
