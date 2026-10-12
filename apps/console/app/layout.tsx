import type { Metadata } from "next";
import type { ReactNode } from "react";

import "@fontsource/sora/600.css";
import "@fontsource/sora/700.css";
import "@fontsource/sora/800.css";
import "streamdown/styles.css";
import "@shipbash/contracts/runtime/terminal-theme/terminal-theme.css";
import "./theme.css";
import "./globals.css";
import "./mobile.css";
import { configuration } from "../lib/server-contracts";
import { Providers } from "./providers";

/**
 * The origin absolute metadata URLs name — an unfurl's og:image above all —
 * so every deployment's pages point at their own images. Read per render and
 * never thrown on: a configuration the reader refuses is the proxy's to
 * report (`/login?error=configuration`), and leaves no base here, as does a
 * build, which has no deployment.
 */
function metadataBase(): URL | null {
  try {
    return new URL(configuration().publicUrl);
  } catch {
    return null;
  }
}

export function generateMetadata(): Metadata {
  return { ...siteMetadata, metadataBase: metadataBase() };
}

const siteMetadata: Metadata = {
  title: { default: "ShipBash", template: "%s · ShipBash" },
  description: "Browser and terminal tests. Recorded proof. Confidence in every release.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/shipbash-favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-48.png", sizes: "48x48", type: "image/png" },
    ],
    shortcut: [{ url: "/favicon.ico" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
