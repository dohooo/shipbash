const CONTROL_LEFT = 0xffe3;
const SHIFT_LEFT = 0xffe1;
const REMOTE_COPY_TIMEOUT_MS = 1_000;
const EDITING_SHORTCUTS = new Map([
  ["a", { keysym: 0x0061, code: "KeyA" }],
  ["c", { keysym: 0x0063, code: "KeyC", copiesRemoteText: true }],
  ["x", { keysym: 0x0078, code: "KeyX", copiesRemoteText: true }],
  ["z", { keysym: 0x007a, code: "KeyZ" }],
]);

function isNoVncControlEditor(target) {
  if (!target || typeof target !== "object") return false;
  if (target.id === "noVNC_keyboardinput") return false;
  const tagName = typeof target.tagName === "string" ? target.tagName.toLowerCase() : "";
  return tagName === "input" || tagName === "textarea" || target.isContentEditable === true;
}

/** The Command/Meta key itself, however the event spells it. */
function isMetaModifier(event, key) {
  return event.code === "MetaLeft"
    || event.code === "MetaRight"
    || key === "meta";
}

/** A paste chord on either platform, unshifted and unaltered. */
function isPasteShortcut(event, key) {
  return (event.metaKey || event.ctrlKey)
    && !event.altKey
    && !event.shiftKey
    && (event.code === "KeyV" || key === "v");
}

/** A macOS editing chord for one of EDITING_SHORTCUTS, by code or by character. */
function isMacEditingShortcut(event, key, shortcut) {
  return event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && shortcut
    && (event.code === shortcut.code || key === String.fromCharCode(shortcut.keysym));
}

function keysymForCodePoint(codePoint) {
  if (codePoint === 0x09) return 0xff09;
  if (codePoint === 0x0a || codePoint === 0x0d) return 0xff0d;
  if ((codePoint >= 0x20 && codePoint <= 0x7e)
    || (codePoint >= 0xa0 && codePoint <= 0xff)) return codePoint;
  return 0x01000000 | codePoint;
}

function typeTextIntoRemote(rfb, text) {
  for (const character of text) {
    const keysym = keysymForCodePoint(character.codePointAt(0));
    rfb.sendKey(keysym, "Unidentified", true);
    rfb.sendKey(keysym, "Unidentified", false);
  }
}

function sendEditingShortcut(rfb, shortcut, shiftKey) {
  rfb.sendKey(CONTROL_LEFT, "ControlLeft", true);
  if (shiftKey) rfb.sendKey(SHIFT_LEFT, "ShiftLeft", true);
  rfb.sendKey(shortcut.keysym, shortcut.code, true);
  rfb.sendKey(shortcut.keysym, shortcut.code, false);
  if (shiftKey) rfb.sendKey(SHIFT_LEFT, "ShiftLeft", false);
  rfb.sendKey(CONTROL_LEFT, "ControlLeft", false);
}

export function installShipBashClipboardBridge({
  root,
  clipboard,
  getRfb,
  schedule,
  reportIssue = () => undefined,
}) {
  let clipboardRfb = null;
  let remoteCopyRequest = 0;
  const shortcutRoot = root.defaultView ?? root;

  const receiveRemoteClipboard = (event) => {
    const text = event?.detail?.text;
    if (!remoteCopyRequest || typeof text !== "string" || !text) return;
    remoteCopyRequest = 0;
    if (typeof clipboard?.writeText !== "function") {
      reportIssue("clipboard-write-unavailable");
      return;
    }
    Promise.resolve(clipboard.writeText(text)).catch(() => reportIssue("clipboard-write-failed"));
  };

  const refreshClipboardListener = () => {
    const nextRfb = getRfb();
    if (nextRfb === clipboardRfb) return nextRfb;
    clipboardRfb?.removeEventListener?.("clipboard", receiveRemoteClipboard);
    clipboardRfb = nextRfb;
    clipboardRfb?.addEventListener?.("clipboard", receiveRemoteClipboard);
    return clipboardRfb;
  };

  const handlePaste = (event) => {
    if (isNoVncControlEditor(event.target)) return;
    const text = event.clipboardData?.getData("text/plain") ?? "";
    const rfb = refreshClipboardListener();
    if (!text || !rfb) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      rfb.clipboardPasteFrom(text);
      typeTextIntoRemote(rfb, text);
    } catch {
      reportIssue("clipboard-send-failed");
    }
  };

  const handleEditingShortcut = (event) => {
    const key = String(event.key).toLowerCase();
    const metaModifier = isMetaModifier(event, key);
    if (metaModifier && !isNoVncControlEditor(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const pasteShortcut = isPasteShortcut(event, key);
    if (pasteShortcut && !isNoVncControlEditor(event.target)) {
      // Keep the browser's native paste action so ClipboardEvent.clipboardData
      // remains the primary, permission-free source of pasted text. Stop noVNC
      // from translating Command into Alt before that event is emitted.
      event.stopImmediatePropagation();
      return;
    }

    const shortcut = EDITING_SHORTCUTS.get(key);
    const macEditingShortcut = isMacEditingShortcut(event, key, shortcut);
    if (!macEditingShortcut || isNoVncControlEditor(event.target)) return;
    const rfb = refreshClipboardListener();
    if (!rfb) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (shortcut.copiesRemoteText) {
      const request = ++remoteCopyRequest;
      schedule(() => {
        if (remoteCopyRequest === request) remoteCopyRequest = 0;
      }, REMOTE_COPY_TIMEOUT_MS);
    }
    try {
      sendEditingShortcut(rfb, shortcut, event.shiftKey);
    } catch {
      remoteCopyRequest = 0;
      reportIssue("keyboard-send-failed");
    }
  };

  const handleEditingShortcutKeyUp = (event) => {
    const key = String(event.key).toLowerCase();
    if (!isMetaModifier(event, key) || isNoVncControlEditor(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  shortcutRoot.addEventListener("keydown", handleEditingShortcut, true);
  shortcutRoot.addEventListener("keyup", handleEditingShortcutKeyUp, true);
  root.addEventListener("pointerdown", refreshClipboardListener, true);
  root.addEventListener("paste", handlePaste, true);

  return () => {
    remoteCopyRequest = 0;
    shortcutRoot.removeEventListener("keydown", handleEditingShortcut, true);
    shortcutRoot.removeEventListener("keyup", handleEditingShortcutKeyUp, true);
    root.removeEventListener("pointerdown", refreshClipboardListener, true);
    root.removeEventListener("paste", handlePaste, true);
    clipboardRfb?.removeEventListener?.("clipboard", receiveRemoteClipboard);
  };
}

export function installShipBashViewerBridge({
  root,
  getRfb,
  postState,
  onRfbChanged = () => {},
  canInput = () => false,
  repeat,
  stopRepeating,
}) {
  const style = root.createElement("style");
  style.textContent = [
    "#noVNC_control_bar_anchor,#noVNC_control_bar{display:none!important}",
    "html,body,#noVNC_container{width:100%!important;height:100%!important;margin:0!important;overflow:hidden!important}",
    "#noVNC_container{inset:0!important;display:flex!important;align-items:center!important;justify-content:center!important;border-radius:0!important;background:#f3f3f1!important}",
  ].join("");
  root.head.append(style);

  let connectedRfb = null;
  const reportConnected = () => postState("connected");
  const reportDisconnected = () => postState("disconnected");
  const refreshRfb = () => {
    const nextRfb = getRfb();
    if (!nextRfb) return;
    if (nextRfb !== connectedRfb) {
      connectedRfb?.removeEventListener?.("connect", reportConnected);
      connectedRfb?.removeEventListener?.("disconnect", reportDisconnected);
      connectedRfb = nextRfb;
      onRfbChanged(connectedRfb);
      connectedRfb.addEventListener?.("connect", reportConnected);
      connectedRfb.addEventListener?.("disconnect", reportDisconnected);
    }
    connectedRfb.scaleViewport = true;
    connectedRfb.clipViewport = false;
    connectedRfb.resizeSession = false;
    const viewOnly = !canInput();
    if (connectedRfb.viewOnly !== viewOnly) connectedRfb.viewOnly = viewOnly;
    // noVNC can finish its handshake before this bridge observes UI.rfb. In
    // that race the one-shot `connect` event is already gone, so poll the
    // current RFB state as the authoritative readiness signal.
    if (connectedRfb._rfbConnectionState === "connected") reportConnected();
  };

  postState("connecting");
  const interval = repeat(refreshRfb, 100);
  refreshRfb();

  return () => {
    stopRepeating(interval);
    connectedRfb?.removeEventListener?.("connect", reportConnected);
    connectedRfb?.removeEventListener?.("disconnect", reportDisconnected);
    onRfbChanged(null);
    style.remove();
  };
}
