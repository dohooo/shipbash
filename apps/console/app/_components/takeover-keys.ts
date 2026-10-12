import { remoteModifiers, type TakeoverSend } from "./takeover-protocol";

const SPECIAL_KEYS = new Set([
  "Backspace", "Delete", "End", "Enter", "Escape", "Home", "Insert",
  "PageDown", "PageUp", "Tab", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
]);
const MODIFIER_KEYS = new Set(["Alt", "AltGraph", "Control", "Meta", "Shift"]);

/** CDP only performs a key's default action (Enter submitting a form, most
 * visibly) when the keyDown carries its text, so Enter maps to "\r". */
function keyText(event: KeyboardEvent): string | null {
  if (event.ctrlKey || event.metaKey) return null;
  if (event.key === "Enter") return "\r";
  return Array.from(event.key).length === 1 ? event.key : null;
}

function keyPayload(event: KeyboardEvent, eventType: "keyDown" | "keyUp") {
  const text = eventType === "keyDown" ? keyText(event) : null;
  return {
    type: "input_keyboard",
    eventType,
    key: event.key === " " ? "Space" : event.key,
    code: event.code,
    ...(text !== null ? { text } : {}),
    windowsVirtualKeyCode: Number(event.keyCode || 0),
    modifiers: remoteModifiers(event),
  };
}

function forwardableKey(event: KeyboardEvent): boolean {
  if (MODIFIER_KEYS.has(event.key)) return false;
  return SPECIAL_KEYS.has(event.key)
    || event.ctrlKey || event.metaKey
    || Array.from(event.key).length === 1;
}

interface TakeoverKeys {
  onPaste: (event: ClipboardEvent) => void;
  onCompositionStart: () => void;
  onCompositionEnd: (event: CompositionEvent) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  onKeyUp: (event: KeyboardEvent) => void;
}

/**
 * The keyboard lane: typed keys, the clipboard, and the IME composition that
 * must swallow every key it is still assembling.
 */
export function createTakeoverKeys(options: {
  keyboardSink: HTMLTextAreaElement;
  send: TakeoverSend;
  active: () => boolean;
}): TakeoverKeys {
  const { keyboardSink, send, active } = options;
  let compositionActive = false;

  const insertText = (text: string) => {
    if (text) send({ type: "input_insert_text", text });
  };
  const onPaste = (event: ClipboardEvent) => {
    if (!active()) return;
    const text = event.clipboardData?.getData("text/plain") ?? "";
    event.preventDefault();
    event.stopPropagation();
    insertText(text);
  };
  const onCompositionStart = () => {
    compositionActive = true;
  };
  const onCompositionEnd = (event: CompositionEvent) => {
    compositionActive = false;
    keyboardSink.value = " ";
    keyboardSink.select();
    if (!active()) return;
    insertText(event.data);
  };

  const onKey = (eventType: "keyDown" | "keyUp") => (event: KeyboardEvent) => {
    if (!active()) return;
    const altGraph = typeof event.getModifierState === "function" && event.getModifierState("AltGraph");
    const command = (event.ctrlKey || event.metaKey) && !altGraph;
    // Cmd/Ctrl+V must reach the sink so the paste event carries clipboardData.
    if (command && String(event.key).toLowerCase() === "v") return;
    if (event.isComposing || compositionActive || event.key === "Process" || event.key === "Dead") return;
    event.preventDefault();
    event.stopPropagation();
    if (forwardableKey(event)) send(keyPayload(event, eventType));
  };
  const onKeyDown = onKey("keyDown");
  const onKeyUp = onKey("keyUp");

  return { onPaste, onCompositionStart, onCompositionEnd, onKeyDown, onKeyUp };
}
