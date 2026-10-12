import type { CSSProperties, ReactNode } from "react";

import {
  type BandRun,
  type BarRect,
  type CaptionLayout,
  type OverlayRecording,
  RECORDING_OVERLAY,
  SHADE_LAYOUT,
  bandLayout,
  barLayout,
  captionLayout,
  overlayFrame,
  pictureLayout,
} from "@shipbash/contracts/runtime/recording-overlay.mjs";
import { OVERLAY_STYLE, overlayColour, shadeGradient } from "./recording-overlay-style";

interface RecordingOverlayProps {
  recording: OverlayRecording;
  /** Where the playhead is, in milliseconds of the recording. */
  timeMs: number;
  /** How wide the frame is drawn on the page; the frame itself stays at video size. */
  displayWidth: number;
  /** The picture: a frame of the recording, at the frame's size, laid out in the frame under the overlay. */
  children: ReactNode;
}

/** One run of text, at the x and on the middle line the shared layout gave it. */
function Run({ run, className, centerY }: { run: BandRun | null; className: string; centerY: number }) {
  if (!run) return null;
  return <span className={`rov-run ${className}`} style={{ left: run.x, top: centerY }}>{run.text}</span>;
}

/** The subtitle: the shared layout's rounded box, and each of its lines in the caption's or the card's style. */
function Subtitle({ caption }: { caption: CaptionLayout }) {
  const { box } = caption;
  return (
    <>
      <span
        className="rov-box"
        style={{ left: box.x, top: box.y, width: box.width, height: box.height, borderRadius: box.radius, background: overlayColour(box.color, box.alpha) }}
      />
      {caption.lines.map((line, index) => (
        <Run key={`line-${String(index)}`} run={line} className={`rov-${caption.style}`} centerY={line.centerY} />
      ))}
    </>
  );
}

/** The bar, as the shared layout's rectangles in their drawing order, each in its final colour. */
function OverlayBar({ rects }: { rects: BarRect[] }) {
  return (
    <>
      {rects.map((rect, index) => (
        <span
          className="rov-rect"
          data-kind={rect.kind}
          key={`${rect.kind}-${String(rect.x)}-${String(index)}`}
          style={{
            left: rect.x,
            top: rect.y,
            width: rect.width,
            height: rect.height,
            background: overlayColour(rect.color, rect.alpha),
          }}
        />
      ))}
    </>
  );
}

/**
 * One frame of a recording with the overlay drawn over it, at the video's own
 * pixel size and scaled down to `displayWidth` for the page. What shows and
 * where comes from the shared module; this only draws it.
 */
export function RecordingOverlay({ recording, timeMs, displayWidth, children }: RecordingOverlayProps) {
  const frame = overlayFrame(recording, timeMs);
  const band = bandLayout(frame);
  const caption = captionLayout(frame);
  const { width, height } = RECORDING_OVERLAY.frame;
  const scale = displayWidth / width;
  const frameStyle: CSSProperties = { width, height, transform: `scale(${String(scale)})` };
  // Where the exporter puts the recording: the shared layout's rectangle in the frame.
  const picture = pictureLayout({ width, height });
  const pictureStyle: CSSProperties = { left: picture.x, top: picture.y, width: picture.width, height: picture.height };
  const recordedStyle: CSSProperties = { width, height, transform: `scale(${String(picture.width / width)}, ${String(picture.height / height)})` };
  const shadeStyle: CSSProperties = { left: SHADE_LAYOUT.x, top: SHADE_LAYOUT.y, width: SHADE_LAYOUT.width, height: SHADE_LAYOUT.height, background: shadeGradient() };
  return (
    <div className="rov-fit" style={{ width: displayWidth, height: height * scale }}>
      <style>{OVERLAY_STYLE}</style>
      <div className="rov-frame" data-testid="recording-overlay" style={frameStyle}>
        <div className="rov-picture" style={pictureStyle}>
          <div className="rov-recorded" style={recordedStyle}>{children}</div>
        </div>
        <span className="rov-shade" style={shadeStyle} />
        {caption ? <Subtitle caption={caption} /> : null}
        <Run run={band.counter} className="rov-counter" centerY={band.centerY} />
        <Run run={band.title} className="rov-title" centerY={band.centerY} />
        <Run run={band.time} className="rov-time" centerY={band.centerY} />
        <OverlayBar rects={barLayout(frame)} />
      </div>
    </div>
  );
}
