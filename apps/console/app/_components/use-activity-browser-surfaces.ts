"use client";

import { type Dispatch, type SetStateAction, useEffect, useState } from "react";

import type { PageDialogState } from "./activity-browser-message";
import type { BrowserNavState } from "./browser-mockup-chrome";

/**
 * Everything the live stream can raise over the canvas: the control lease and
 * why it was refused, the navigation state the mockup chrome paints, and the
 * three side channels a takeover has to answer — dialogs, the file chooser and
 * download notices.
 */
export interface ActivityBrowserSurfaces {
  controlGranted: boolean;
  controlDenied: string | null;
  navState: BrowserNavState | null;
  pageDialog: PageDialogState | null;
  dialogPromptText: string;
  fileChooserOpen: boolean;
  downloadNote: string | null;
  setControlGranted: Dispatch<SetStateAction<boolean>>;
  setControlDenied: Dispatch<SetStateAction<string | null>>;
  setNavState: Dispatch<SetStateAction<BrowserNavState | null>>;
  setPageDialog: Dispatch<SetStateAction<PageDialogState | null>>;
  setDialogPromptText: Dispatch<SetStateAction<string>>;
  setFileChooserOpen: Dispatch<SetStateAction<boolean>>;
  setDownloadNote: Dispatch<SetStateAction<string | null>>;
}

export function useActivityBrowserSurfaces(takeoverRequested: boolean): ActivityBrowserSurfaces {
  const [controlGranted, setControlGranted] = useState(false);
  const [controlDenied, setControlDenied] = useState<string | null>(null);
  const [navState, setNavState] = useState<BrowserNavState | null>(null);
  const [pageDialog, setPageDialog] = useState<PageDialogState | null>(null);
  const [dialogPromptText, setDialogPromptText] = useState("");
  const [fileChooserOpen, setFileChooserOpen] = useState(false);
  const [downloadNote, setDownloadNote] = useState<string | null>(null);
  // Leaving takeover clears every takeover-scoped surface.
  useEffect(() => {
    if (takeoverRequested) return;
    setControlGranted(false);
    setControlDenied(null);
    setPageDialog(null);
    setFileChooserOpen(false);
  }, [takeoverRequested]);
  useEffect(() => {
    if (!downloadNote) return;
    const timer = window.setTimeout(() => setDownloadNote(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [downloadNote]);
  return {
    controlGranted,
    controlDenied,
    navState,
    pageDialog,
    dialogPromptText,
    fileChooserOpen,
    downloadNote,
    setControlGranted,
    setControlDenied,
    setNavState,
    setPageDialog,
    setDialogPromptText,
    setFileChooserOpen,
    setDownloadNote,
  };
}
