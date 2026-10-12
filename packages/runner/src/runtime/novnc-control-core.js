const MAX_NONCE_LENGTH = 128;
const MAX_SNAPSHOT_LENGTH = 6_000_000;

export function noVncBridgeConfig(href) {
  try {
    const url = new URL(href);
    const parent = new URL(url.searchParams.get("shipbash_parent_origin") ?? "");
    const lease = new URLSearchParams(url.hash.slice(1)).get("password");
    if (!/^https?:$/.test(parent.protocol) || parent.href !== `${parent.origin}/` || !lease) return null;
    return { parentOrigin: parent.origin, lease };
  } catch { return null; }
}

function post(session, type, fields = {}) {
  if (!session.disposed) session.parentWindow.postMessage({ type, ...fields }, session.parentOrigin);
}

function lock(session) {
  session.enabled = false;
  if (!session.rfb) return;
  session.rfb._shipbashControlAuthorized = false;
  session.rfb.viewOnly = true;
}

function report(session, force = false) {
  if (!session.nonce) return;
  const state = session.connectionState;
  if (force || state !== session.lastReportedState) post(session, "shipbash-novnc-state", { nonce: session.nonce, state });
  session.lastReportedState = state;
  if (session.connected && session.painted && (force || session.lastReadyNonce !== session.nonce)) {
    post(session, "shipbash-novnc-ready", { nonce: session.nonce });
    session.lastReadyNonce = session.nonce;
  }
}

function valid(session, event, data) {
  return event.source === session.parentWindow && event.origin === session.parentOrigin
    && data && typeof data === "object" && !Array.isArray(data)
    && typeof data.nonce === "string" && data.nonce.length > 0
    && data.nonce.length <= MAX_NONCE_LENGTH && data.lease === session.lease
    && Object.keys(data).length <= 4;
}

function freeze(session) {
  lock(session);
  session.retiredNonce = session.nonce;
  try {
    const canvas = session.rfb?._canvas;
    if (!canvas || !session.connected || !session.painted) throw new Error("not_ready");
    const snapshot = canvas.toDataURL("image/jpeg", 0.82);
    if (!snapshot.startsWith("data:image/jpeg;base64,") || snapshot.length > MAX_SNAPSHOT_LENGTH) {
      throw new Error("snapshot_invalid");
    }
    post(session, "shipbash-novnc-snapshot", { nonce: session.nonce, snapshot });
  } catch { post(session, "shipbash-novnc-error", { nonce: session.nonce, code: "snapshot_unavailable" }); }
  session.nonce = null;
  session.lastReadyNonce = null;
}

function handleMessage(session, event) {
  const data = event.data;
  if (!valid(session, event, data)) return;
  if (data.type === "shipbash-novnc-authorize") {
    if (data.nonce === session.retiredNonce) return;
    if (session.nonce !== data.nonce) {
      lock(session);
      session.lastReportedState = null;
      session.lastReadyNonce = null;
    }
    session.nonce = data.nonce;
    report(session, true);
    return;
  }
  if (data.nonce !== session.nonce) return;
  if (data.type === "shipbash-novnc-enable") {
    if (!session.rfb || !session.connected || !session.painted) return;
    session.enabled = true;
    session.rfb._shipbashControlAuthorized = true;
    session.rfb.viewOnly = false;
    post(session, "shipbash-novnc-enabled", { nonce: session.nonce });
  } else if (data.type === "shipbash-novnc-freeze") {
    freeze(session);
  } else if (data.type === "shipbash-novnc-revoke") {
    lock(session);
    session.retiredNonce = session.nonce;
    session.nonce = null;
    session.lastReportedState = null;
    session.lastReadyNonce = null;
  }
}

/** The iframe is read-only until a current parent nonce enables a painted RFB. */
export function installNoVncControlBridge({ root, selfWindow, parentWindow, parentOrigin, lease }) {
  const session = {
    root, selfWindow, parentWindow, parentOrigin, lease,
    rfb: null, connected: false, connectionState: "connecting", painted: false, nonce: null, retiredNonce: null,
    enabled: false, disposed: false, lastReportedState: null, lastReadyNonce: null,
  };
  const message = (event) => handleMessage(session, event);
  const framePainted = (event) => {
    if (event.target !== session.rfb?._canvas) return;
    session.painted = true;
    report(session);
  };
  selfWindow.addEventListener("message", message);
  root.addEventListener("shipbash-frame-painted", framePainted);
  post(session, "shipbash-novnc-hello", { protocol: 1 });
  return {
    observeRfb(nextRfb) {
      if (session.rfb === nextRfb || session.disposed) return;
      lock(session);
      session.rfb = nextRfb;
      session.connectionState = nextRfb?._rfbConnectionState === "connected" ? "connected"
        : nextRfb?._rfbConnectionState === "disconnected" ? "disconnected" : "connecting";
      session.connected = session.connectionState === "connected";
      session.painted = nextRfb?._canvas?.dataset?.shipbashRemoteFramePainted === "1";
      session.lastReportedState = null;
      session.lastReadyNonce = null;
      lock(session);
      report(session);
    },
    canInput() { return session.enabled && session.connected && session.painted && session.nonce !== null; },
    stateChanged(state) {
      if (session.disposed) return;
      const nextState = state === "connected" ? "connected" : state === "disconnected" ? "disconnected" : "connecting";
      if (session.connectionState === nextState) return;
      session.connectionState = nextState;
      session.connected = nextState === "connected";
      if (!session.connected) lock(session);
      report(session);
    },
    inputIssue(code) {
      if (session.nonce) post(session, "shipbash-novnc-input-issue", { nonce: session.nonce, code });
    },
    dispose() {
      lock(session);
      session.disposed = true;
      selfWindow.removeEventListener("message", message);
      root.removeEventListener("shipbash-frame-painted", framePainted);
    },
  };
}
