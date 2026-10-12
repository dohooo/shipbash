// Layer one of the passkey story: the takeover browser is a headless Chromium
// with no authenticator behind it, real or virtual. When a site offers a
// passkey, Chromium opens a browser-level dialog — choose this device, a phone,
// a security key — that nobody in the sandbox can answer. That dialog is
// browser chrome, not page content, so the stream never shows it, and while it
// is up the page eats every click behind it: the person driving the takeover
// is stuck on a screen that looks alive and answers nothing (Google passkey
// challenge).
//
// So the takeover browser tells the truth before a site asks: it has no
// authenticator. A site that keys on `PublicKeyCredential` then offers a
// password or another way in, and a site that still asks for an assertion has
// its request rejected at once — the same NotAllowedError a person gets by
// cancelling — so the invisible dialog never opens and the page shows its own
// fallback ("Try another way").
//
// Scoped to the takeover lane (browser-idle). A normal agent run keeps the real
// API: nothing there completes a passkey either, but there is no reason to lie
// to a page the agent is only reading. Layer three (a harness-held virtual
// authenticator) would install a real credential on its own lane and must not
// carry this script.
export const WEBAUTHN_UNAVAILABLE_SCRIPT = `(() => {
  try {
    // Feature detection first: a site that checks for the API before offering a
    // passkey sees nothing and takes its password path.
    try {
      Object.defineProperty(window, "PublicKeyCredential", { value: undefined, configurable: true });
    } catch {
      try { window.PublicKeyCredential = undefined; } catch (_ignored) {}
    }
    const creds = navigator.credentials;
    if (creds) {
      const rejectAssertion = () => Promise.reject(new DOMException(
        "This browser has no authenticator available.", "NotAllowedError"));
      // A WebAuthn call passes \`publicKey\`; a password-credential call does
      // not, and is left to the real API. Our script runs before any page
      // script, so the page calls these overrides, never the native methods —
      // Chromium's own dialog is what we are keeping from ever opening.
      const nativeGet = typeof creds.get === "function" ? creds.get.bind(creds) : null;
      creds.get = (options) => (options && options.publicKey
        ? rejectAssertion()
        : (nativeGet ? nativeGet(options) : rejectAssertion()));
      const nativeCreate = typeof creds.create === "function" ? creds.create.bind(creds) : null;
      creds.create = (options) => (options && options.publicKey
        ? rejectAssertion()
        : (nativeCreate ? nativeCreate(options) : rejectAssertion()));
    }
  } catch (_error) {
    // A page that froze one of these already is a page we cannot help; better
    // to leave it than to throw out of an injected script.
  }
})();`;
