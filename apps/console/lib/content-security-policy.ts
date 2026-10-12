function safeHttpOrigin(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || url.username
      || url.password
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function buildContentSecurityPolicy(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  // The web process only carries the public variable in dev; either names the
  // storage origin that artifact previews fetch from.
  const supabaseOrigin = safeHttpOrigin(environment.SUPABASE_URL)
    ?? safeHttpOrigin(environment.NEXT_PUBLIC_SUPABASE_URL);
  const productionAssetSource = supabaseOrigin ? ` ${supabaseOrigin}` : "";
  return [
    "default-src 'self'",
    `img-src 'self' data: http://127.0.0.1:* https://avatars.githubusercontent.com https://lh3.googleusercontent.com https://avatars.slack-edge.com${productionAssetSource}`,
    `media-src 'self' blob: http://127.0.0.1:*${productionAssetSource}`,
    "style-src 'self' 'unsafe-inline'",
    // The terminal's emulator (wterm) is WebAssembly: 'wasm-unsafe-eval' lets it
    // compile, and allows no JavaScript eval. React dev mode needs eval() to
    // rebuild server error stacks in the browser; production stays eval-free.
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${environment.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
    `connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:* wss://*.vercel.run${productionAssetSource}`,
    "frame-src http://127.0.0.1:* https://127.0.0.1:* https://*.vercel.run",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
}
