export function publicOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SHIPBASH_PUBLIC_URL must be a valid HTTPS origin.");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error("SHIPBASH_PUBLIC_URL must be a credential-free HTTPS origin.");
  }
  return url.origin;
}

export function browserStreamPath(token: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new Error("The Vercel Sandbox browser stream token is invalid.");
  }
  return `/stream/${token}`;
}

export function sandboxBrowserStreamUrl(value: string, path: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Vercel Sandbox returned an invalid browser stream domain.");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || !url.hostname.endsWith(".vercel.run")
  ) {
    throw new Error("Vercel Sandbox returned an untrusted browser stream domain.");
  }
  url.pathname = path;
  return url.href;
}
