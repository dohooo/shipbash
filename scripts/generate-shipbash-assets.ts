import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";

import { staticEyePaths } from "../apps/marketing/lib/wobbly-path.ts";

const PAPER = "#f7f5f2";
const INK = "#141414";
const BLACK = "#000000";
const WHITE = "#ffffff";
const PROJECT_ROOT = process.cwd();
const BRAND_ROOT = join(PROJECT_ROOT, "brand");
const SOURCE_DIRECTORY = join(BRAND_ROOT, "source");
const EXPORT_DIRECTORY = join(BRAND_ROOT, "exports");
const PUBLIC_DIRECTORIES = [
  join(PROJECT_ROOT, "apps", "console", "public"),
  join(PROJECT_ROOT, "apps", "marketing", "public"),
];
const PUBLIC_BRAND_DIRECTORIES = PUBLIC_DIRECTORIES.map((directory) => join(directory, "shipbash-brand"));
const sora = await readFile(join(PROJECT_ROOT, "node_modules", "@fontsource", "sora", "files", "sora-latin-700-normal.woff2"));
const soraDataUrl = `data:font/woff2;base64,${sora.toString("base64")}`;

interface EyeSvgOptions {
  background?: string;
  ink: string;
  maskable?: boolean;
  roundedBackground?: boolean;
}

function eyePaths(ink: string): string {
  const paths = staticEyePaths();
  return [
    `<path d="${paths.outer}" fill="none" stroke="${ink}" stroke-width="25" stroke-linejoin="round"/>`,
    `<path d="${paths.inner}" fill="none" stroke="${ink}" stroke-width="17" stroke-linejoin="round"/>`,
    `<path d="${paths.ring}" fill="none" stroke="${ink}" stroke-width="12" stroke-linejoin="round"/>`,
    `<path d="${paths.dot}" fill="${ink}"/>`,
  ].join("");
}

function eyeSvg({ ink, background, maskable = false, roundedBackground = false }: EyeSvgOptions): string {
  const viewBox = maskable ? "-100 -100 600 600" : "-20 -20 440 440";
  const backgroundRect = background
    ? roundedBackground
      ? `<rect x="-20" y="-20" width="440" height="440" rx="98.43" fill="${background}"/>`
      : `<rect x="-100" y="-100" width="600" height="600" fill="${background}"/>`
    : "";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">`,
    backgroundRect,
    eyePaths(ink),
    "</svg>",
  ].join("");
}

function lockupSvg(ink: string): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1120 320">',
    `<style>@font-face{font-family:Sora;src:url('${soraDataUrl}') format('woff2');font-weight:700}</style>`,
    `<g transform="translate(26 16) scale(.72)">${eyePaths(ink)}</g>`,
    `<text x="350" y="210" fill="${ink}" font-family="Sora, sans-serif" font-size="132" font-weight="700" letter-spacing="-5">ShipBash</text>`,
    "</svg>",
  ].join("");
}

function socialSvg(width: number, height: number, background: string, ink: string): string {
  const eyeSize = Math.round(height * 0.46);
  const eyeX = Math.round(width * 0.09);
  const eyeY = Math.round((height - eyeSize) / 2);
  const copyX = eyeX + eyeSize + Math.round(width * 0.065);
  const titleSize = Math.round(height * 0.14);
  const taglineSize = Math.round(height * 0.052);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<style>@font-face{font-family:Sora;src:url('${soraDataUrl}') format('woff2');font-weight:700}</style>`,
    `<rect width="${width}" height="${height}" fill="${background}"/>`,
    `<svg x="${eyeX}" y="${eyeY}" width="${eyeSize}" height="${eyeSize}" viewBox="-20 -20 440 440">${eyePaths(ink)}</svg>`,
    `<text x="${copyX}" y="${Math.round(height * 0.48)}" fill="${ink}" font-family="Sora, sans-serif" font-size="${titleSize}" font-weight="700" letter-spacing="-${Math.round(titleSize * 0.035)}">ShipBash</text>`,
    `<text x="${copyX}" y="${Math.round(height * 0.61)}" fill="${ink}" opacity=".7" font-family="Sora, sans-serif" font-size="${taglineSize}" font-weight="700">You ship it. We bash it.</text>`,
    "</svg>",
  ].join("");
}

function githubBadgePreviewSvg(): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">',
    '<circle cx="200" cy="200" r="198" fill="#000000"/>',
    `<g>${eyePaths(WHITE)}</g>`,
    "</svg>",
  ].join("");
}

async function png(svg: string, width: number, height = width): Promise<Buffer> {
  return sharp(Buffer.from(svg))
    .resize(width, height, { fit: "fill" })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function ico(images: Array<{ size: number; data: Buffer }>): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...images.map(({ data }) => data)]);
}

async function writeToDirectories(directories: string[], name: string, data: string | Buffer): Promise<void> {
  await Promise.all(directories.map(async (directory) => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, name), data);
  }));
}

async function writeBrandAsset(name: string, data: string | Buffer): Promise<void> {
  await writeToDirectories([EXPORT_DIRECTORY, ...PUBLIC_BRAND_DIRECTORIES], name, data);
}

const markBlackSvg = eyeSvg({ ink: BLACK });
const markWhiteSvg = eyeSvg({ ink: WHITE });
const faviconSvg = eyeSvg({ ink: WHITE, background: BLACK, roundedBackground: true });
const iconWhiteOnBlackSvg = eyeSvg({ ink: WHITE, background: BLACK });
const iconBlackOnWhiteSvg = eyeSvg({ ink: BLACK, background: WHITE });
const maskableSvg = eyeSvg({ ink: WHITE, background: BLACK, maskable: true });

await mkdir(SOURCE_DIRECTORY, { recursive: true });
await writeFile(join(SOURCE_DIRECTORY, "shipbash-eye.svg"), markBlackSvg, "utf8");

const [
  markBlackPng,
  markWhitePng,
  iconWhiteOnBlack1024,
  iconBlackOnWhite1024,
  iconWhiteOnBlack512,
  iconWhiteOnBlack192,
  appleTouchIcon,
  maskable512,
  maskable192,
  favicon16,
  favicon32,
  favicon48,
  githubBadgePreview,
  socialPreview,
  openGraph,
  launchCover,
] = await Promise.all([
  png(markBlackSvg, 1024),
  png(markWhiteSvg, 1024),
  png(iconWhiteOnBlackSvg, 1024),
  png(iconBlackOnWhiteSvg, 1024),
  png(iconWhiteOnBlackSvg, 512),
  png(iconWhiteOnBlackSvg, 192),
  png(iconWhiteOnBlackSvg, 180),
  png(maskableSvg, 512),
  png(maskableSvg, 192),
  png(faviconSvg, 16),
  png(faviconSvg, 32),
  png(faviconSvg, 48),
  png(githubBadgePreviewSvg(), 400),
  png(socialSvg(1280, 640, PAPER, INK), 1280, 640),
  png(socialSvg(1200, 630, PAPER, INK), 1200, 630),
  png(socialSvg(1600, 900, BLACK, WHITE), 1600, 900),
]);

const faviconIco = ico([
  { size: 16, data: favicon16 },
  { size: 32, data: favicon32 },
  { size: 48, data: favicon48 },
]);

await Promise.all([
  writeBrandAsset("shipbash-mark-black.svg", markBlackSvg),
  writeBrandAsset("shipbash-mark-white.svg", markWhiteSvg),
  writeBrandAsset("shipbash-mark-black-transparent-1024.png", markBlackPng),
  writeBrandAsset("shipbash-mark-white-transparent-1024.png", markWhitePng),
  writeBrandAsset("shipbash-icon-white-on-black-1024.png", iconWhiteOnBlack1024),
  writeBrandAsset("shipbash-icon-black-on-white-1024.png", iconBlackOnWhite1024),
  writeBrandAsset("shipbash-github-app-logo-white-1024.png", markWhitePng),
  writeBrandAsset("shipbash-github-app-logo-black-1024.png", markBlackPng),
  writeBrandAsset("shipbash-github-badge-preview-400.png", githubBadgePreview),
  writeBrandAsset("shipbash-lockup-horizontal-black.svg", lockupSvg(BLACK)),
  writeBrandAsset("shipbash-lockup-horizontal-white.svg", lockupSvg(WHITE)),
  writeBrandAsset("shipbash-social-preview-1280x640.png", socialPreview),
  writeBrandAsset("shipbash-open-graph-1200x630.png", openGraph),
  writeBrandAsset("shipbash-launch-cover-1600x900.png", launchCover),
  writeBrandAsset("shipbash-favicon.svg", faviconSvg),
  writeBrandAsset("favicon.ico", faviconIco),
  writeBrandAsset("favicon-16.png", favicon16),
  writeBrandAsset("favicon-32.png", favicon32),
  writeBrandAsset("favicon-48.png", favicon48),
  writeBrandAsset("apple-touch-icon-180.png", appleTouchIcon),
  writeBrandAsset("shipbash-maskable-192.png", maskable192),
  writeBrandAsset("shipbash-maskable-512.png", maskable512),
]);

await Promise.all(PUBLIC_DIRECTORIES.flatMap((directory) => [
  writeFile(join(directory, "shipbash-eye.svg"), eyeSvg({ ink: INK }), "utf8"),
  writeFile(join(directory, "shipbash-eye-white.svg"), eyeSvg({ ink: WHITE }), "utf8"),
  writeFile(join(directory, "shipbash-favicon.svg"), faviconSvg, "utf8"),
  writeFile(join(directory, "favicon.ico"), faviconIco),
  writeFile(join(directory, "favicon-16.png"), favicon16),
  writeFile(join(directory, "favicon-32.png"), favicon32),
  writeFile(join(directory, "favicon-48.png"), favicon48),
  writeFile(join(directory, "apple-touch-icon.png"), appleTouchIcon),
  writeFile(join(directory, "shipbash-eye-192.png"), iconWhiteOnBlack192),
  writeFile(join(directory, "shipbash-eye-512.png"), iconWhiteOnBlack512),
  writeFile(join(directory, "shipbash-eye-1024.png"), iconWhiteOnBlack1024),
  writeFile(join(directory, "shipbash-eye-transparent-1024.png"), markBlackPng),
  writeFile(join(directory, "shipbash-eye-white-transparent-1024.png"), markWhitePng),
  writeFile(join(directory, "shipbash-maskable-192.png"), maskable192),
  writeFile(join(directory, "shipbash-maskable-512.png"), maskable512),
]));
