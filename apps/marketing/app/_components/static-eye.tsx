import { staticEyePaths, wobblyPath } from "../../lib/wobbly-path";

interface StaticEyeProps {
  className?: string | undefined;
  ink?: string;
  compact?: boolean;
  label?: string;
}

export function StaticEye({ className, ink = "#141414", compact = false, label }: StaticEyeProps) {
  const paths = compact
    ? {
        outer: wobblyPath(146, 0.078, 5, 2.4, 0.7, 0, 100),
        inner: wobblyPath(84, 0.105, 5, 2.4 * 1.15, 3.9, 0, 100),
        dot: wobblyPath(17, 0.04, 3, 2.4 * 1.8, 11.5, 0, 100),
      }
    : staticEyePaths();

  return (
    <svg className={className} viewBox={compact ? "-20 -20 440 440" : "0 0 400 400"} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path d={paths.outer} fill="none" stroke={ink} strokeWidth={compact ? 26 : 19} strokeLinejoin="round" />
      <path d={paths.inner} fill="none" stroke={ink} strokeWidth={compact ? 18 : 13} strokeLinejoin="round" />
      {"ring" in paths ? <path d={paths.ring} fill="none" stroke={ink} strokeWidth={9} strokeLinejoin="round" /> : null}
      <path d={paths.dot} fill={ink} />
    </svg>
  );
}
