import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: "https://shipbash.dev", lastModified: new Date(), changeFrequency: "weekly", priority: 1 },
    { url: "https://shipbash.dev/privacy", changeFrequency: "yearly", priority: 0.3 },
  ];
}
