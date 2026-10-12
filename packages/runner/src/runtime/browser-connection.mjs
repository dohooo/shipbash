/** Only the host-resolved loopback endpoint may connect this project's sign-in agent. */
export function validateBrowserConnection(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || !url.pathname.startsWith("/devtools/browser/")) {
    throw new Error("The project browser connection is invalid.");
  }
  return endpoint;
}
