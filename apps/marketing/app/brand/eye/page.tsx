import type { Metadata } from "next";

import { WobblyEye } from "../../_components/wobbly-eye";
import styles from "../brand.module.css";

export const metadata: Metadata = {
  title: "Wobbly Logo Eye · ShipBash",
  robots: { index: false, follow: false },
};

export default function WobblyLogoEyePage() {
  return (
    <main className={styles.eyeOnly}>
      <WobblyEye label="ShipBash Wobbly Logo Eye" />
    </main>
  );
}
