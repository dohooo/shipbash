import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ShipBash",
    short_name: "ShipBash",
    description: "Browser and terminal tests. Recorded proof. Confidence in every release.",
    start_url: "/",
    display: "standalone",
    background_color: "#f7f5f2",
    theme_color: "#f7f5f2",
    icons: [
      { src: "/shipbash-eye-192.png", sizes: "192x192", type: "image/png" },
      { src: "/shipbash-eye-512.png", sizes: "512x512", type: "image/png" },
      { src: "/shipbash-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/shipbash-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
