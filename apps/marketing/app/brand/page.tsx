import type { Metadata } from "next";

import { StaticEye } from "../_components/static-eye";
import { WobblyEye } from "../_components/wobbly-eye";
import styles from "./brand.module.css";

export const metadata: Metadata = {
  title: "ShipBash Brand Kit",
  description: "Private reference and export library for the ShipBash identity system.",
  robots: { index: false, follow: false },
};

interface Asset {
  description: string;
  file: string;
  name: string;
  tone?: "dark" | "light";
}

interface AssetGroup {
  assets: Asset[];
  description: string;
  eyebrow: string;
  title: string;
}

const assetGroups: AssetGroup[] = [
  {
    eyebrow: "01 · Marks",
    title: "Core identity",
    description: "Transparent marks and horizontal lockups for interfaces, documents, and editorial use.",
    assets: [
      { name: "Black mark", description: "SVG · transparent", file: "shipbash-mark-black.svg" },
      { name: "White mark", description: "SVG · transparent", file: "shipbash-mark-white.svg", tone: "dark" },
      { name: "Black lockup", description: "SVG · transparent", file: "shipbash-lockup-horizontal-black.svg" },
      { name: "White lockup", description: "SVG · transparent", file: "shipbash-lockup-horizontal-white.svg", tone: "dark" },
    ],
  },
  {
    eyebrow: "02 · Product",
    title: "Application icons",
    description: "High-contrast square icons plus the small-size and maskable exports used by browsers and installed apps.",
    assets: [
      { name: "Primary app icon", description: "PNG · 1024 × 1024", file: "shipbash-icon-white-on-black-1024.png", tone: "dark" },
      { name: "Inverse app icon", description: "PNG · 1024 × 1024", file: "shipbash-icon-black-on-white-1024.png" },
      { name: "Favicon", description: "ICO · 16 / 32 / 48", file: "favicon.ico", tone: "dark" },
      { name: "Apple touch icon", description: "PNG · 180 × 180", file: "apple-touch-icon-180.png", tone: "dark" },
      { name: "Maskable icon", description: "PNG · 512 × 512", file: "shipbash-maskable-512.png", tone: "dark" },
    ],
  },
  {
    eyebrow: "03 · Platforms",
    title: "Launch surfaces",
    description: "Ready-to-use files for GitHub, link previews, launch directories, and external profiles.",
    assets: [
      { name: "GitHub upload mark", description: "PNG · white · transparent · 1024", file: "shipbash-github-app-logo-white-1024.png", tone: "dark" },
      { name: "GitHub inverse mark", description: "PNG · black · transparent · 1024", file: "shipbash-github-app-logo-black-1024.png" },
      { name: "GitHub badge preview", description: "PNG · 400 × 400", file: "shipbash-github-badge-preview-400.png", tone: "dark" },
      { name: "Repository social preview", description: "PNG · 1280 × 640", file: "shipbash-social-preview-1280x640.png" },
      { name: "Open Graph image", description: "PNG · 1200 × 630", file: "shipbash-open-graph-1200x630.png" },
      { name: "Launch cover", description: "PNG · 1600 × 900", file: "shipbash-launch-cover-1600x900.png", tone: "dark" },
    ],
  },
];

function AssetRow({ asset }: { asset: Asset }) {
  const href = `/shipbash-brand/${asset.file}`;
  return (
    <article className={styles.assetRow}>
      <div className={`${styles.assetThumb} ${asset.tone === "dark" ? styles.assetThumbDark : ""}`}>
        {/* biome-ignore lint/performance/noImgElement: an internal brand page shows the original file: the Download link beside
            it serves this very asset, so a recompressed preview would misrepresent it. */}
        <img src={href} alt="" />
      </div>
      <div className={styles.assetDetails}>
        <strong>{asset.name}</strong>
        <span>{asset.description}</span>
        <code>{asset.file}</code>
      </div>
      <a className={styles.download} href={href} download aria-label={`Download ${asset.name}`}>
        <span>Download</span>
        <span aria-hidden="true">↓</span>
      </a>
    </article>
  );
}

function BrandRail({ assetCount }: { assetCount: number }) {
  return (
    <aside className={styles.rail} aria-label="Brand kit sections">
      <a className={styles.railBrand} href="#top">
        <StaticEye label="ShipBash" />
        <span>Brand kit</span>
      </a>
      <nav>
        <a href="#identity">Identity</a>
        <a href="#assets">Assets</a>
        <a href="#applications">Applications</a>
        <a href="#guidance">Guidance</a>
      </nav>
      <div className={styles.railMeta}>
        <span>{assetCount} exports</span>
        <span>Private reference</span>
      </div>
    </aside>
  );
}

function IdentitySection() {
  return (
    <section className={styles.section} id="identity">
      <div className={styles.sectionHeading}>
        <div>
          <span className={styles.eyebrow}>Identity</span>
          <h2>Alive in product. Exact in print.</h2>
        </div>
        <p>The product mark follows the pointer. Every exported asset uses the same deterministic resting frame.</p>
      </div>

      <div className={styles.signatureGrid}>
        <div className={styles.motionTile}>
          <WobblyEye className={styles.animatedEye} label="Animated ShipBash Wobbly Eye" />
          <span>Interactive mark · move your pointer</span>
        </div>
        <div className={styles.inverseTile}>
          <StaticEye className={styles.staticEye} ink="#ffffff" label="White ShipBash mark" />
          <span>Primary application icon</span>
        </div>
      </div>

      <dl className={styles.specs}>
        <div><dt>Ink</dt><dd>#141414</dd></div>
        <div><dt>Paper</dt><dd>#F7F5F2</dd></div>
        <div><dt>Platform black</dt><dd>#000000</dd></div>
        <div><dt>Platform white</dt><dd>#FFFFFF</dd></div>
        <div><dt>Wordmark</dt><dd>Sora 700</dd></div>
        <div><dt>Motion</dt><dd>Pointer + breath</dd></div>
      </dl>
    </section>
  );
}

function AssetLibrarySection() {
  return (
    <section className={styles.section} id="assets">
      <div className={styles.sectionHeading}>
        <div>
          <span className={styles.eyebrow}>Asset library</span>
          <h2>Everything ready to export.</h2>
        </div>
        <p>Use the named platform asset directly. Do not recolor, crop, or rebuild the eye by hand.</p>
      </div>

      <div className={styles.assetCatalog}>
        {assetGroups.map((group) => (
          <section className={styles.assetGroup} key={group.title}>
            <header>
              <span>{group.eyebrow}</span>
              <h3>{group.title}</h3>
              <p>{group.description}</p>
            </header>
            <div className={styles.assetList}>
              {group.assets.map((asset) => <AssetRow asset={asset} key={asset.file} />)}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function ApplicationsSection() {
  return (
    <section className={styles.section} id="applications">
      <div className={styles.sectionHeading}>
        <div>
          <span className={styles.eyebrow}>Applications</span>
          <h2>See it where people meet it.</h2>
        </div>
        <p>These previews expose small-size, crop, contrast, and platform-background problems before anything is uploaded.</p>
      </div>

      <div className={styles.applicationGrid}>
        <article className={styles.browserPreview}>
          <div className={styles.browserBar}>
            <i /><i /><i />
            <div className={styles.browserTab}>
              {/* biome-ignore lint/performance/noImgElement: an internal brand page shows the original favicon as shipped; the
                  preview exists to prove how the real file reads at 32px. */}
              <img src="/shipbash-brand/favicon-32.png" alt="" />
              <span>ShipBash</span>
              <b aria-hidden="true">×</b>
            </div>
          </div>
          <div className={styles.browserAddress}>shipbash.dev</div>
          <footer>Browser tab · 32 px favicon</footer>
        </article>

        <article className={styles.githubPreview}>
          <div className={styles.githubBadge}>
            {/* biome-ignore lint/performance/noImgElement: an internal brand page shows the original badge PNG, since this preview
                exists to expose crop and contrast problems in the real file. */}
            <img src="/shipbash-brand/shipbash-github-badge-preview-400.png" alt="ShipBash GitHub badge preview" />
          </div>
          <div>
            <span>GitHub OAuth / App</span>
            <strong>ShipBash</strong>
            <p>Upload the transparent white mark and set the badge background to #000000.</p>
          </div>
        </article>

        <article className={styles.themePreview}>
          <div className={styles.readmeLight}>
            {/* biome-ignore lint/performance/noImgElement: an internal brand page shows the original lockup; next/image does not
                optimize SVG in any case. */}
            <img src="/shipbash-brand/shipbash-lockup-horizontal-black.svg" alt="ShipBash black lockup" />
          </div>
          <div className={styles.readmeDark}>
            {/* biome-ignore lint/performance/noImgElement: an internal brand page shows the original lockup; next/image does not
                optimize SVG in any case. */}
            <img src="/shipbash-brand/shipbash-lockup-horizontal-white.svg" alt="ShipBash white lockup" />
          </div>
          <footer>README · automatic light and dark variants</footer>
        </article>

        <article className={styles.socialPreview}>
          {/* biome-ignore lint/performance/noImgElement: an internal brand page shows the original social preview, and
              `.socialPreview > img` targets the image as a direct child — next/image's wrapper
              element would break that selector. */}
          <img src="/shipbash-brand/shipbash-social-preview-1280x640.png" alt="ShipBash repository social preview" />
          <footer>Repository social preview · 1280 × 640</footer>
        </article>
      </div>
    </section>
  );
}

function GuidanceSection() {
  return (
    <section className={styles.section} id="guidance">
      <div className={styles.sectionHeading}>
        <div>
          <span className={styles.eyebrow}>Guidance</span>
          <h2>Few rules. No ambiguity.</h2>
        </div>
      </div>
      <div className={styles.rules}>
        <article><span>01</span><h3>Choose by surface</h3><p>Use Ink and Paper inside ShipBash. Use pure black and white for browser and third-party platform icons.</p></article>
        <article><span>02</span><h3>Keep it breathing</h3><p>Leave clear space equal to the pupil diameter on every side. Never crop the outer contour.</p></article>
        <article><span>03</span><h3>Use the resting frame</h3><p>Motion belongs in the product. Screenshots, documents, and platform uploads use the generated static frame.</p></article>
        <article><span>04</span><h3>Do not improvise</h3><p>Never stretch, rotate, add effects, change stroke weights, or place the transparent mark on low-contrast imagery.</p></article>
      </div>
    </section>
  );
}

export default function BrandReferencePage() {
  const assetCount = assetGroups.reduce((total, group) => total + group.assets.length, 0);
  return (
    <main className={styles.page}>
      <BrandRail assetCount={assetCount} />

      <div className={styles.content}>
        <header className={styles.hero} id="top">
          <div>
            <span className={styles.eyebrow}>ShipBash identity system</span>
            <h1>One eye.<br />Every surface.</h1>
          </div>
          <p>
            A working reference for the Wobbly Eye, product icons, platform exports,
            and the rules that keep ShipBash recognizable at every size.
          </p>
        </header>

        <IdentitySection />

        <AssetLibrarySection />

        <ApplicationsSection />

        <GuidanceSection />

        <footer className={styles.footer}>
          <span>ShipBash brand kit</span>
          <span>Generated from one deterministic source</span>
        </footer>
      </div>
    </main>
  );
}
