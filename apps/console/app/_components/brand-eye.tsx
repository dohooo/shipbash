import { staticEyePaths } from "../../../marketing/lib/wobbly-path";

/**
 * The brand eye at its deterministic resting frame (time = 2.4), the shape of
 * apps/marketing static-eye.tsx, with the same geometry.
 * It is static by design: the idle placeholder is not waiting on anything, so
 * nothing about the mark moves. Flat — no perspective tilt — and no animation,
 * so it needs no reduced-motion guard. `#141414` is the brand black on brand
 * paper, held fixed rather than themed because the placeholder's ground is too.
 */
export function BrandEye({ ink = "#141414" }: { ink?: string }) {
  const paths = staticEyePaths();
  return (
    <svg viewBox="0 0 400 400" aria-hidden="true">
      <path d={paths.outer} fill="none" stroke={ink} strokeWidth={19} strokeLinejoin="round" />
      <path d={paths.inner} fill="none" stroke={ink} strokeWidth={13} strokeLinejoin="round" />
      <path d={paths.ring} fill="none" stroke={ink} strokeWidth={9} strokeLinejoin="round" />
      <path d={paths.dot} fill={ink} />
    </svg>
  );
}
