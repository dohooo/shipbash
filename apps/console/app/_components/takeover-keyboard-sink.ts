/**
 * The takeover's keyboard sink: an off-screen textarea that holds focus so
 * key, IME and clipboard events have somewhere to land. The canvas itself
 * cannot take text input, and a paste only carries clipboardData when the
 * browser delivers it to a focusable editing host.
 */
export function createKeyboardSink(canvas: HTMLCanvasElement): {
  keyboardSink: HTMLTextAreaElement;
  focusKeyboard: () => void;
} {
  const keyboardSink = document.createElement("textarea");
  keyboardSink.setAttribute("aria-label", "ShipBash takeover keyboard input");
  keyboardSink.setAttribute("autocomplete", "off");
  keyboardSink.setAttribute("autocapitalize", "off");
  keyboardSink.setAttribute("spellcheck", "false");
  keyboardSink.tabIndex = -1;
  keyboardSink.style.position = "absolute";
  keyboardSink.style.width = "1px";
  keyboardSink.style.height = "1px";
  keyboardSink.style.left = "0";
  keyboardSink.style.top = "0";
  keyboardSink.style.opacity = "0";
  keyboardSink.style.pointerEvents = "none";
  (canvas.parentElement ?? document.body).append(keyboardSink);

  const focusKeyboard = () => {
    // A sentinel space keeps Backspace observable as a keydown on every host.
    keyboardSink.value = " ";
    keyboardSink.focus({ preventScroll: true });
    keyboardSink.select();
  };
  return { keyboardSink, focusKeyboard };
}
