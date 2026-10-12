import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

import { staticEyePaths } from "../../../marketing/lib/wobbly-path";
import type { ShareCard } from "../_lib/share-card";

export const SHARE_CARD_SIZE = { width: 1200, height: 630 };

// Avenir Next and SF Mono are Apple system faces: absent from the Linux runtime
// and not ours to bundle. Sora is the product's own shipped face, and the only
// one in the tree Satori can parse — @fontsource's woff2 copies it cannot.
const [soraRegular, soraBold] = await Promise.all([
  readFile(join(process.cwd(), "assets/sora-500.woff")),
  readFile(join(process.cwd(), "assets/sora-700.woff")),
]);

const INK = "#171717";
const MUTED = "#686866";
const DENOMINATOR = "#7e7e79";
const TONE = { failed: "#c62828", passed: "#16a34a" };

/**
 * The mark as a watermark: 840px against a 630px card at 7%, its top-right
 * quadrant running off both edges. Drawn first, because Satori paints in
 * document order and everything else belongs on top of it.
 */
function Watermark() {
  const paths = staticEyePaths();
  return (
    <div style={{ position: "absolute", right: "-282px", top: "-272px", width: "840px", height: "840px", display: "flex", opacity: 0.07 }}>
      <svg width="840" height="840" viewBox="-20 -20 440 440">
        <title>ShipBash</title>
        <path d={paths.outer} fill="none" stroke="#141414" strokeWidth="25" strokeLinejoin="round" />
        <path d={paths.inner} fill="none" stroke="#141414" strokeWidth="17" strokeLinejoin="round" />
        <path d={paths.ring} fill="none" stroke="#141414" strokeWidth="12" strokeLinejoin="round" />
        <path d={paths.dot} fill="#141414" />
      </svg>
    </div>
  );
}

function Card({ card }: { card: ShareCard }) {
  const figure = card.figureSize;
  return (
    <div style={{ position: "relative", width: "1200px", height: "630px", display: "flex", background: "#fff", fontFamily: "Sora" }}>
      <Watermark />
      <div style={{ position: "absolute", left: "56px", top: "158px", width: "1088px", display: "flex", flexDirection: "column" }}>
        {/* Both parts track at -.05em of their own size. The design declares
            -.05em once, which CSS resolves against the figure and inherits as
            that absolute length — but SF Mono's wide digits absorb it where
            Sora's do not, so reusing the figure's length here collides the
            denominator's glyphs. Same ratio, applied per size, reads as the
            design does. */}
        <div style={{ display: "flex", alignItems: "baseline" }}>
          <span style={{ fontSize: `${String(figure)}px`, fontWeight: 700, lineHeight: 1, letterSpacing: `${String(figure * -0.05)}px`, color: TONE[card.tone] }}>{card.figure}</span>
          <span style={{ fontSize: `${String(figure / 2)}px`, fontWeight: 700, lineHeight: 1, letterSpacing: `${String(figure * -0.025)}px`, color: DENOMINATOR }}>/{card.denominator}</span>
        </div>
        <div style={{ marginTop: "12px", fontSize: "40px", fontWeight: 700, lineHeight: 1.15, letterSpacing: "-1.2px", color: INK }}>{card.headline}</div>
        <div style={{ marginTop: "16px", fontSize: "24px", fontWeight: 500, lineHeight: 1.45, color: MUTED }}>{card.subline}</div>
      </div>
      {/* Who was tested on the left, who tested it on the right. One row, so a
          long name is ellipsized by the space actually left rather than by a
          width guessed here, and can never reach the wordmark. Satori's flex
          comes from Yoga, whose `flex-shrink` defaults to 0 where CSS defaults
          to 1, so every step that has to give way says so explicitly. */}
      <div style={{ position: "absolute", left: "56px", bottom: "46px", width: "1088px", height: "36px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", minWidth: 0, flexShrink: 1, overflow: "hidden", fontSize: "29px", fontWeight: 500, lineHeight: 1, color: MUTED }}>
          {/* The site under test has no icon we hold, and the ShipBash mark
              here would read as though we were the site under test. A neutral
              tile is the honest stand-in. */}
          <div style={{ width: "36px", height: "36px", flexShrink: 0, marginRight: "14px", borderRadius: "9px", background: "#e8e8e4" }} />
          {/* Only the names give way. The stamp is pinned, because a long
              project name is no reason to publish a verdict about no
              particular day. */}
          <span style={{ minWidth: 0, flexShrink: 1, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{card.footerName}</span>
          <span style={{ flexShrink: 0, whiteSpace: "nowrap" }}>{` · ${card.footerStamp}`}</span>
        </div>
        <div style={{ marginLeft: "24px", flexShrink: 0, fontSize: "29px", fontWeight: 700, lineHeight: 1, letterSpacing: "-0.725px", color: MUTED }}>ShipBash</div>
      </div>
    </div>
  );
}

export function shareCardImage(card: ShareCard): ImageResponse {
  return new ImageResponse(<Card card={card} />, {
    ...SHARE_CARD_SIZE,
    fonts: [
      { name: "Sora", data: soraRegular, style: "normal", weight: 500 },
      { name: "Sora", data: soraBold, style: "normal", weight: 700 },
    ],
    // ImageResponse otherwise sends `public, max-age=0, must-revalidate`,
    // which lets a shared cache keep a card for a link its owner has since
    // revoked. The run data this is drawn from answers `private, no-store`;
    // a picture of that data has no claim to be more cacheable than it.
    headers: { "cache-control": "private, no-store" },
  });
}
