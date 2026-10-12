import UI from "./ui.js";
import {
  installShipBashClipboardBridge,
  installShipBashViewerBridge,
} from "./shipbash-clipboard-core.js";
import { installNoVncControlBridge, noVncBridgeConfig } from "./shipbash-control-core.js";

const config = noVncBridgeConfig(window.location.href);
const controlBridge = config ? installNoVncControlBridge({
  root: document,
  selfWindow: window,
  parentWindow: window.parent,
  ...config,
}) : null;

const reportInputIssue = (code) => {
  console.warn(`[ShipBash noVNC] ${code}`);
  controlBridge?.inputIssue(code);
};

const disposeClipboardBridge = installShipBashClipboardBridge({
  root: document,
  clipboard: navigator.clipboard,
  getRfb: () => UI.rfb,
  schedule: (callback, delay) => window.setTimeout(callback, delay),
  reportIssue: reportInputIssue,
});

const disposeViewerBridge = installShipBashViewerBridge({
  root: document,
  getRfb: () => UI.rfb,
  postState: (state) => controlBridge?.stateChanged(state),
  onRfbChanged: (rfb) => controlBridge?.observeRfb(rfb),
  canInput: () => controlBridge?.canInput() ?? false,
  repeat: (callback, delay) => window.setInterval(callback, delay),
  stopRepeating: (interval) => window.clearInterval(interval),
});

window.addEventListener("pagehide", () => {
  disposeClipboardBridge();
  disposeViewerBridge();
  controlBridge?.dispose();
  UI.rfb?.disconnect?.();
}, { once: true });
