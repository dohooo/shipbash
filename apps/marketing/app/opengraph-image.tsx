import { ImageResponse } from "next/og";

import { staticEyePaths } from "../lib/wobbly-path";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  const paths = staticEyePaths();
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: "54px", background: "#f7f5f2", color: "#141414" }}>
      <svg width="245" height="245" viewBox="0 0 400 400">
        <title>Shipbash logo</title>
        <path d={paths.outer} fill="none" stroke="#141414" strokeWidth="19" strokeLinejoin="round" />
        <path d={paths.inner} fill="none" stroke="#141414" strokeWidth="13" strokeLinejoin="round" />
        <path d={paths.ring} fill="none" stroke="#141414" strokeWidth="9" strokeLinejoin="round" />
        <path d={paths.dot} fill="#141414" />
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ fontSize: "68px", fontWeight: 800, letterSpacing: "-4px" }}>ShipBash</div>
        <div style={{ fontSize: "34px", color: "#55504a" }}>You ship it. We bash it.</div>
      </div>
    </div>,
    size,
  );
}
