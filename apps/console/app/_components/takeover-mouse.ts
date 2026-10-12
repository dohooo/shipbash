import { remoteModifiers, type TakeoverSend } from "./takeover-protocol";

function mouseButtonName(button: number): string {
  return button === 0 ? "left" : button === 1 ? "middle" : button === 2 ? "right" : "none";
}

/**
 * A click on screen becomes a click in the page's own coordinate system.
 * Two conversions, both necessary: CSS layout size → canvas pixels (the
 * canvas is stretched to fit its box), then canvas pixels → page pixels
 * (frames arrive downscaled). Skipping the second put every click at
 * two thirds of the target on a 1920-wide page — the takeover that looked
 * completely dead.
 */
function pagePoint(canvas: HTMLCanvasElement, event: MouseEvent): { x: number; y: number } {
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return { x: 0, y: 0 };
  const pageWidth = Number(canvas.dataset.pageWidth) || canvas.width || 1;
  const pageHeight = Number(canvas.dataset.pageHeight) || canvas.height || 1;
  const toPageX = pageWidth / (canvas.width || 1);
  const toPageY = pageHeight / (canvas.height || 1);
  return {
    x: (event.clientX - bounds.left) * canvas.width / bounds.width * toPageX,
    y: (event.clientY - bounds.top) * canvas.height / bounds.height * toPageY,
  };
}

interface HeldPointer { button: string; count: number; x: number; y: number }

/**
 * The buttons currently held down, and the two ways they let go: one pointer
 * the host released or took the capture from, and every pointer at once when
 * the window loses focus. A release the remote never hears leaves the page
 * stuck mid-drag, so both paths always send.
 */
function createHeldPointers(send: TakeoverSend, point: (event: MouseEvent) => { x: number; y: number }) {
  const pressedPointers = new Map<number, HeldPointer>();
  const sendReleased = (pressed: HeldPointer, position: { x: number; y: number }, modifiers: number) => {
    send({
      type: "input_mouse",
      eventType: "mouseReleased",
      x: position.x,
      y: position.y,
      button: pressed.button,
      buttons: 0,
      clickCount: pressed.count,
      modifiers,
    });
  };
  const releasePointer = (event: PointerEvent) => {
    const pressed = pressedPointers.get(event.pointerId);
    if (!pressed) return;
    pressedPointers.delete(event.pointerId);
    const position = Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
      ? point(event)
      : { x: pressed.x, y: pressed.y };
    sendReleased(pressed, position, remoteModifiers(event));
  };
  const releaseAllPointers = () => {
    for (const [pointerId, pressed] of pressedPointers) {
      pressedPointers.delete(pointerId);
      sendReleased(pressed, pressed, 0);
    }
  };
  return { pressedPointers, releasePointer, releaseAllPointers };
}

interface TakeoverMouse {
  onPointerMove: (event: PointerEvent) => void;
  onPointerDown: (event: PointerEvent) => void;
  onPointerUp: (event: PointerEvent) => void;
  releasePointer: (event: PointerEvent) => void;
  releaseAllPointers: () => void;
  onWheel: (event: WheelEvent) => void;
  onContextMenu: (event: Event) => void;
}

/**
 * The pointer lane: presses, drags, wheel turns and the context menu, plus the
 * held-button bookkeeping that lets a drag survive a pointer the host takes
 * away and a blur end it cleanly.
 */
export function createTakeoverMouse(options: {
  canvas: HTMLCanvasElement;
  send: TakeoverSend;
  isActive: () => boolean;
  focusKeyboard: () => void;
}): TakeoverMouse {
  const { canvas, send, isActive, focusKeyboard } = options;
  let lastClick = { at: 0, x: 0, y: 0, button: -1, count: 0 };
  const point = (event: MouseEvent) => pagePoint(canvas, event);
  const { pressedPointers, releasePointer, releaseAllPointers } = createHeldPointers(send, point);

  const onPointerMove = (event: PointerEvent) => {
    if (!isActive()) return;
    const position = point(event);
    send({
      type: "input_mouse",
      eventType: "mouseMoved",
      x: position.x,
      y: position.y,
      button: event.buttons & 1 ? "left" : event.buttons & 4 ? "middle" : event.buttons & 2 ? "right" : "none",
      buttons: event.buttons,
      modifiers: remoteModifiers(event),
    });
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!isActive()) return;
    event.preventDefault();
    focusKeyboard();
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is a nicety; input still flows without it.
    }
    const position = point(event);
    const at = Number.isFinite(event.timeStamp) ? event.timeStamp : performance.now();
    const near = Math.abs(position.x - lastClick.x) <= 5 && Math.abs(position.y - lastClick.y) <= 5;
    const count = at - lastClick.at <= 500 && near && event.button === lastClick.button
      ? Math.min(lastClick.count + 1, 3)
      : 1;
    lastClick = { at, x: position.x, y: position.y, button: event.button, count };
    const button = mouseButtonName(event.button);
    pressedPointers.set(event.pointerId, { button, count, x: position.x, y: position.y });
    send({
      type: "input_mouse",
      eventType: "mousePressed",
      x: position.x,
      y: position.y,
      button,
      buttons: event.buttons,
      clickCount: count,
      modifiers: remoteModifiers(event),
    });
  };
  const onPointerUp = (event: PointerEvent) => {
    event.preventDefault();
    releasePointer(event);
  };
  const onWheel = (event: WheelEvent) => {
    if (!isActive()) return;
    event.preventDefault();
    const position = point(event);
    send({
      type: "input_mouse",
      eventType: "mouseWheel",
      x: position.x,
      y: position.y,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      modifiers: remoteModifiers(event),
    });
  };
  const onContextMenu = (event: Event) => {
    if (isActive()) event.preventDefault();
  };

  return {
    onPointerMove,
    onPointerDown,
    onPointerUp,
    releasePointer,
    releaseAllPointers,
    onWheel,
    onContextMenu,
  };
}
