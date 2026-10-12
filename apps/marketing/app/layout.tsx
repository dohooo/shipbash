import type { Metadata } from "next";
import type { ReactNode } from "react";

import "@fontsource/sora/600.css";
import "@fontsource/sora/700.css";
import "@fontsource/sora/800.css";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://shipbash.dev"),
  title: "ShipBash — You ship it. We bash it.",
  description: "Your agent says it's done. ShipBash shows you it works. It tests your web app and your CLI like a real user, on production, with a recording of every verdict.",
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
  openGraph: {
    title: "ShipBash — You ship it. We bash it.",
    description: "Browser and terminal tests. Recorded proof. Confidence in every release.",
    type: "website",
    url: "https://shipbash.dev",
    images: [{ url: "/shipbash-brand/shipbash-open-graph-1200x630.png", width: 1200, height: 630, alt: "ShipBash — You ship it. We bash it." }],
  },
  twitter: {
    card: "summary_large_image",
    title: "ShipBash — You ship it. We bash it.",
    description: "Browser and terminal tests. Recorded proof. Confidence in every release.",
    images: ["/shipbash-brand/shipbash-open-graph-1200x630.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
