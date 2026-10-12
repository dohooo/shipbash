/**
 * The screencast sidecar's takeover control plane: everything that turns a
 * read-only viewer into the single controller and dispatches its input.
 *
 * A viewer that presents the current control-lease token becomes the one
 * controller; its mouse/keyboard/insert-text/tab/nav/dialog/file-chooser/
 * terminal messages are dispatched, every field bounded so a hostile viewer payload
 * cannot smuggle arbitrary values into CDP. The sidecar keeps the pixels and
 * the CDP session; this module keeps who is allowed to touch them.
 */
import { basename } from "node:path";

const MAX_INBOUND_BYTES = 64 * 1024;
const MAX_INSERT_TEXT_LENGTH = 4_096;
export const PROTOCOL_VERSION = 1;
const CAPABILITIES = [
  "mouse",
  "keyboard",
  "insertText",
  "tabActivate",
  "navigation",
  "dialog",
  "fileChooser",
];

const MOUSE_EVENT_TYPES = new Set(["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"]);
const MOUSE_BUTTONS = new Set(["none", "left", "middle", "right", "back", "forward"]);
const KEY_EVENT_TYPES = new Set(["keyDown", "keyUp", "rawKeyDown", "char"]);

function finiteNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boundedInteger(value, min, max, fallback = 0) {
  const parsed = typeof value === "number" && Number.isInteger(value) ? value : fallback;
  return Math.min(max, Math.max(min, parsed));
}

// Refusals and drops carry a reason and no capability list; the read-only
// greeting and the acquire acknowledgment advertise the capabilities.
function controlState(controller, extra = {}) {
  return {
    type: "control_state",
    protocolVersion: PROTOCOL_VERSION,
    controller,
    ...("reason" in extra ? {} : { capabilities: CAPABILITIES }),
    ...extra,
  };
}

async function currentControlToken(plane) {
  if (!plane.readControlToken) return null;
  try {
    const token = await plane.readControlToken();
    return typeof token === "string" && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

function dropController(plane, reason) {
  const previous = plane.controllerClient;
  plane.controllerClient = null;
  if (previous) plane.sendTo(previous, controlState(false, { reason }));
  void setFileChooserInterception(plane, false);
}

/**
 * File-chooser interception globally swaps native pickers for CDP events,
 * so it is scoped strictly to an active human takeover: the agent's own
 * browsing (before and after) keeps stock behavior.
 */
async function setFileChooserInterception(plane, enabled) {
  const sessionId = plane.attachedSession();
  if (plane.fileChooserInterception === enabled || !sessionId) return;
  plane.fileChooserInterception = enabled;
  await plane.send("Page.setInterceptFileChooserDialog", { enabled }, sessionId).catch(() => {
    plane.fileChooserInterception = false;
  });
}

async function requireController(plane, client) {
  if (client !== plane.controllerClient || plane.controllerClient === null) return false;
  const lease = await currentControlToken(plane);
  if (!lease || lease !== client.shipbashControlToken) {
    dropController(plane, "lease_ended");
    return false;
  }
  return true;
}

async function acquireControl(plane, client, message) {
  const offered = typeof message.token === "string" ? message.token.trim() : "";
  const lease = await currentControlToken(plane);
  if (!offered || !lease || offered !== lease) {
    plane.sendTo(client, controlState(false, { reason: "invalid_token" }));
    return;
  }
  if (plane.controllerClient && plane.controllerClient !== client) dropController(plane, "superseded");
  plane.controllerClient = client;
  client.shipbashControlToken = lease;
  plane.sendTo(client, controlState(true));
  await setFileChooserInterception(plane, true);
}

async function dispatchMouse(plane, message) {
  const eventType = MOUSE_EVENT_TYPES.has(message.eventType) ? message.eventType : null;
  const sessionId = plane.attachedSession();
  if (!eventType || !sessionId) return;
  await plane.send("Input.dispatchMouseEvent", {
    type: eventType,
    x: finiteNumber(message.x),
    y: finiteNumber(message.y),
    button: MOUSE_BUTTONS.has(message.button) ? message.button : "none",
    buttons: boundedInteger(message.buttons, 0, 31),
    clickCount: boundedInteger(message.clickCount, 0, 8),
    deltaX: finiteNumber(message.deltaX),
    deltaY: finiteNumber(message.deltaY),
    modifiers: boundedInteger(message.modifiers, 0, 15),
    pointerType: "mouse",
  }, sessionId).catch(() => {});
}

async function dispatchKey(plane, message) {
  const eventType = KEY_EVENT_TYPES.has(message.eventType) ? message.eventType : null;
  const sessionId = plane.attachedSession();
  if (!eventType || !sessionId) return;
  const text = typeof message.text === "string" ? message.text.slice(0, 8) : "";
  const virtualKeyCode = boundedInteger(message.windowsVirtualKeyCode, 0, 0xFF);
  await plane.send("Input.dispatchKeyEvent", {
    type: eventType,
    key: typeof message.key === "string" ? message.key.slice(0, 32) : "",
    code: typeof message.code === "string" ? message.code.slice(0, 32) : "",
    text,
    unmodifiedText: text,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
    modifiers: boundedInteger(message.modifiers, 0, 15),
    autoRepeat: message.autoRepeat === true,
    location: boundedInteger(message.location, 0, 3),
  }, sessionId).catch(() => {});
}

async function insertText(plane, message) {
  const sessionId = plane.attachedSession();
  if (typeof message.text !== "string" || !sessionId) return;
  await plane.send("Input.insertText", {
    text: message.text.slice(0, MAX_INSERT_TEXT_LENGTH),
  }, sessionId).catch(() => {});
}

async function respondToDialog(plane, message) {
  const sessionId = plane.attachedSession();
  if (!plane.pendingDialog || !sessionId) return;
  plane.pendingDialog = null;
  await plane.send("Page.handleJavaScriptDialog", {
    accept: message.accept === true,
    ...(typeof message.promptText === "string"
      ? { promptText: message.promptText.slice(0, MAX_INSERT_TEXT_LENGTH) }
      : {}),
  }, sessionId).catch(() => {});
}

async function chooseFiles(plane, message) {
  const sessionId = plane.attachedSession();
  if (!plane.resolveUploadPath || !sessionId) return;
  const chooser = plane.pendingFileChooser;
  plane.pendingFileChooser = null;
  if (!chooser) return;
  const names = Array.isArray(message.names) ? message.names.slice(0, 8) : [];
  const files = names
    .map((name) => (typeof name === "string" ? plane.resolveUploadPath(basename(name)) : null))
    .filter((path) => typeof path === "string" && path.length > 0);
  await plane.send("DOM.setFileInputFiles", {
    files,
    backendNodeId: chooser.backendNodeId,
  }, sessionId).catch(() => {});
}

/**
 * Back/forward walk the page's real navigation history over CDP; the viewer
 * never guesses an index, it only asks for the adjacent entry when one exists.
 */
async function navigateHistory(plane, delta) {
  const sessionId = plane.attachedSession();
  if (!sessionId) return;
  const history = await plane.send("Page.getNavigationHistory", {}, sessionId).catch(() => null);
  const entries = Array.isArray(history?.entries) ? history.entries : [];
  const index = typeof history?.currentIndex === "number" ? history.currentIndex : -1;
  const entry = index >= 0 ? entries[index + delta] : undefined;
  if (!entry) return;
  await plane.send("Page.navigateToHistoryEntry", { entryId: entry.id }, sessionId).catch(() => {});
}

async function sendPageCommand(plane, method) {
  const sessionId = plane.attachedSession();
  if (!sessionId) return;
  await plane.send(method, {}, sessionId).catch(() => {});
}

// Every action a viewer may take only while holding the controller seat.
const CONTROLLED_ACTIONS = new Map([
  ["input_mouse", dispatchMouse],
  ["input_keyboard", dispatchKey],
  ["input_insert_text", insertText],
  ["dialog_response", respondToDialog],
  ["file_chosen", chooseFiles],
  ["term_input", (plane, message) => plane.terminalLane.input(message)],
  ["tab_activate", async (plane, message) => {
    if (typeof message.tabId === "string") await plane.activateTab(message.tabId);
  }],
  ["nav_back", (plane) => navigateHistory(plane, -1)],
  ["nav_forward", (plane) => navigateHistory(plane, 1)],
  ["nav_reload", (plane) => sendPageCommand(plane, "Page.reload")],
  ["nav_stop", (plane) => sendPageCommand(plane, "Page.stopLoading")],
]);

function parseViewerMessage(raw) {
  if (typeof raw !== "string" && !(raw instanceof Buffer)) return null;
  const text = String(raw);
  if (text.length > MAX_INBOUND_BYTES) return null;
  try {
    const message = JSON.parse(text);
    return message !== null && typeof message === "object" ? message : null;
  } catch {
    return null;
  }
}

async function handleViewerMessage(plane, client, raw) {
  const message = parseViewerMessage(raw);
  if (!message) return;
  if (message.type === "control_acquire") {
    await acquireControl(plane, client, message);
    return;
  }
  if (message.type === "control_release") {
    if (client === plane.controllerClient) dropController(plane, "released");
    return;
  }
  const action = CONTROLLED_ACTIONS.get(message.type);
  if (action && await requireController(plane, client)) await action(plane, message);
}

/**
 * One control plane per sidecar. `send`/`sendTo`/`broadcast` and
 * `attachedSession` are the sidecar's own; the plane owns the controller
 * seat and the pending dialog/file-chooser state that seat may answer.
 */
export function createTakeoverControlPlane(config) {
  const plane = {
    ...config,
    controllerClient: null,
    pendingDialog: null,
    pendingFileChooser: null,
    fileChooserInterception: false,
  };
  return {
    handleViewerMessage: (client, raw) => handleViewerMessage(plane, client, raw),
    clientClosed(client) {
      if (client === plane.controllerClient) dropController(plane, "disconnected");
    },
    /** The read-only greeting every fresh connection receives. */
    readOnlyState: () => controlState(false),
    /** attachTo starts from stock page behavior; a controller re-arms it. */
    pageWillAttach() {
      plane.fileChooserInterception = false;
      plane.pendingDialog = null;
    },
    pageAttached: async () => {
      if (plane.controllerClient) await setFileChooserInterception(plane, true);
    },
    dialogOpening(params) {
      plane.pendingDialog = { kind: params.type ?? "alert" };
      plane.broadcast({
        type: "page_dialog",
        kind: params.type ?? "alert",
        message: String(params.message ?? "").slice(0, 2_000),
        defaultPrompt: String(params.defaultPrompt ?? "").slice(0, 500),
        timestamp: Date.now(),
      });
    },
    dialogClosed() {
      plane.pendingDialog = null;
      plane.broadcast({ type: "page_dialog_closed", timestamp: Date.now() });
    },
    fileChooserOpened(params) {
      plane.pendingFileChooser = { backendNodeId: params.backendNodeId };
      plane.broadcast({
        type: "file_chooser",
        mode: params.mode ?? "selectSingle",
        timestamp: Date.now(),
      });
    },
  };
}
