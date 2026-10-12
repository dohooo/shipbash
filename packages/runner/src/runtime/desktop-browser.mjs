/** One desktop environment for discovery, verification, and saved sign-in checks. */
export const DESKTOP_WIDTH = 1920;
export const DESKTOP_HEIGHT = 1080;
export const DESKTOP_DISPLAY = ":99";
export const DESKTOP_XDG_PATH = "/tmp/shipbash-desktop-xdg";
/**
 * The desktop browser's own flags (harness-browser.mjs launches it): software
 * GL for GPU-less containers, and kiosk. Kiosk fills the display with the page
 * and nothing of the browser's own around it, so the page's viewport is the
 * display's 1920×1080 in every window, tab and connection. A window size
 * would not: the tab strip and address bar take their share of it
 * (1911×932 measured for --window-size=1920,1080), and a viewport override
 * holds only for the CDP session that set it. The console draws its own
 * browser frame around the stream (activity-browser-stream.tsx).
 */
export const DESKTOP_BROWSER_ARGS = Object.freeze(["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--kiosk"]);
/** The display the desktop browser draws on. */
export const DESKTOP_BROWSER_ENV = Object.freeze({
  DISPLAY: DESKTOP_DISPLAY,
  XDG_RUNTIME_DIR: DESKTOP_XDG_PATH,
});
export const DESKTOP_XVFB_ARGS = Object.freeze([
  DESKTOP_DISPLAY, "-screen", "0", `${DESKTOP_WIDTH}x${DESKTOP_HEIGHT}x24`, "-nolisten", "tcp", "-noreset",
]);

const desktopProbe = `JSON.stringify({hover:matchMedia('(hover: hover)').matches,finePointer:matchMedia('(pointer: fine)').matches,width:innerWidth,height:innerHeight,touch:navigator.maxTouchPoints})`;
/** Checks the page reads as a mouse-driven 1920×1080 desktop before the product is tested on it. */
export async function prepareDesktopBrowser(agentBrowser, env, options) {
  const response = await agentBrowser(["eval", desktopProbe], env, options);
  const raw = (response?.json ?? response)?.data?.result;
  const state = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!state?.hover || !state.finePointer || state.touch !== 0 || state.width !== DESKTOP_WIDTH || state.height !== DESKTOP_HEIGHT) {
    throw new Error("Desktop browser environment is unavailable: expected a 1920×1080 viewport with mouse hover and a fine pointer.");
  }
}
