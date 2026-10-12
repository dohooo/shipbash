import { ImageResponse } from "next/og";

import { staticEyePaths } from "../lib/wobbly-path";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
  const paths = staticEyePaths();
  return new ImageResponse(
    <div style={{ width: "64px", height: "64px", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "22.37%", background: "#000000" }}>
      <svg width="56" height="56" viewBox="0 0 400 400">
        <title>Shipbash</title>
        <path d={paths.outer} fill="none" stroke="#ffffff" strokeWidth="25" strokeLinejoin="round" />
        <path d={paths.inner} fill="none" stroke="#ffffff" strokeWidth="17" strokeLinejoin="round" />
        <path d={paths.ring} fill="none" stroke="#ffffff" strokeWidth="12" strokeLinejoin="round" />
        <path d={paths.dot} fill="#ffffff" />
      </svg>
    </div>,
    size,
  );
}
