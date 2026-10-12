import styles from "./hero-demo.module.css";
import { SandboxBrowser } from "./walk-window";

/**
 * The walk's screen recording as Slack shows a shared video: file name and
 * size, then the poster, a frame of the recording where the agent's pointer
 * stopped on the session that should have been skipped.
 */
export function Recording() {
  return (
    <div className={styles.video} data-target="videoCard">
      <div className={styles.videoName}><b>turn-incognito-off-right-after-a-session-ends.mp4</b><span>13.0 MB</span></div>
      <div className={styles.poster}>
        <div className={styles.posterFrame}>
          <SandboxBrowser hit={false} />
          <svg className={styles.posterPointer} viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 2 L3 19 L8 14.5 L11.5 22 L14.6 20.6 L11.2 13.3 L18 13.3 Z" fill="#141414" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" />
          </svg>
        </div>
        <span className={styles.play}>▶</span>
        <span className={styles.duration}>1:12</span>
        <span className={styles.scrub} />
      </div>
    </div>
  );
}
