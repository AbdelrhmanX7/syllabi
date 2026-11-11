import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { JSDOM } from 'jsdom';
import React from 'react';

import type { Canvas as FabricCanvas } from 'fabric';

import type { TabletInputSettings } from '@repo/whiteboard-core';
import type { UseWhiteboardCanvasProps } from './useWhiteboardCanvas';

// The state this file pins lives in refs inside the hook; `window.__wbInputDebug` is the hook's OWN
// shipped diagnostic (see publishInputDebug — it feeds the gated on-device input overlay) and is
// published from the TOP of every pointer handler. So a snapshot read after dispatching event N
// describes the state event N-1 left behind, which is exactly what a state-machine regression needs.
interface InputDebugSnapshot {
  touchOverride: string | null;
  touchPanMode: 'single' | 'multi' | null;
  activePtrs: number;
  isDrawingMode: boolean;
  /** A pan fling (inertia) is in flight. */
  fling: boolean;
}

// jsdom global setup mirrors useSnapshotSyncer.test.tsx / WhiteboardErrorBoundary.test.tsx. Extras this
// hook needs on top of those: a visual jsdom (requestAnimationFrame for the pan preview), a
// ResizeObserver, and a 2D context — node-canvas is present but unbuilt in this workspace, so Fabric
// gets a no-op context stub. Nothing here touches the touch state machine under test; it only lets the
// real hook mount so the REAL handlers can be driven.
before(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const domGlobals = globalThis as unknown as Record<string, unknown>;

  domGlobals.window = dom.window;
  domGlobals.document = dom.window.document;
  domGlobals.IS_REACT_ACT_ENVIRONMENT = true;
  domGlobals.HTMLCanvasElement = dom.window.HTMLCanvasElement;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  });

  class StubResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  (dom.window as unknown as Record<string, unknown>).ResizeObserver = StubResizeObserver;
  domGlobals.ResizeObserver = StubResizeObserver;

  // See stubRect: jsdom has no layout, so this is the only way to give the pointer funnel a rect that
  // can MOVE. The hook installs its cache as an OWN property on Fabric's upper canvas, which shadows
  // this prototype method — so the cache is what a test observes, and this is what it caches FROM.
  dom.window.Element.prototype.getBoundingClientRect = function stubbedRect() {
    const { left, top, width, height } = stubRect;

    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  };

  const makeContext = () => {
    const extra: Record<string, unknown> = {};
    const target: Record<string, unknown> = {
      canvas: null,
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      lineWidth: 1,
      strokeStyle: '#000000',
      fillStyle: '#000000',
      font: '10px sans-serif',
      measureText: () => ({ width: 0, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 0 }),
      getImageData: (_x: number, _y: number, width: number, height: number) => ({
        data: new Uint8ClampedArray(Math.max(1, width) * Math.max(1, height) * 4),
        width,
        height,
      }),
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(Math.max(1, width) * Math.max(1, height) * 4),
        width,
        height,
      }),
      putImageData: () => {},
      getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
      createPattern: () => null,
      setLineDash: () => {},
      getLineDash: () => [],
      isPointInPath: () => false,
      isPointInStroke: () => false,
    };

    return new Proxy(target, {
      get(base, prop) {
        if (prop in base) return base[prop as string];
        if (prop in extra) return extra[prop as string];

        return () => undefined;
      },
      set(base, prop, value) {
        if (prop in base) base[prop as string] = value;
        else extra[prop as string] = value;

        return true;
      },
    });
  };

  dom.window.HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement, kind: string) {
    if (kind !== '2d') return null;

    const host = this as HTMLCanvasElement & { __stubContext?: unknown };

    if (!host.__stubContext) {
      const context = makeContext() as { canvas: unknown };

      context.canvas = this;
      host.__stubContext = context;
    }

    return host.__stubContext;
  } as unknown as HTMLCanvasElement['getContext'];
});

const STROKE_SETTINGS = {
  color: '#111111',
  width: 4,
  opacity: 1,
} as unknown as UseWhiteboardCanvasProps['strokeSettings'];

// jsdom has no layout, so every getBoundingClientRect is 0x0 at 0,0. The pointer-geometry tests need a
// rect they can MOVE, to prove the hook's cache is dropped when the element moves — so the prototype is
// stubbed once and driven from this box. Left at all-zeros, it changes nothing for the other tests.
let stubRect = { left: 0, top: 0, width: 0, height: 0 };

function setStubRect(next: { left: number; top: number; width: number; height: number }): void {
  stubRect = next;
}

interface TouchHarness {
  container: HTMLDivElement;
  debug: () => InputDebugSnapshot;
  /** The Fabric canvas, so a test can drive the real pointer funnel (getScenePoint). */
  canvas: () => FabricCanvas;
  unmount: () => Promise<void>;
  /** The live active tool (only meaningful with `toggleableTool`). */
  activeTool: () => string;
  /** Let pending React updates (a tool toggle) land. */
  flush: () => Promise<void>;
}

interface MountOptions {
  tabletInputSettings?: UseWhiteboardCanvasProps['tabletInputSettings'];
  onContactCaptured?: UseWhiteboardCanvasProps['onContactCaptured'];
  /** Own the active tool in state and flip pen <-> eraser on onShortcutToolToggle, like the editor. */
  toggleableTool?: boolean;
  eraserMode?: UseWhiteboardCanvasProps['eraserMode'];
  onShortcutQuickMenu?: UseWhiteboardCanvasProps['onShortcutQuickMenu'];
  onShortcutColorToggle?: UseWhiteboardCanvasProps['onShortcutColorToggle'];
  onNativePenPoint?: UseWhiteboardCanvasProps['onNativePenPoint'];
}

async function mountWhiteboard(options: MountOptions = {}): Promise<TouchHarness> {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { useWhiteboardCanvas } = await import('./useWhiteboardCanvas');

  const host = document.createElement('div');

  document.body.append(host);

  let containerEl: HTMLDivElement | null = null;
  let fabricCanvas: FabricCanvas | null = null;
  let liveTool = 'pen';

  function Harness() {
    const [tool, setTool] = React.useState<'pen' | 'eraser'>('pen');
    const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const zoomLayerRef = React.useRef<HTMLDivElement | null>(null);
    const cursorRef = React.useRef<HTMLDivElement | null>(null);

    useWhiteboardCanvas({
      canvasRef,
      containerRef,
      zoomLayerRef,
      wholeHandEraserCursorRef: cursorRef,
      activeTool: options.toggleableTool ? tool : 'pen',
      ...(options.toggleableTool
        ? { onShortcutToolToggle: () => setTool((current) => (current === 'eraser' ? 'pen' : 'eraser')) }
        : {}),
      strokeSettings: STROKE_SETTINGS,
      eraserMode: options.eraserMode ?? 'object',
      eraserSize: 20,
      ...(options.onShortcutQuickMenu ? { onShortcutQuickMenu: options.onShortcutQuickMenu } : {}),
      ...(options.onShortcutColorToggle ? { onShortcutColorToggle: options.onShortcutColorToggle } : {}),
      ...(options.onNativePenPoint ? { onNativePenPoint: options.onNativePenPoint } : {}),
      fillColor: '#ffffff',
      ...(options.tabletInputSettings ? { tabletInputSettings: options.tabletInputSettings } : {}),
      ...(options.onContactCaptured ? { onContactCaptured: options.onContactCaptured } : {}),
      onCanvasReady: (ready) => {
        fabricCanvas = ready;
      },
    });

    containerEl = containerRef.current;
    liveTool = tool;

    return React.createElement(
      'div',
      { ref: containerRef },
      React.createElement('div', { ref: zoomLayerRef }, React.createElement('canvas', { ref: canvasRef })),
      React.createElement('div', { ref: cursorRef }),
    );
  }

  const root = createRoot(host);

  await act(async () => {
    root.render(React.createElement(Harness));
  });

  assert.ok(containerEl, 'harness container did not mount');
  assert.ok(fabricCanvas, 'harness never received the fabric canvas');

  return {
    container: containerEl as unknown as HTMLDivElement,
    canvas: () => fabricCanvas as unknown as FabricCanvas,
    debug: () => (window as unknown as { __wbInputDebug: InputDebugSnapshot }).__wbInputDebug,
    activeTool: () => liveTool,
    flush: async () => {
      await act(async () => {});
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

interface TouchInit {
  pointerId: number;
  clientX: number;
  clientY: number;
  /** PointerEvent.timeStamp (ms) — the clock the pan velocity estimate reads. */
  timeStamp?: number;
  /** 1x1 is what a phone browser reports for a finger — the "unknown placeholder" size that makes the
   *  hook route the contact to DRAW rather than to the size-gated single-finger pan. */
  width?: number;
  height?: number;
}

/** jsdom has no PointerEvent, so build the MouseEvent it does have and graft the pointer fields on —
 *  the handlers read exactly these. */
function firePointer(target: HTMLElement, type: string, init: TouchInit): Event {
  const event = new window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
  });

  Object.assign(event, {
    pointerId: init.pointerId,
    pointerType: 'touch',
    width: init.width ?? 1,
    height: init.height ?? 1,
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
    twist: 0,
    isPrimary: init.pointerId === 1,
    getCoalescedEvents: () => [],
    getPredictedEvents: () => [],
  });

  if (init.timeStamp !== undefined) {
    Object.defineProperty(event, 'timeStamp', { value: init.timeStamp });
  }

  // The handlers may call setEffectiveTool. We assert on the hook's own input-debug snapshot rather
  // than on rendered output, so step out of the act environment for the dispatch instead of wrapping
  // every event in an `act` the assertions do not need.
  const actGlobals = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const wasActEnvironment = actGlobals.IS_REACT_ACT_ENVIRONMENT;

  actGlobals.IS_REACT_ACT_ENVIRONMENT = false;

  try {
    target.dispatchEvent(event);
  } finally {
    actGlobals.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
  }

  return event;
}

// THE REGRESSION. A phone is a touch-only-routed device: one finger draws. A stray second contact
// (knuckle, palm edge, the hand holding the phone) promotes the gesture to multi-pan, which truncates
// the stroke — acceptable. What is NOT acceptable is what happened when that stray contact lifted while
// the drawing finger stayed down: the release handler's `multi` branch returned WITHOUT ending the pan,
// so 'multi' survived with one contact left. The move handler then refused every path — not drawing
// (touchOverride is 'pan'), not single-pan (mode is 'multi'), not multi-pan (fewer than 2 contacts) —
// and the board was wedged until the finger lifted.
test('a stray second contact lifting does not wedge the still-down finger', async () => {
  const harness = await mountWhiteboard();

  try {
    // A lands and draws.
    firePointer(harness.container, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 100 });
    // B — the stray contact — lands: two contacts now, so the gesture becomes a multi-finger pan.
    firePointer(harness.container, 'pointerdown', { pointerId: 2, clientX: 220, clientY: 140 });

    const duringMulti = harness.debug();

    assert.equal(duringMulti.activePtrs, 2, 'both contacts should be tracked');

    // B lifts after ~a frame; A never left the glass.
    firePointer(harness.container, 'pointerup', { pointerId: 2, clientX: 220, clientY: 140 });

    // A keeps moving. This move is what used to fall through every branch.
    const move = firePointer(harness.container, 'pointermove', { pointerId: 1, clientX: 130, clientY: 118 });
    const afterRelease = harness.debug();

    // THE INVARIANT: no 'multi' pan state may survive a drop below two contacts.
    assert.notEqual(afterRelease.touchPanMode, 'multi', "'multi' pan state survived the drop below two contacts");
    assert.equal(afterRelease.activePtrs, 1, 'only the still-down finger should remain tracked');
    assert.equal(afterRelease.touchPanMode, 'single', 'the remaining contact should keep panning');

    // ...and the move is actually CONSUMED by the pan branch rather than falling through unhandled,
    // which is the observable difference between "wedged" and "still driving the board".
    assert.equal(move.defaultPrevented, true, 'the remaining contact drove nothing — the board is wedged');

    // A second move keeps working (the pan is a real, continuing gesture, not a one-shot).
    const move2 = firePointer(harness.container, 'pointermove', { pointerId: 1, clientX: 160, clientY: 132 });

    assert.equal(move2.defaultPrevented, true, 'the continued pan stopped being handled');

    // Lifting the last contact ends the gesture and hands the board back to the pen.
    firePointer(harness.container, 'pointerup', { pointerId: 1, clientX: 160, clientY: 132 });
    firePointer(harness.container, 'pointerdown', { pointerId: 3, clientX: 90, clientY: 90 });

    const afterFullRelease = harness.debug();

    assert.equal(afterFullRelease.touchPanMode, null, 'pan state outlived the last contact');
    assert.equal(afterFullRelease.touchOverride, null, "touch override stayed 'pan' after the gesture ended");
  } finally {
    await harness.unmount();
  }
});

// The same invariant through the OTHER door: when the OS drops the stray contact's release outright
// (routine on a pen+touch panel), `lostpointercapture` is the only signal that it is gone. It removes
// the pointer and then calls the reaper — which only recovers once BOTH touch maps are EMPTY, so with
// the drawing finger still down it does nothing, and 'multi' would survive exactly as above.
test('a lost pointer capture below two contacts does not leave multi-pan stranded', async () => {
  const harness = await mountWhiteboard();

  try {
    firePointer(harness.container, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 100 });
    firePointer(harness.container, 'pointerdown', { pointerId: 2, clientX: 220, clientY: 140 });

    // B's release is dropped; only lostpointercapture tells us it is gone.
    firePointer(harness.container, 'lostpointercapture', { pointerId: 2, clientX: 220, clientY: 140 });

    const move = firePointer(harness.container, 'pointermove', { pointerId: 1, clientX: 130, clientY: 118 });
    const afterLoss = harness.debug();

    assert.equal(afterLoss.activePtrs, 1, 'the lost contact should be gone from the map');
    assert.notEqual(afterLoss.touchPanMode, 'multi', "'multi' pan state survived a lost pointer capture");
    assert.equal(move.defaultPrevented, true, 'the remaining contact drove nothing — the board is wedged');
  } finally {
    await harness.unmount();
  }
});

// DRAW PERF. Fabric re-measures the DOM on every `_getPointerImpl` — a rect on the upper canvas plus
// calcOffset()'s getComputedStyle + a second rect — and since v0.1.142 that funnel runs once per
// COALESCED SUB-FRAME SAMPLE, not once per event. The hook now serves all of it from one cached
// snapshot. This pins BOTH halves of the bargain: the cache really is a cache (a moved element that
// nothing announced keeps resolving against the old rect), and it is really dropped when something
// announces the move — because a stroke drawn after a resize against a stale rect lands in the wrong
// place, which is a far worse bug than the one the cache fixes.
test('the pointer geometry cache is dropped when the canvas moves', async () => {
  setStubRect({ left: 50, top: 20, width: 400, height: 300 });

  const harness = await mountWhiteboard();

  try {
    const canvas = harness.canvas();

    // jsdom reports clientWidth 0, so the canvas would be 0x0 and the CSS-to-backing-store scale would
    // collapse the pointer to the origin. Give it the stub rect's size (and no retina divide) so the
    // funnel's arithmetic is the identity apart from the offset we are actually testing.
    canvas.enableRetinaScaling = false;
    canvas.setDimensions({ width: 400, height: 300 });

    const resolve = (clientX: number, clientY: number) =>
      canvas.getScenePoint({ clientX, clientY, target: null } as unknown as MouseEvent);

    const atRest = resolve(150, 120);

    assert.deepEqual(
      { x: Math.round(atRest.x), y: Math.round(atRest.y) },
      { x: 100, y: 100 },
      'the funnel did not subtract the canvas offset',
    );

    // The element moves with nothing to announce it: the cached rect must still be in force, which is
    // the whole point — otherwise every coalesced sample would re-measure.
    setStubRect({ left: 0, top: 0, width: 400, height: 300 });

    const cached = resolve(150, 120);

    assert.deepEqual(
      { x: Math.round(cached.x), y: Math.round(cached.y) },
      { x: 100, y: 100 },
      'the geometry was re-measured per call — the cache is not caching',
    );

    // Now announce it. A window resize is one of the events the invalidation list covers.
    window.dispatchEvent(new window.Event('resize'));

    const afterResize = resolve(150, 120);

    assert.deepEqual(
      { x: Math.round(afterResize.x), y: Math.round(afterResize.y) },
      { x: 150, y: 120 },
      'a stroke after a resize resolved against the STALE rect — ink would land in the wrong place',
    );

    // And the per-contact backstop: a layout shift that changes no size at all (surrounding chrome
    // toggling) is invisible to the ResizeObserver, so pointerdown re-measures unconditionally.
    setStubRect({ left: 10, top: 10, width: 400, height: 300 });
    firePointer(harness.container, 'pointerdown', { pointerId: 11, clientX: 150, clientY: 120 });

    const afterContactStart = resolve(150, 120);

    // 120 - 10 offset. No nib lift: the aim correction is off by default (the opt-in is tested below).
    assert.deepEqual(
      { x: Math.round(afterContactStart.x), y: Math.round(afterContactStart.y) },
      { x: 140, y: 110 },
      'pointerdown did not re-measure — a silent layout shift would offset the whole stroke',
    );

    firePointer(harness.container, 'pointerup', { pointerId: 11, clientX: 150, clientY: 120 });
  } finally {
    setStubRect({ left: 0, top: 0, width: 0, height: 0 });
    await harness.unmount();
  }
});

// DRAW PERF, the other constant cost. The app passes `onContactCaptured` unconditionally, and the
// capture switch used to be consulted only at stroke END — so every touch move on every board paid a
// classifier replay, two freshly allocated options objects, a frame object and an array push for rows
// that were then thrown away. The switch is now read per move, and a contact that began while capture
// was off is never opened at all.
test('the training capture records nothing per move while capture is off', async () => {
  const { DEFAULT_TABLET_INPUT_SETTINGS } = await import('@repo/whiteboard-core');
  const captured: unknown[] = [];

  const drawOneContact = (harness: TouchHarness) => {
    firePointer(harness.container, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 100 });
    firePointer(harness.container, 'pointermove', { pointerId: 1, clientX: 102, clientY: 104 });
    firePointer(harness.container, 'pointermove', { pointerId: 1, clientX: 105, clientY: 109 });
    firePointer(harness.container, 'pointerup', { pointerId: 1, clientX: 105, clientY: 109 });
  };

  const offHarness = await mountWhiteboard({
    tabletInputSettings: { ...DEFAULT_TABLET_INPUT_SETTINGS, penCaptureEnabled: false },
    onContactCaptured: (contact) => captured.push(contact),
  });

  try {
    drawOneContact(offHarness);

    assert.equal(captured.length, 0, 'a board with capture OFF still recorded and emitted a contact');
  } finally {
    await offHarness.unmount();
  }

  // The same run with the switch ON still captures — the gate must be the switch, not a dead path.
  const onHarness = await mountWhiteboard({
    tabletInputSettings: { ...DEFAULT_TABLET_INPUT_SETTINGS, penCaptureEnabled: true },
    onContactCaptured: (contact) => captured.push(contact),
  });

  try {
    drawOneContact(onHarness);

    assert.equal(captured.length, 1, 'a board with capture ON recorded nothing — the gate is too wide');

    const [contact] = captured as { frames: unknown[] }[];

    assert.ok(contact.frames.length > 0, 'the captured contact has no frames');
  } finally {
    await onHarness.unmount();
  }
});

// PHONE HARDENING. Every one of these, left to the browser, fires a `pointercancel` that truncates the
// stroke mid-letter: an edge swipe handed to the page's scroll, a long-press raising the OS selection
// or callout menu, a rubber-band overscroll. `touch-action` is also set by the canvas component's
// class, but the hook owns the gesture model, so it states the whole invariant itself.
test('the board container is hardened against OS gestures stealing the stroke', async () => {
  const harness = await mountWhiteboard();

  try {
    const { style } = harness.container;

    assert.equal(style.touchAction, 'none', 'browser scroll/zoom can still steal the gesture');
    assert.equal(style.overscrollBehavior, 'contain', 'a rubber-band overscroll can still cancel the stroke');
    assert.equal(style.userSelect, 'none', 'a long-press can still start a text selection');

    // A long-press context menu arrives while a touch contact is live and must be swallowed even though
    // pen buttons are off (the old gate) — it is the touch case that costs the teacher a stroke.
    firePointer(harness.container, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 100 });

    const menu = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });

    harness.container.dispatchEvent(menu);

    assert.equal(menu.defaultPrevented, true, 'a touch long-press can still raise the OS context menu');

    firePointer(harness.container, 'pointerup', { pointerId: 1, clientX: 100, clientY: 100 });
  } finally {
    await harness.unmount();
  }
});

// --- Endless ink on pen hover -----------------------------------------------------------------------
//
// Fabric v7 (non-pointer mode) draws from the raw touch + compat MOUSE streams and never looks at
// `buttons`: `_onMouseMoveInDrawingMode` extends the open path on every mousemove while
// `_isCurrentlyDrawing`. A hovering stylus (Android S Pen / M-Pen, ThinkPad active pen) produces
// pointermove (pointerType 'pen', buttons 0) AND compat mousemove (buttons 0), so one lost
// touchend/mouseup lets the hover path ink forever. The invariant under test: a pen/mouse moving WITHOUT
// contact while a stroke is open ⇒ that stroke is committed (kept) immediately and the hover never
// reaches the brush. The stroke is opened the way Fabric really opens it — through its own mousedown
// listener on the upper canvas — so the test drives the real `_isCurrentlyDrawing` state.

interface MouseInit {
  clientX: number;
  clientY: number;
  buttons: number;
}

function fireMouse(target: EventTarget, type: string, init: MouseInit): MouseEvent {
  const event = new window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
    buttons: init.buttons,
    button: 0,
  });

  const actGlobals = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const wasActEnvironment = actGlobals.IS_REACT_ACT_ENVIRONMENT;

  actGlobals.IS_REACT_ACT_ENVIRONMENT = false;

  try {
    target.dispatchEvent(event);
  } finally {
    actGlobals.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
  }

  return event;
}

/** A stylus pointer event: `pointerType: 'pen'`, with the contact state the digitizer reports. */
function firePen(
  target: HTMLElement,
  type: string,
  init: MouseInit & { pointerId?: number; pressure?: number; tiltX?: number; tiltY?: number },
): Event {
  const event = new window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
    buttons: init.buttons,
  });

  Object.assign(event, {
    pointerId: init.pointerId ?? 7,
    pointerType: 'pen',
    width: 1,
    height: 1,
    pressure: init.pressure ?? (init.buttons & 1 ? 0.5 : 0),
    tiltX: init.tiltX ?? 0,
    tiltY: init.tiltY ?? 0,
    twist: 0,
    isPrimary: true,
    getCoalescedEvents: () => [],
    getPredictedEvents: () => [],
  });

  const actGlobals = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const wasActEnvironment = actGlobals.IS_REACT_ACT_ENVIRONMENT;

  actGlobals.IS_REACT_ACT_ENVIRONMENT = false;

  try {
    target.dispatchEvent(event);
  } finally {
    actGlobals.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
  }

  return event;
}

type DrawingCanvas = FabricCanvas & { _isCurrentlyDrawing?: boolean };

/** A real 'pen' event latches the pen-device model into localStorage (persisted across mounts, and jsdom's
 *  storage outlives a test). Tests that fire pen events un-latch it on the way out so a later mount is
 *  the touch-only device it expects to be. */
function forgetPenDevice(): void {
  window.localStorage.removeItem('whiteboard-has-seen-pen');
}

/** Open a stroke through Fabric's OWN mousedown/mousemove listeners (buttons 1 = tip/left down). */
function openFabricStroke(harness: TouchHarness): DrawingCanvas {
  const canvas = harness.canvas() as DrawingCanvas;

  assert.equal(canvas.isDrawingMode, true, 'the pen tool should have put Fabric in drawing mode');

  fireMouse(canvas.upperCanvasEl, 'mousedown', { clientX: 100, clientY: 100, buttons: 1 });
  fireMouse(canvas.upperCanvasEl, 'mousemove', { clientX: 140, clientY: 120, buttons: 1 });

  assert.equal(canvas._isCurrentlyDrawing, true, 'Fabric did not open a stroke from its own mousedown');

  return canvas;
}

test('a compat mousemove with no contact commits the open stroke and never reaches the brush', async () => {
  const harness = await mountWhiteboard();

  try {
    const canvas = openFabricStroke(harness);
    const objectsBefore = canvas.getObjects().length;
    const recoveredBefore = (harness.debug() as unknown as { recovered: number }).recovered;

    // Fabric moved its mousemove listener to the document for the stroke's duration; this spy sits
    // behind it in the same bubble phase, so "spy not called" ⇔ "the hover never reached Fabric".
    let reachedDocument = 0;
    const spy = () => {
      reachedDocument += 1;
    };

    document.addEventListener('mousemove', spy);

    try {
      // The lost lift: no mouseup ever arrives. The pen now hovers over the glass.
      fireMouse(canvas.upperCanvasEl, 'mousemove', { clientX: 300, clientY: 260, buttons: 0 });
    } finally {
      document.removeEventListener('mousemove', spy);
    }

    assert.equal(canvas._isCurrentlyDrawing, false, 'the hover should have closed the stranded stroke');
    assert.equal(reachedDocument, 0, 'the hover mousemove still reached Fabric (document) listeners');
    assert.equal(canvas.getObjects().length, objectsBefore + 1, 'the stranded stroke was discarded, not kept');
    assert.equal(
      (harness.debug() as unknown as { recovered: number }).recovered,
      recoveredBefore + 1,
      'the hover commit should count as an input recovery in the debug overlay',
    );

    // Hover goes on — nothing is open, so nothing is touched and nothing is swallowed.
    const later = dispatchWatched('mousemove', () =>
      fireMouse(canvas.upperCanvasEl, 'mousemove', { clientX: 320, clientY: 280, buttons: 0 }),
    );

    assert.equal(later.reachedDocument, true, 'an idle hover must not be swallowed');
    assert.equal(canvas.getObjects().length, objectsBefore + 1);
  } finally {
    await harness.unmount();
  }
});

test('a pen pointermove with no contact commits the open stroke, even when its pointerup was lost', async () => {
  const harness = await mountWhiteboard();

  try {
    // The pen lands (pointerdown, tip down) — its twin contact opens Fabric's stroke.
    firePen(harness.container, 'pointerdown', { pointerId: 7, clientX: 100, clientY: 100, buttons: 1 });

    const canvas = openFabricStroke(harness);

    assert.equal((harness.debug() as unknown as { activePen: number }).activePen, 1);

    // Both the pointerup AND the twin touchend are lost. The first hover frame (pen, buttons 0,
    // pressure 0) is the only evidence the pen ever left the glass.
    firePen(harness.container, 'pointermove', { pointerId: 7, clientX: 300, clientY: 260, buttons: 0 });

    assert.equal(canvas._isCurrentlyDrawing, false, 'the pen hover should have closed the stranded stroke');
    // The stale pen-down record is healed too, so the twin-touch guard and idle reaper see the truth.
    assert.equal(
      (harness.debug() as unknown as { activePen: number }).activePen,
      0,
      'the lost pointerup left the pen recorded as down',
    );
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

test('a pen hovering with its barrel button held is still off the glass', async () => {
  const harness = await mountWhiteboard();

  try {
    const canvas = openFabricStroke(harness);

    // buttons 2 = barrel held, tip NOT down. `buttons === 0` would miss this.
    firePen(harness.container, 'pointermove', { clientX: 300, clientY: 260, buttons: 2 });

    assert.equal(canvas._isCurrentlyDrawing, false, 'barrel-held hover should still close the stroke');
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

test('contact moves and touch pointers never close a live stroke', async () => {
  const harness = await mountWhiteboard();

  try {
    const canvas = openFabricStroke(harness);

    // Tip down (buttons 1), tip down with barrel held (3): in contact — the stroke is LIVE.
    fireMouse(canvas.upperCanvasEl, 'mousemove', { clientX: 150, clientY: 130, buttons: 1 });
    firePen(harness.container, 'pointermove', { clientX: 160, clientY: 135, buttons: 1 });
    firePen(harness.container, 'pointermove', { clientX: 170, clientY: 140, buttons: 3 });

    assert.equal(canvas._isCurrentlyDrawing, true, 'a contact move closed a live stroke');

    // A touch pointer has no hover state and is never judged — whatever its buttons say.
    firePointer(harness.container, 'pointermove', { pointerId: 9, clientX: 180, clientY: 150 });

    assert.equal(canvas._isCurrentlyDrawing, true, 'a touch pointermove closed a live stroke');
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

// ViewSonic / phone: the harness never sees a 'pen' event, so it is routed touch-only and a single
// finger draws. A mouse nudged on the desk (compat or real, buttons 0) while that finger is down says
// nothing about the finger — the stroke it holds open must survive.
test('a mouse hover never closes a stroke a finger is holding open on a touch-only device', async () => {
  forgetPenDevice();

  const harness = await mountWhiteboard();

  try {
    firePointer(harness.container, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 100 });

    const canvas = openFabricStroke(harness);

    fireMouse(canvas.upperCanvasEl, 'mousemove', { clientX: 300, clientY: 260, buttons: 0 });

    assert.equal(canvas._isCurrentlyDrawing, true, "a mouse hover truncated the finger's live stroke");

    firePointer(harness.container, 'pointerup', { pointerId: 1, clientX: 100, clientY: 100 });
  } finally {
    await harness.unmount();
  }
});

// ThinkPad in laptop mode: the hand holding the pen brushes the trackpad mid-letter. That is a MOUSE
// hover while the PEN is physically down — not the pen lifting.
test('a mouse hover never closes a stroke while a pen is physically down', async () => {
  const harness = await mountWhiteboard();

  try {
    firePen(harness.container, 'pointerdown', { pointerId: 7, clientX: 100, clientY: 100, buttons: 1 });

    const canvas = openFabricStroke(harness);

    fireMouse(canvas.upperCanvasEl, 'mousemove', { clientX: 300, clientY: 260, buttons: 0 });

    assert.equal(canvas._isCurrentlyDrawing, true, "a trackpad brush truncated the pen's live stroke");

    firePen(harness.container, 'pointerup', { pointerId: 7, clientX: 170, clientY: 140, buttons: 0 });
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

// --- A finger leaves a DOT (Android) -----------------------------------------------------------------
//
// Fabric draws from the raw TOUCH stream. On a pen device blockTouchFromFabricOnPenDevice starves every
// touch except the pen's own twin. It used to tell the twin apart by contact RADIUS (a tiny positive
// radius passed as the pen tip) — and the Samsung tablet reports palm contacts that way, so palms inked
// dots where the hand rests, and a palm touchstart RESET the pen's open path to the palm (straight
// lines). The twin is now identified POSITIVELY: a touchstart is the pen's twin iff a 'pen' pointerdown
// is down, fresh, and at that position (Blink dispatches it right before the twin touchstart). Anything
// else is starved, whatever its radius.

interface TouchInit2 {
  identifier: number;
  clientX: number;
  clientY: number;
  radiusX?: number;
  radiusY?: number;
  touchType?: string;
}

/** jsdom has no usable Touch/TouchList constructors; graft array-likes onto a plain cancelable Event,
 *  which is all the guard and Fabric read (`changedTouches[i]`, `touches.length`, preventDefault). */
function fireTouch(target: EventTarget, type: string, changed: TouchInit2[], stillDown: TouchInit2[] = changed): Event {
  const toTouch = (t: TouchInit2) => ({
    identifier: t.identifier,
    clientX: t.clientX,
    clientY: t.clientY,
    pageX: t.clientX,
    pageY: t.clientY,
    screenX: t.clientX,
    screenY: t.clientY,
    radiusX: t.radiusX ?? 0,
    radiusY: t.radiusY ?? 0,
    rotationAngle: 0,
    force: 0.5,
    target,
    ...(t.touchType !== undefined ? { touchType: t.touchType } : {}),
  });
  const list = (items: TouchInit2[]) => {
    const touches = items.map(toTouch);

    return Object.assign(touches, { item: (i: number) => touches[i] ?? null });
  };
  const event = new window.Event(type, { bubbles: true, cancelable: true });

  Object.assign(event, { changedTouches: list(changed), touches: list(stillDown), targetTouches: list(stillDown) });

  const actGlobals = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const wasActEnvironment = actGlobals.IS_REACT_ACT_ENVIRONMENT;

  actGlobals.IS_REACT_ACT_ENVIRONMENT = false;

  try {
    target.dispatchEvent(event);
  } finally {
    actGlobals.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
  }

  return event;
}

/** Dispatch via `dispatch` and report whether the event reached a DOCUMENT bubble listener. The DOM clears
 *  the stop-propagation flag once dispatch ends (so the event's own flag reads false afterwards either
 *  way); Fabric's own listeners sit on the upper canvas and on the document, so "reached the document"
 *  is exactly "was not starved by the container's capture-phase guard". */
function dispatchWatched(type: string, dispatch: () => Event): { event: Event; reachedDocument: boolean } {
  let reachedDocument = false;
  const spy = () => {
    reachedDocument = true;
  };

  document.addEventListener(type, spy);

  try {
    const event = dispatch();

    return { event, reachedDocument };
  } finally {
    document.removeEventListener(type, spy);
  }
}

/** The real pen path: a 'pen' pointerdown, then its twin touchstart at the same spot, which Fabric's own
 *  touchstart listener turns into an open stroke. Returns the canvas. */
function openPenTwinStroke(
  harness: TouchHarness,
  init: { pointerId?: number; identifier?: number; clientX?: number; clientY?: number } = {},
): DrawingCanvas {
  const canvas = harness.canvas() as DrawingCanvas;
  const pointerId = init.pointerId ?? 7;
  const identifier = init.identifier ?? 0;
  const clientX = init.clientX ?? 100;
  const clientY = init.clientY ?? 100;

  firePen(harness.container, 'pointerdown', { pointerId, clientX, clientY, buttons: 1 });
  fireTouch(canvas.upperCanvasEl, 'touchstart', [{ identifier, clientX, clientY, radiusX: 1, radiusY: 1 }]);

  assert.equal(canvas._isCurrentlyDrawing, true, 'the pen twin did not open the stroke');

  return canvas;
}

/** Make the harness a pen device the way the real one becomes one: a pen event was seen. */
function latchPenDevice(harness: TouchHarness): void {
  firePen(harness.container, 'pointerdown', { pointerId: 7, clientX: 10, clientY: 10, buttons: 1 });
  firePen(harness.container, 'pointerup', { pointerId: 7, clientX: 10, clientY: 10, buttons: 0 });
}

test('on a pen device a finger never opens a Fabric stroke, whatever radius the panel reports', async () => {
  const harness = await mountWhiteboard();

  try {
    latchPenDevice(harness);

    const canvas = harness.canvas() as DrawingCanvas;
    const objectsBefore = canvas.getObjects().length;

    // The finger: its pointerdown ('touch') lands first, then its touchstart at the same spot with the
    // tip-sized radius Android reports for a finger.
    firePointer(harness.container, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 100 });

    const start = dispatchWatched('touchstart', () =>
      fireTouch(canvas.upperCanvasEl, 'touchstart', [{ identifier: 0, clientX: 100, clientY: 100, radiusX: 1, radiusY: 1 }]),
    );

    assert.equal(canvas._isCurrentlyDrawing ?? false, false, 'the finger opened a Fabric stroke — the dot');
    assert.equal(start.reachedDocument, false, "the finger's touchstart still reached Fabric");
    assert.equal(start.event.defaultPrevented, true, "the finger's compat mouse events were not cancelled");

    // Its whole life is a finger: a later touchmove with a radius that would pass the tip rule is
    // still starved, and so is its touchend.
    const move = dispatchWatched('touchmove', () =>
      fireTouch(canvas.upperCanvasEl, 'touchmove', [{ identifier: 0, clientX: 104, clientY: 103, radiusX: 1, radiusY: 1 }]),
    );
    const end = dispatchWatched('touchend', () =>
      fireTouch(canvas.upperCanvasEl, 'touchend', [{ identifier: 0, clientX: 104, clientY: 103 }], []),
    );

    assert.equal(move.reachedDocument, false, "the finger's touchmove reached Fabric");
    assert.equal(end.reachedDocument, false, "the finger's touchend reached Fabric");
    assert.equal(canvas._isCurrentlyDrawing ?? false, false);
    assert.equal(canvas.getObjects().length, objectsBefore, 'a dot was committed');

    firePointer(harness.container, 'pointerup', { pointerId: 1, clientX: 104, clientY: 103 });
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

test("the pen's own twin contact still reaches Fabric and inks (a blocked twin is a dead pen)", async () => {
  const harness = await mountWhiteboard();

  try {
    latchPenDevice(harness);

    const canvas = harness.canvas() as DrawingCanvas;
    const objectsBefore = canvas.getObjects().length;

    // The pen: a 'pen' pointerdown, then the twin touchstart — no TOUCH pointerdown preceded it.
    firePen(harness.container, 'pointerdown', { pointerId: 7, clientX: 100, clientY: 100, buttons: 1 });

    const start = dispatchWatched('touchstart', () =>
      fireTouch(canvas.upperCanvasEl, 'touchstart', [{ identifier: 0, clientX: 100, clientY: 100, radiusX: 1, radiusY: 1 }]),
    );

    assert.equal(start.reachedDocument, true, 'the pen twin was starved');
    assert.equal(canvas._isCurrentlyDrawing, true, 'the pen twin did not open the stroke');

    fireTouch(canvas.upperCanvasEl, 'touchmove', [{ identifier: 0, clientX: 140, clientY: 120, radiusX: 1, radiusY: 1 }]);
    firePen(harness.container, 'pointerup', { pointerId: 7, clientX: 140, clientY: 120, buttons: 0 });
    fireTouch(canvas.upperCanvasEl, 'touchend', [{ identifier: 0, clientX: 140, clientY: 120, radiusX: 1, radiusY: 1 }], []);

    assert.equal(canvas._isCurrentlyDrawing, false, "the twin's touchend did not close the stroke");
    assert.equal(canvas.getObjects().length, objectsBefore + 1, 'the pen stroke was not kept');
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

// WebKit reports Touch.touchType. When it does, it is authoritative over any radius.
test("touchType 'direct' is a finger and 'stylus' is the pen, whatever the radius (WebKit)", async () => {
  const harness = await mountWhiteboard();

  try {
    latchPenDevice(harness);

    const canvas = harness.canvas() as DrawingCanvas;

    // No pointerdown record at all (the Chromium signal is absent) — the label alone must decide.
    const finger = dispatchWatched('touchstart', () =>
      fireTouch(canvas.upperCanvasEl, 'touchstart', [
        { identifier: 0, clientX: 100, clientY: 100, radiusX: 1, radiusY: 1, touchType: 'direct' },
      ]),
    );

    assert.equal(finger.reachedDocument, false, "a 'direct' contact with a tip-sized radius reached Fabric");
    assert.equal(canvas._isCurrentlyDrawing ?? false, false);

    fireTouch(canvas.upperCanvasEl, 'touchend', [{ identifier: 0, clientX: 100, clientY: 100, touchType: 'direct' }], []);

    const stylus = dispatchWatched('touchstart', () =>
      fireTouch(canvas.upperCanvasEl, 'touchstart', [
        { identifier: 0, clientX: 300, clientY: 300, radiusX: 40, radiusY: 40, touchType: 'stylus' },
      ]),
    );

    assert.equal(stylus.reachedDocument, true, "a 'stylus' contact with a palm-sized radius was starved");
    assert.equal(canvas._isCurrentlyDrawing, true);

    fireTouch(canvas.upperCanvasEl, 'touchend', [{ identifier: 0, clientX: 300, clientY: 300, touchType: 'stylus' }], []);
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

test("a 'stylus' touch latches the pen-device model on a fresh install, like a 'pen' pointer event", async () => {
  forgetPenDevice();

  const harness = await mountWhiteboard();

  try {
    const canvas = harness.canvas() as DrawingCanvas;

    assert.equal(harness.debug().isDrawingMode, true);
    assert.notEqual(window.localStorage.getItem('whiteboard-has-seen-pen'), '1');

    fireTouch(canvas.upperCanvasEl, 'touchstart', [
      { identifier: 0, clientX: 100, clientY: 100, radiusX: 1, radiusY: 1, touchType: 'stylus' },
    ]);
    fireTouch(canvas.upperCanvasEl, 'touchend', [{ identifier: 0, clientX: 100, clientY: 100, touchType: 'stylus' }], []);

    assert.equal(window.localStorage.getItem('whiteboard-has-seen-pen'), '1', "a 'stylus' touch did not latch");
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

// ViewSonic / phone: touch-only routed, the finger (or capacitive pen head) IS the drawing contact and
// must keep reaching Fabric — the finger-identity rule applies only once a real pen has been seen.
test('on a touch-only device the finger still reaches Fabric and draws', async () => {
  forgetPenDevice();

  const harness = await mountWhiteboard();

  try {
    const canvas = harness.canvas() as DrawingCanvas;

    firePointer(harness.container, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 100 });

    const start = dispatchWatched('touchstart', () =>
      fireTouch(canvas.upperCanvasEl, 'touchstart', [{ identifier: 0, clientX: 100, clientY: 100, radiusX: 1, radiusY: 1 }]),
    );

    assert.equal(start.reachedDocument, true, 'the drawing finger was starved on a touch-only device');
    assert.equal(canvas._isCurrentlyDrawing, true, 'the finger did not open the stroke');

    fireTouch(canvas.upperCanvasEl, 'touchend', [{ identifier: 0, clientX: 100, clientY: 100 }], []);
    firePointer(harness.container, 'pointerup', { pointerId: 1, clientX: 100, clientY: 100 });
  } finally {
    await harness.unmount();
  }
});

// --- The lift tail --------------------------------------------------------------------------------
//
// After the pen physically leaves the glass the digitizer still reports it for a frame or two —
// pressure 0 with the contact bit still set, or the bit already clear in a coalesced sample — before
// the stroke-ending event reaches Fabric. Those positions used to be appended (by
// injectCoalescedSamples, and by Fabric from the frame's own twin touchmove / compat mousemove), drawing
// a short tail past the real lift point. A pressure-0 sample is SKIPPED but never closes the stroke
// (losing the rest of a letter to a flaky pressure reading is worse than a tail); only a clear contact
// bit is the lift.

interface PenFrameSample {
  clientX: number;
  clientY: number;
  buttons: number;
  pressure: number;
}

/** A pen pointermove whose getCoalescedEvents() replays the given samples (the last one is the frame). */
function firePenFrame(target: HTMLElement, pointerId: number, samples: PenFrameSample[]): Event {
  const frame = samples[samples.length - 1];
  const event = new window.MouseEvent('pointermove', {
    bubbles: true,
    cancelable: true,
    clientX: frame.clientX,
    clientY: frame.clientY,
    buttons: frame.buttons,
  });
  const coalesced = samples.map((s) => ({ ...s, pointerId, pointerType: 'pen', isPrimary: true }));

  Object.assign(event, {
    pointerId,
    pointerType: 'pen',
    width: 1,
    height: 1,
    pressure: frame.pressure,
    tiltX: 0,
    tiltY: 0,
    twist: 0,
    isPrimary: true,
    getCoalescedEvents: () => coalesced,
    getPredictedEvents: () => [{ ...frame, clientX: frame.clientX + 50, clientY: frame.clientY + 50 }],
  });

  const actGlobals = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const wasActEnvironment = actGlobals.IS_REACT_ACT_ENVIRONMENT;

  actGlobals.IS_REACT_ACT_ENVIRONMENT = false;

  try {
    target.dispatchEvent(event);
  } finally {
    actGlobals.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
  }

  return event;
}

/** Counts the sub-frame samples the board hands the brush (queued for the frame's own point). */
function spyAppendedSamples(canvas: DrawingCanvas): () => number {
  const brush = canvas.freeDrawingBrush as unknown as { queueCoalescedFrame: (points: unknown[], ...rest: unknown[]) => void };

  assert.equal(typeof brush.queueCoalescedFrame, 'function', 'the pen brush has no queueCoalescedFrame');

  const original = brush.queueCoalescedFrame;
  let count = 0;

  brush.queueCoalescedFrame = function queueSpy(points: unknown[], ...rest: unknown[]) {
    count += points.length;

    return original.call(this, points, ...rest);
  };

  return () => count;
}

test('a tip-leaving frame (pressure 0, bit set) is skipped on every channel but never closes the stroke', async () => {
  const harness = await mountWhiteboard();

  try {
    const canvas = openPenTwinStroke(harness);
    const objectsBefore = canvas.getObjects().length;

    fireTouch(canvas.upperCanvasEl, 'touchmove', [{ identifier: 0, clientX: 140, clientY: 120, radiusX: 1, radiusY: 1 }]);
    const appended = spyAppendedSamples(canvas);

    // One frame: two in-contact samples, then the tip is leaving (pressure 0, bit still set — the
    // digitizer's last reports), then the frame's own sample, also pressure 0. No pointerup yet.
    firePenFrame(harness.container, 7, [
      { clientX: 150, clientY: 130, buttons: 1, pressure: 0.45 },
      { clientX: 156, clientY: 134, buttons: 1, pressure: 0.2 },
      { clientX: 170, clientY: 150, buttons: 1, pressure: 0 },
      { clientX: 190, clientY: 170, buttons: 1, pressure: 0 },
    ]);

    assert.equal(appended(), 2, 'tip-leaving samples were appended to the stroke (the tail)');
    assert.equal(canvas._isCurrentlyDrawing, true, 'a pressure-0 reading closed the stroke — the rest of the letter is lost');

    // Fabric's own channels for this same frame carry the same lifted position: both are starved.
    const twin = dispatchWatched('touchmove', () =>
      fireTouch(canvas.upperCanvasEl, 'touchmove', [{ identifier: 0, clientX: 190, clientY: 170, radiusX: 1, radiusY: 1 }]),
    );
    const compat = dispatchWatched('mousemove', () =>
      fireMouse(canvas.upperCanvasEl, 'mousemove', { clientX: 190, clientY: 170, buttons: 1 }),
    );

    assert.equal(twin.reachedDocument, false, "the skipped frame's twin touchmove reached Fabric");
    assert.equal(compat.reachedDocument, false, "the skipped frame's compat mousemove reached Fabric");
    assert.equal(canvas._isCurrentlyDrawing, true);

    // The pressure reading was flaky after all — the pen is still writing. The next in-contact frame
    // flows through both channels again and the stroke continues.
    firePenFrame(harness.container, 7, [{ clientX: 200, clientY: 180, buttons: 1, pressure: 0.3 }]);

    const twinAgain = dispatchWatched('touchmove', () =>
      fireTouch(canvas.upperCanvasEl, 'touchmove', [{ identifier: 0, clientX: 200, clientY: 180, radiusX: 1, radiusY: 1 }]),
    );

    assert.equal(twinAgain.reachedDocument, true, 'an in-contact frame after a skipped one was still starved');
    assert.equal(canvas._isCurrentlyDrawing, true);

    // The real lift: the pen's pointerup, then its twin's touchend with nothing left on the glass.
    firePen(harness.container, 'pointerup', { pointerId: 7, clientX: 200, clientY: 180, buttons: 0 });
    fireTouch(canvas.upperCanvasEl, 'touchend', [{ identifier: 0, clientX: 200, clientY: 180, radiusX: 1, radiusY: 1 }], []);

    assert.equal(canvas._isCurrentlyDrawing, false, 'the real lift did not close the stroke');
    assert.equal(canvas.getObjects().length, objectsBefore + 1, 'the stroke was not kept');
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

test('a coalesced sample whose contact bit is clear is the lift, even at full pressure — the stroke closes there', async () => {
  const harness = await mountWhiteboard();

  try {
    firePen(harness.container, 'pointerdown', { pointerId: 7, clientX: 100, clientY: 100, buttons: 1 });

    const canvas = openFabricStroke(harness);
    const appended = spyAppendedSamples(canvas);

    firePenFrame(harness.container, 7, [
      { clientX: 150, clientY: 130, buttons: 1, pressure: 0.5 },
      { clientX: 160, clientY: 140, buttons: 0, pressure: 0.5 },
      { clientX: 170, clientY: 150, buttons: 1, pressure: 0.5 },
    ]);

    assert.equal(appended(), 1);
    assert.equal(canvas._isCurrentlyDrawing, false);

    firePen(harness.container, 'pointerup', { pointerId: 7, clientX: 170, clientY: 150, buttons: 0 });
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

test('in-contact frames append every coalesced sample and keep the stroke open', async () => {
  const harness = await mountWhiteboard();

  try {
    firePen(harness.container, 'pointerdown', { pointerId: 7, clientX: 100, clientY: 100, buttons: 1 });

    const canvas = openFabricStroke(harness);
    const appended = spyAppendedSamples(canvas);

    firePenFrame(harness.container, 7, [
      { clientX: 150, clientY: 130, buttons: 1, pressure: 0.4 },
      { clientX: 156, clientY: 134, buttons: 1, pressure: 0.5 },
      { clientX: 162, clientY: 138, buttons: 1, pressure: 0.3 },
    ]);

    // The frame's own sample is Fabric's to append (from its twin touchmove); the two before it are ours.
    assert.equal(appended(), 2, 'in-contact coalesced samples were dropped');
    assert.equal(canvas._isCurrentlyDrawing, true, 'an in-contact frame closed the stroke');

    firePen(harness.container, 'pointerup', { pointerId: 7, clientX: 162, clientY: 138, buttons: 0 });
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

// THE "EARTHQUAKE" CROWN (owner's tablet, 2026-11-10). As the S Pen lands, the glass also reads a
// capacitive touch for a few frames — the tip itself or the gripping fingers — about 9–10 px above the
// pen's own position. That stray touch is primary and alone on the glass, so the lone-touch fallback
// (meant for touch-only panels whose pen IS a touch) took it for the drawing contact and appended its
// coalesced samples into the pen's stroke: one sample per frame, 9.5 px up, for the first 2–3 frames.
// The saved stroke (a «B» bowl) had exactly two such samples, both (0, −7) after smoothing, and the
// brush drew them as a zig-zag crown.
/** A touch pointermove whose getCoalescedEvents() replays `samples` (the last one is the frame). */
function fireTouchFrame(target: HTMLElement, pointerId: number, samples: Array<{ clientX: number; clientY: number }>): void {
  const frame = samples[samples.length - 1];
  const event = new window.MouseEvent('pointermove', {
    bubbles: true,
    cancelable: true,
    clientX: frame.clientX,
    clientY: frame.clientY,
    buttons: 1,
  });
  const coalesced = samples.map((s) => ({ ...s, buttons: 1, pressure: 0.5, pointerId, pointerType: 'touch', isPrimary: true }));

  Object.assign(event, {
    pointerId,
    pointerType: 'touch',
    width: 1,
    height: 1,
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
    twist: 0,
    isPrimary: true,
    getCoalescedEvents: () => coalesced,
    getPredictedEvents: () => [],
  });

  const actGlobals = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const wasActEnvironment = actGlobals.IS_REACT_ACT_ENVIRONMENT;

  actGlobals.IS_REACT_ACT_ENVIRONMENT = false;

  try {
    target.dispatchEvent(event);
  } finally {
    actGlobals.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
  }
}

test('a stray touch beside a landing pen never puts its samples into the pen stroke', async () => {
  const harness = await mountWhiteboard();

  try {
    const canvas = openPenTwinStroke(harness);
    const appended = spyAppendedSamples(canvas);
    const pointsBefore = (canvas.freeDrawingBrush as unknown as { _points: unknown[] })._points.length;

    // Without a pointerdown of its own (it landed before the hook saw it, or its down was absorbed)...
    fireTouchFrame(harness.container, 31, [
      { clientX: 101, clientY: 90.5 },
      { clientX: 102, clientY: 90.5 },
    ]);
    // ...and with one: the pen is down, so the touch is ignored — its moves must be too.
    firePointer(harness.container, 'pointerdown', { pointerId: 32, clientX: 103, clientY: 90.5 });
    fireTouchFrame(harness.container, 32, [
      { clientX: 103, clientY: 90.5 },
      { clientX: 104, clientY: 90.5 },
    ]);

    // Fabric's own channel: the stray contact's touchmove (the pen twin is identifier 0) stays out too.
    fireTouch(
      canvas.upperCanvasEl,
      'touchmove',
      [{ identifier: 1, clientX: 104, clientY: 90.5, radiusX: 1, radiusY: 1 }],
      [
        { identifier: 0, clientX: 100, clientY: 100, radiusX: 1, radiusY: 1 },
        { identifier: 1, clientX: 104, clientY: 90.5, radiusX: 1, radiusY: 1 },
      ],
    );

    assert.equal(appended(), 0, "a stray touch's samples were appended to the pen's stroke (the zig-zag crown)");
    assert.equal(
      (canvas.freeDrawingBrush as unknown as { _points: unknown[] })._points.length,
      pointsBefore,
      'the pen stroke grew from a touch',
    );

    // The pen's own frames still go in.
    firePenFrame(harness.container, 7, [
      { clientX: 106, clientY: 100, buttons: 1, pressure: 0.4 },
      { clientX: 108, clientY: 100, buttons: 1, pressure: 0.4 },
    ]);

    assert.equal(appended(), 1, "the pen's own coalesced samples were dropped");

    firePen(harness.container, 'pointerup', { pointerId: 7, clientX: 108, clientY: 100, buttons: 0 });
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

test('a touch-only panel still feeds its lone touch stroke the sub-frame samples', async () => {
  forgetPenDevice();

  const harness = await mountWhiteboard();

  try {
    // Fabric is drawing, no pen was ever seen, and the drawing-pointer ref was never set (the routing
    // edge the fallback exists for): the lone primary touch IS the stroke.
    const canvas = openFabricStroke(harness);
    const appended = spyAppendedSamples(canvas);

    fireTouchFrame(harness.container, 1, [
      { clientX: 150, clientY: 130 },
      { clientX: 156, clientY: 134 },
    ]);

    assert.equal(appended(), 1, "the touch panel's own coalesced samples were dropped");
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

// A digitizer that reports pressure 0 while the tip is landing — or never reports pressure at all —
// must not have its stroke closed on the first frame. Pressure 0 means "lifted" only after this
// contact has reported real pressure.
test('pressure 0 is never a lift: not skipped before pressure was seen, skipped but still open after', async () => {
  const harness = await mountWhiteboard();

  try {
    firePen(harness.container, 'pointerdown', { pointerId: 7, clientX: 100, clientY: 100, buttons: 1, pressure: 0 });

    const canvas = openFabricStroke(harness);

    firePenFrame(harness.container, 7, [
      { clientX: 150, clientY: 130, buttons: 1, pressure: 0 },
      { clientX: 156, clientY: 134, buttons: 1, pressure: 0 },
    ]);

    assert.equal(canvas._isCurrentlyDrawing, true, 'a pressure-less contact was closed on its first frame');

    // ...and once pressure appears, a later 0 is a tip-leaving sample: skipped, but the stroke stays open.
    const appended = spyAppendedSamples(canvas);

    firePenFrame(harness.container, 7, [
      { clientX: 160, clientY: 140, buttons: 1, pressure: 0.5 },
      { clientX: 163, clientY: 142, buttons: 1, pressure: 0 },
      { clientX: 166, clientY: 144, buttons: 1, pressure: 0 },
    ]);

    assert.equal(appended(), 1, 'a pressure-0 sample was appended');
    assert.equal(canvas._isCurrentlyDrawing, true, 'a pressure-0 sample closed the stroke');

    firePen(harness.container, 'pointerup', { pointerId: 7, clientX: 166, clientY: 144, buttons: 0 });
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

// --- Positive twin identification: what the radius heuristic let through ------------------------------

test('a palm with a tip-sized radius landing while the pen writes is starved, far from or near the pen', async () => {
  const harness = await mountWhiteboard();

  try {
    const canvas = openPenTwinStroke(harness);
    const brush = canvas.freeDrawingBrush as unknown as { onMouseDown: (...args: unknown[]) => void };
    let brushRestarted = 0;
    const originalOnMouseDown = brush.onMouseDown;

    brush.onMouseDown = function spy(...args: unknown[]) {
      brushRestarted += 1;

      return originalOnMouseDown.apply(this, args);
    };

    // The palm: its own 'touch' pointerdown (palm-rejected), then a touchstart with the 1px radius the
    // tablet reports for it — 600px from the pen, then 10px from it. Neither is the twin: the pen's own
    // twin touchstart was the one dispatched right after the pen-down.
    firePointer(harness.container, 'pointerdown', { pointerId: 2, clientX: 700, clientY: 600 });

    const far = dispatchWatched('touchstart', () =>
      fireTouch(canvas.upperCanvasEl, 'touchstart', [{ identifier: 1, clientX: 700, clientY: 600, radiusX: 1, radiusY: 1 }]),
    );

    firePointer(harness.container, 'pointerdown', { pointerId: 3, clientX: 110, clientY: 105 });

    const near = dispatchWatched('touchstart', () =>
      fireTouch(canvas.upperCanvasEl, 'touchstart', [{ identifier: 2, clientX: 110, clientY: 105, radiusX: 1, radiusY: 1 }]),
    );

    assert.equal(far.reachedDocument, false, 'a tip-sized palm contact far from the pen reached Fabric');
    assert.equal(near.reachedDocument, false, 'a tip-sized contact next to the pen, after the twin, reached Fabric');
    assert.equal(brushRestarted, 0, "a palm touchstart RESET the pen's open path (the straight-line bug)");
    assert.equal(canvas._isCurrentlyDrawing, true);

    // The palm's moves and lifts are starved for its whole life; the twin's keep flowing.
    const palmMove = dispatchWatched('touchmove', () =>
      fireTouch(canvas.upperCanvasEl, 'touchmove', [{ identifier: 1, clientX: 720, clientY: 610, radiusX: 1, radiusY: 1 }]),
    );
    const twinMove = dispatchWatched('touchmove', () =>
      fireTouch(canvas.upperCanvasEl, 'touchmove', [{ identifier: 0, clientX: 140, clientY: 120, radiusX: 1, radiusY: 1 }]),
    );

    assert.equal(palmMove.reachedDocument, false);
    assert.equal(twinMove.reachedDocument, true, 'the pen twin was starved');

    fireTouch(canvas.upperCanvasEl, 'touchend', [{ identifier: 1, clientX: 720, clientY: 610 }], [{ identifier: 0, clientX: 140, clientY: 120 }]);
    fireTouch(canvas.upperCanvasEl, 'touchend', [{ identifier: 2, clientX: 110, clientY: 105 }], [{ identifier: 0, clientX: 140, clientY: 120 }]);
    firePointer(harness.container, 'pointerup', { pointerId: 2, clientX: 720, clientY: 610 });
    firePointer(harness.container, 'pointerup', { pointerId: 3, clientX: 110, clientY: 105 });
    firePen(harness.container, 'pointerup', { pointerId: 7, clientX: 140, clientY: 120, buttons: 0 });
    fireTouch(canvas.upperCanvasEl, 'touchend', [{ identifier: 0, clientX: 140, clientY: 120, radiusX: 1, radiusY: 1 }], []);

    assert.equal(canvas._isCurrentlyDrawing, false);
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

test('a contact at the pen position but after the twin window is not the twin', async () => {
  const harness = await mountWhiteboard();

  try {
    const canvas = openPenTwinStroke(harness);

    await new Promise((resolve) => setTimeout(resolve, 180));

    // Same spot as the pen-down, radius 0 (the "unknown radius near the pen" the old heuristic passed).
    const late = dispatchWatched('touchstart', () =>
      fireTouch(canvas.upperCanvasEl, 'touchstart', [{ identifier: 1, clientX: 100, clientY: 100, radiusX: 0, radiusY: 0 }]),
    );

    assert.equal(late.reachedDocument, false, 'a late contact at the pen position reached Fabric');
    assert.equal(canvas._isCurrentlyDrawing, true);

    firePen(harness.container, 'pointerup', { pointerId: 7, clientX: 100, clientY: 100, buttons: 0 });
    fireTouch(canvas.upperCanvasEl, 'touchend', [{ identifier: 0, clientX: 100, clientY: 100, radiusX: 1, radiusY: 1 }], []);
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

// The hand resting on the floating toolbar: its touches never pass through the board container, so the
// container guard never sees them — but Fabric moved its touchmove/touchend to the DOCUMENT for the open
// stroke, and a palm touchmove there was appended to the pen's path as a straight line out to the palm.
test('a palm touching OUTSIDE the board container cannot extend or close the open stroke', async () => {
  const harness = await mountWhiteboard();
  const outside = document.createElement('div');

  document.body.append(outside);

  try {
    const canvas = openPenTwinStroke(harness);
    const brush = canvas.freeDrawingBrush as unknown as { onMouseMove: (...args: unknown[]) => void };
    let brushMoves = 0;
    const originalOnMouseMove = brush.onMouseMove;

    brush.onMouseMove = function spy(...args: unknown[]) {
      brushMoves += 1;

      return originalOnMouseMove.apply(this, args);
    };

    const twin = { identifier: 0, clientX: 100, clientY: 100, radiusX: 1, radiusY: 1 };
    const palm = { identifier: 5, clientX: 900, clientY: 700, radiusX: 1, radiusY: 1 };

    fireTouch(outside, 'touchmove', [palm], [twin, palm]);

    assert.equal(brushMoves, 0, "a palm touchmove outside the container was appended to the pen's path");

    fireTouch(outside, 'touchend', [palm], [twin]);

    assert.equal(canvas._isCurrentlyDrawing, true, "a palm touchend outside the container closed the pen's stroke");

    // The pen's own twin keeps flowing — including when the pen drags past the board's edge.
    fireTouch(canvas.upperCanvasEl, 'touchmove', [{ ...twin, clientX: 140, clientY: 120 }]);
    fireTouch(outside, 'touchmove', [{ ...twin, clientX: 150, clientY: 125 }]);

    assert.equal(brushMoves, 2, "the pen twin's moves were starved");

    firePen(harness.container, 'pointerup', { pointerId: 7, clientX: 150, clientY: 125, buttons: 0 });
    fireTouch(outside, 'touchend', [{ ...twin, clientX: 150, clientY: 125 }], []);

    assert.equal(canvas._isCurrentlyDrawing, false, 'the twin lifting with nothing left on the glass did not close the stroke');
  } finally {
    await harness.unmount();
    outside.remove();
    forgetPenDevice();
  }
});

test('a new pen contact never fuses with a stroke whose end was lost — the stale path is committed first', async () => {
  const harness = await mountWhiteboard();

  try {
    const canvas = openPenTwinStroke(harness, { identifier: 0 });
    const objectsBefore = canvas.getObjects().length;

    fireTouch(canvas.upperCanvasEl, 'touchmove', [{ identifier: 0, clientX: 140, clientY: 120, radiusX: 1, radiusY: 1 }]);

    // The lift is lost entirely: no pointerup, no touchend. The pen lands again elsewhere.
    openPenTwinStroke(harness, { pointerId: 8, identifier: 1, clientX: 400, clientY: 300 });

    assert.equal(canvas.getObjects().length, objectsBefore + 1, 'the stale stroke was not committed before the new contact');

    fireTouch(canvas.upperCanvasEl, 'touchmove', [{ identifier: 1, clientX: 430, clientY: 320, radiusX: 1, radiusY: 1 }]);
    firePen(harness.container, 'pointerup', { pointerId: 8, clientX: 430, clientY: 320, buttons: 0 });
    fireTouch(canvas.upperCanvasEl, 'touchend', [{ identifier: 1, clientX: 430, clientY: 320, radiusX: 1, radiusY: 1 }], []);

    assert.equal(canvas._isCurrentlyDrawing, false);
    assert.equal(canvas.getObjects().length, objectsBefore + 2, 'the two contacts did not become two separate strokes');
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

// --- Pan inertia ---------------------------------------------------------------------------------
//
// A pan that lifts while moving keeps sliding (utils/flingPhysics) through the same pending-delta →
// CSS-preview → settle-commit pipeline the live pan uses. The pen landing must end it on the spot: a
// fling under a stroke would drag the ink.

/** A single-finger pan on a pen device: the finger lands, drags past the activation distance at a
 *  steady speed, and lifts WITHOUT pausing. Returns the lift time. */
function dragAndLift(harness: TouchHarness, t0: number): number {
  const steps = 8;
  const stepPx = 12;
  const stepMs = 16;

  firePointer(harness.container, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 100, timeStamp: t0 });

  for (let i = 1; i <= steps; i += 1) {
    firePointer(harness.container, 'pointermove', {
      pointerId: 1,
      clientX: 100 + stepPx * i,
      clientY: 100,
      timeStamp: t0 + stepMs * i,
    });
  }

  // The drag must have become a live single-finger pan before the lift, or there is nothing to fling.
  const midDrag = harness.debug();

  assert.equal(midDrag.touchPanMode, 'single', `the drag never became a pan (override=${midDrag.touchOverride})`);

  const liftT = t0 + stepMs * steps + 4;
  const lift = firePointer(harness.container, 'pointerup', { pointerId: 1, clientX: 100 + stepPx * steps, clientY: 100, timeStamp: liftT });

  assert.equal(lift.timeStamp, liftT, 'the test could not stamp the event clock');

  return liftT;
}

const nextFrames = (n: number) =>
  new Promise<void>((resolve) => {
    const tick = (left: number) => (left <= 0 ? resolve() : window.requestAnimationFrame(() => tick(left - 1)));

    tick(n);
  });

test('a pan that lifts while moving keeps sliding, and the pen landing stops it on the spot', async () => {
  const harness = await mountWhiteboard();

  try {
    latchPenDevice(harness);
    // Past the palm-reject window, so the finger is a deliberate pan and not a rejected palm.
    await new Promise((resolve) => setTimeout(resolve, 450));

    const zoomLayer = harness.container.querySelector('div') as HTMLDivElement;

    assert.equal(harness.debug().fling, false);

    dragAndLift(harness, performance.now());

    assert.equal(harness.debug().fling, true, 'the lift did not start a fling');

    await nextFrames(3);

    assert.equal(harness.debug().fling, true, 'the fling ended within a few frames');
    assert.ok(zoomLayer.style.transform.includes('translate'), 'the fling is not moving the board (no CSS preview)');

    // The pen lands: the slide must end instantly, before anything else happens.
    firePen(harness.container, 'pointerdown', { pointerId: 7, clientX: 300, clientY: 300, buttons: 1 });

    assert.equal(harness.debug().fling, false, 'a pen-down did not cancel the fling');

    firePen(harness.container, 'pointerup', { pointerId: 7, clientX: 300, clientY: 300, buttons: 0 });
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

test('a pan that paused before lifting does not fling', async () => {
  const harness = await mountWhiteboard();

  try {
    latchPenDevice(harness);
    await new Promise((resolve) => setTimeout(resolve, 450));

    const t0 = performance.now();

    firePointer(harness.container, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 100, timeStamp: t0 });

    for (let i = 1; i <= 8; i += 1) {
      firePointer(harness.container, 'pointermove', { pointerId: 1, clientX: 100 + 12 * i, clientY: 100, timeStamp: t0 + 16 * i });
    }

    // Held still for 200ms, then lifted.
    firePointer(harness.container, 'pointerup', { pointerId: 1, clientX: 196, clientY: 100, timeStamp: t0 + 16 * 8 + 200 });

    assert.equal(harness.debug().fling, false, 'a paused finger flung the board');
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

test('a fling is never started under prefers-reduced-motion', async () => {
  const harness = await mountWhiteboard();
  const originalMatchMedia = window.matchMedia;

  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  });

  try {
    latchPenDevice(harness);
    await new Promise((resolve) => setTimeout(resolve, 450));

    dragAndLift(harness, performance.now());

    assert.equal(harness.debug().fling, false, 'the board slid despite prefers-reduced-motion');
  } finally {
    (window as unknown as { matchMedia: unknown }).matchMedia = originalMatchMedia;
    await harness.unmount();
    forgetPenDevice();
  }
});

// --- Pen buttons: the S Pen button, driven by the native edge ------------------------------------------
//
// Device log (Samsung SM-X910, Android 16, WebView Chrome 155): the DOM never sees the S Pen button —
// pen pointer events keep buttons 1 while it is held on the glass. Only MainActivity's native
// BUTTON_STYLUS_PRIMARY (32) edges carry it, with the contact state. Pressing it mid-stroke used to
// switch the tool by committing the drag in progress — and nothing restarted it until a NEW pen-down:
// the eraser sat frozen under a pen that kept moving.

function nativePen(buttonState: number, prevButtonState: number, contact: boolean): void {
  const actGlobals = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const wasActEnvironment = actGlobals.IS_REACT_ACT_ENVIRONMENT;

  actGlobals.IS_REACT_ACT_ENVIRONMENT = false;

  try {
    window.dispatchEvent(
      new window.CustomEvent('wb-native-pen', {
        detail: {
          kind: 'motion',
          action: contact ? 'ACTION_BUTTON_PRESS' : 'ACTION_HOVER_MOVE',
          buttonState,
          prevButtonState,
          toolType: 2,
          prevToolType: 2,
          contact,
          x: 300,
          y: 200,
        },
      }),
    );
  } finally {
    actGlobals.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const brushName = (canvas: FabricCanvas) => canvas.freeDrawingBrush?.constructor.name;

test('S Pen button pressed mid-stroke: the ink is kept and the eraser drag continues from the same contact', async () => {
  // No learning: the built-in S Pen binding (eraser while held on the glass) applies.
  const harness = await mountWhiteboard({ toggleableTool: true, eraserMode: 'partial' });

  try {
    firePen(harness.container, 'pointerdown', { pointerId: 9, clientX: 100, clientY: 100, buttons: 1 });

    const canvas = openFabricStroke(harness);
    const objectsBefore = canvas.getObjects().length;

    firePen(harness.container, 'pointermove', { pointerId: 9, clientX: 150, clientY: 130, buttons: 1 });

    // ▼ native BUTTON_STYLUS_PRIMARY while the tip is on the glass (ACTION_BUTTON_PRESS).
    nativePen(32, 0, true);

    assert.equal(brushName(canvas), 'LiveEraserBrush', 'the held button did not switch to the eraser');
    assert.equal(canvas.getObjects().length, objectsBefore + 1, 'the pen ink drawn before the press was lost');
    assert.equal(harness.activeTool(), 'pen', 'the hold must not rewrite the toolbar tool');

    // The pen keeps moving with buttons 1 (the DOM never shows the button): the eraser drag must be live.
    firePen(harness.container, 'pointermove', { pointerId: 9, clientX: 170, clientY: 140, buttons: 1 });

    assert.equal(canvas._isCurrentlyDrawing, true, 'the eraser froze: no drag after the mid-stroke press');

    // ▲ release: after the short grace the previous nib is back and drawing continues from the contact.
    nativePen(0, 32, true);
    await wait(160);

    assert.notEqual(brushName(canvas), 'LiveEraserBrush', 'releasing the button did not restore the pen');

    firePen(harness.container, 'pointermove', { pointerId: 9, clientX: 190, clientY: 150, buttons: 1 });

    assert.equal(canvas._isCurrentlyDrawing, true, 'the pen did not resume after the release');

    firePen(harness.container, 'pointerup', { pointerId: 9, clientX: 190, clientY: 150, buttons: 0 });
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

test('S Pen button mid-stroke with the OBJECT eraser: the stroke under the moving pen is erased', async () => {
  const harness = await mountWhiteboard({ toggleableTool: true, eraserMode: 'object' });

  try {
    firePen(harness.container, 'pointerdown', { pointerId: 3, clientX: 100, clientY: 100, buttons: 1 });

    const canvas = openFabricStroke(harness);

    fireMouse(document, 'mouseup', { clientX: 140, clientY: 120, buttons: 0 });
    firePen(harness.container, 'pointerup', { pointerId: 3, clientX: 140, clientY: 120, buttons: 0 });

    const target = canvas.getObjects()[canvas.getObjects().length - 1];

    assert.ok(target, 'the first stroke was not committed');

    // A new contact far away, then the button, then the pen slides over the first stroke.
    firePen(harness.container, 'pointerdown', { pointerId: 4, clientX: 400, clientY: 400, buttons: 1 });
    fireMouse(canvas.upperCanvasEl, 'mousedown', { clientX: 400, clientY: 400, buttons: 1 });
    nativePen(32, 0, true);
    firePen(harness.container, 'pointermove', { pointerId: 4, clientX: 120, clientY: 110, buttons: 1 });
    await wait(40);

    assert.equal(canvas.getObjects().includes(target), false, 'the object eraser never started under the pen');
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

test('S Pen button held in the air then put down: eraser from the first touch; a blip and a long-press change nothing', async () => {
  const menus: unknown[] = [];
  const harness = await mountWhiteboard({
    toggleableTool: true,
    eraserMode: 'partial',
    onShortcutQuickMenu: (anchor) => menus.push(anchor),
  });

  try {
    const canvas = harness.canvas();

    nativePen(32, 0, false);
    // The fake hover "contact" the Samsung WebView emits while the button is held in the air.
    firePen(harness.container, 'pointerrawupdate', { pointerId: 5, clientX: 300, clientY: 200, buttons: 1, pressure: 0 });

    assert.notEqual(brushName(canvas), 'LiveEraserBrush', 'a hover press must not switch to the eraser');

    firePen(harness.container, 'pointerdown', { pointerId: 5, clientX: 300, clientY: 200, buttons: 1 });

    assert.equal(brushName(canvas), 'LiveEraserBrush', 'touching down with the button held is not the eraser');

    // A release/press blip at the boundary.
    nativePen(0, 32, true);
    nativePen(32, 0, true);
    await wait(160);

    assert.equal(brushName(canvas), 'LiveEraserBrush', 'a release/press blip ended the hold');

    // The ~600 ms long-press contextmenu of a still pen is suppressed and does nothing else.
    const menu = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });

    Object.assign(menu, { pointerType: 'pen' });
    harness.container.dispatchEvent(menu);

    assert.equal(menu.defaultPrevented, true);
    assert.equal(brushName(canvas), 'LiveEraserBrush');

    firePen(harness.container, 'pointerup', { pointerId: 5, clientX: 300, clientY: 200, buttons: 0 });
    nativePen(0, 32, false);
    await wait(160);

    assert.notEqual(brushName(canvas), 'LiveEraserBrush', 'the release did not restore the nib');
    assert.equal(harness.activeTool(), 'pen');
    assert.deepEqual(menus, [], 'a press that touched down must not also open the hover menu');
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

test('S Pen button in the air (default): a press opens the menu at the pen on RELEASE, however long it was held', async () => {
  const menus: unknown[] = [];
  let colorSwaps = 0;
  const harness = await mountWhiteboard({
    onShortcutQuickMenu: (anchor) => menus.push(anchor),
    onShortcutColorToggle: () => {
      colorSwaps += 1;
    },
  });

  try {
    setStubRect({ left: 0, top: 0, width: 1000, height: 800 });
    firePen(harness.container, 'pointermove', { pointerId: 6, clientX: 500, clientY: 200, buttons: 0 });

    nativePen(32, 0, false);
    assert.equal(menus.length, 0, 'the menu opened on press, not on release');
    nativePen(0, 32, false);

    assert.equal(menus.length, 1, 'a hover press did not open the menu');
    assert.deepEqual(menus[0], { x: 0.5, y: 0.25 }, 'the menu was not placed at the pen');

    // Held well past the old long-press threshold: still the menu on release, and no colour swap.
    nativePen(32, 0, false);
    await wait(520);

    assert.equal(colorSwaps, 0, 'the in-air long press must do nothing by default');
    assert.equal(menus.length, 1);

    nativePen(0, 32, false);

    assert.equal(menus.length, 2, 'a long hover press must still open the menu on release');
    assert.equal(colorSwaps, 0);
  } finally {
    setStubRect({ left: 0, top: 0, width: 0, height: 0 });
    await harness.unmount();
    forgetPenDevice();
  }
});

test('a learned «Ask AI (select)» in-air press asks the board AI for one lasso', async () => {
  window.localStorage.setItem(
    'whiteboard-pen-button-map',
    JSON.stringify({
      version: 2,
      bindings: [
        {
          id: 'ai',
          label: 'AI',
          action: 'erase-hold',
          hoverAction: 'ai-lasso',
          longHoverAction: 'none',
          signatures: ['native:button:32'],
          createdAt: 1,
        },
      ],
    }),
  );

  const commands: unknown[] = [];
  const menus: unknown[] = [];
  const listener = (event: Event) => commands.push((event as CustomEvent<{ command: string }>).detail.command);

  window.addEventListener('wb-board-ai-command', listener);

  // requestBoardAiCommand builds the event with the GLOBAL CustomEvent; in this jsdom harness that is
  // Node's, which jsdom's window refuses. Point it at jsdom's for this test (the WebView has one realm).
  const globals = globalThis as unknown as { CustomEvent: typeof CustomEvent };
  const nodeCustomEvent = globals.CustomEvent;

  globals.CustomEvent = window.CustomEvent;

  const harness = await mountWhiteboard({ onShortcutQuickMenu: (anchor) => menus.push(anchor) });

  try {
    nativePen(32, 0, false);
    nativePen(0, 32, false);

    assert.deepEqual(commands, ['ai-lasso-once']);
    assert.deepEqual(menus, [], 'the learned AI action replaces the menu');
  } finally {
    globals.CustomEvent = nodeCustomEvent;
    window.removeEventListener('wb-board-ai-command', listener);
    await harness.unmount();
    window.localStorage.removeItem('whiteboard-pen-button-map');
    forgetPenDevice();
  }
});

// The quick pen menu is an overlay BESIDE the board, so a pen hovering over it never reaches the
// container's listeners. A button edge there used to go unseen: the per-pointer `buttons` baseline and
// the gesture went stale, and the first frame back over the board read the difference as a phantom edge.
test('a learned pen button pressed over the board and released over the quick menu (outside the container) opens the menu once; a click entirely over the menu toggles it', async () => {
  window.localStorage.setItem(
    'whiteboard-pen-button-map',
    JSON.stringify({
      version: 2,
      bindings: [
        {
          id: 'side',
          label: 'Pen button',
          action: 'erase-hold',
          hoverAction: 'pen-shortcuts',
          longHoverAction: 'none',
          signatures: ['pointer:pen:bit:2'],
          createdAt: 1,
        },
      ],
    }),
  );

  const menus: unknown[] = [];
  const harness = await mountWhiteboard({ onShortcutQuickMenu: (anchor) => menus.push(anchor) });
  // The menu overlay: a sibling of the board, never inside the container.
  const overlay = document.createElement('div');

  document.body.append(overlay);

  try {
    firePen(harness.container, 'pointermove', { pointerId: 9, clientX: 300, clientY: 200, buttons: 0 });
    // Press over the board…
    firePen(harness.container, 'pointermove', { pointerId: 9, clientX: 300, clientY: 200, buttons: 2 });
    assert.equal(menus.length, 0, 'the menu opens on release, not on press');
    // …the pen glides over the menu overlay, and the button is let go there.
    firePen(overlay, 'pointermove', { pointerId: 9, clientX: 320, clientY: 210, buttons: 2 });
    firePen(overlay, 'pointermove', { pointerId: 9, clientX: 322, clientY: 212, buttons: 0 });
    assert.equal(menus.length, 1, 'a release over the menu did not complete the hover press');

    // Back over the board with nothing held: no phantom edge.
    firePen(harness.container, 'pointermove', { pointerId: 9, clientX: 330, clientY: 220, buttons: 0 });
    firePen(harness.container, 'pointerrawupdate', { pointerId: 9, clientX: 331, clientY: 221, buttons: 0 });
    await wait(200);
    assert.equal(menus.length, 1, 'the pen coming back over the board toggled the menu again');

    // A whole click over the open menu (the natural way to dismiss it) toggles it once.
    firePen(overlay, 'pointermove', { pointerId: 9, clientX: 320, clientY: 210, buttons: 2 });
    firePen(overlay, 'pointermove', { pointerId: 9, clientX: 320, clientY: 210, buttons: 0 });
    assert.equal(menus.length, 2, 'a click over the menu was not seen');
    firePen(harness.container, 'pointermove', { pointerId: 9, clientX: 300, clientY: 200, buttons: 0 });
    assert.equal(menus.length, 2);

    // A hover press that starts over the menu and ends over the board still counts exactly once.
    firePen(overlay, 'pointermove', { pointerId: 9, clientX: 320, clientY: 210, buttons: 2 });
    firePen(harness.container, 'pointermove', { pointerId: 9, clientX: 300, clientY: 200, buttons: 2 });
    firePen(harness.container, 'pointermove', { pointerId: 9, clientX: 300, clientY: 200, buttons: 0 });
    assert.equal(menus.length, 3);
  } finally {
    overlay.remove();
    await harness.unmount();
    window.localStorage.removeItem('whiteboard-pen-button-map');
    forgetPenDevice();
  }
});

// Device report (APK 01642d3a): button pressed in the AIR, held, then the pen touches → nothing (no
// ink, no eraser) and the release opened the menu. The WebView reports no contact for a stylus that
// lands with its button held, and its buttonState does not change at the down, so MainActivity sent
// nothing. It now forwards that contact (`kind:'contact'` down / per-frame move / up).
function nativeContact(type: 'down' | 'move' | 'up', x: number, y: number): void {
  const actGlobals = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const wasActEnvironment = actGlobals.IS_REACT_ACT_ENVIRONMENT;

  actGlobals.IS_REACT_ACT_ENVIRONMENT = false;

  try {
    window.dispatchEvent(
      new window.CustomEvent('wb-native-pen', {
        detail: { kind: 'contact', type, x, y, pressure: 0.4, buttonState: 32 },
      }),
    );
  } finally {
    actGlobals.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
  }
}

test('S Pen button held in the air, then the pen lands with NO DOM contact: native samples drive the eraser; no menu', async () => {
  const menus: unknown[] = [];
  const harness = await mountWhiteboard({
    toggleableTool: true,
    eraserMode: 'partial',
    onShortcutQuickMenu: (anchor) => menus.push(anchor),
  });

  try {
    const canvas = harness.canvas() as DrawingCanvas;

    nativePen(32, 0, false);
    // The fake hover "contact" the WebView keeps emitting — no pointerdown ever comes.
    firePen(harness.container, 'pointerrawupdate', { pointerId: 8, clientX: 200, clientY: 200, buttons: 1, pressure: 0 });

    nativeContact('down', 200, 200);

    assert.equal(brushName(canvas), 'LiveEraserBrush', 'the native touch-down did not switch to the eraser');
    assert.equal(canvas._isCurrentlyDrawing, true, 'no erase drag started from the native touch-down');

    nativeContact('move', 230, 210);
    // A hover frame from the WebView meanwhile must not close the native-driven stroke.
    firePen(harness.container, 'pointermove', { pointerId: 8, clientX: 240, clientY: 215, buttons: 0 });
    nativeContact('move', 260, 220);

    assert.equal(canvas._isCurrentlyDrawing, true, 'the native-driven erase stroke was cut short');

    nativeContact('up', 260, 220);

    assert.equal(canvas._isCurrentlyDrawing, false, 'the native touch-up did not end the erase stroke');

    nativePen(0, 32, false);
    await wait(160);

    assert.notEqual(brushName(canvas), 'LiveEraserBrush', 'the button release did not restore the nib');
    assert.equal(harness.activeTool(), 'pen');
    assert.deepEqual(menus, [], 'the release after an erase opened the menu');
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

test('the native-driven OBJECT eraser deletes the stroke the pen slides over', async () => {
  const harness = await mountWhiteboard({ toggleableTool: true, eraserMode: 'object' });

  try {
    firePen(harness.container, 'pointerdown', { pointerId: 3, clientX: 100, clientY: 100, buttons: 1 });

    const canvas = openFabricStroke(harness);

    fireMouse(document, 'mouseup', { clientX: 140, clientY: 120, buttons: 0 });
    firePen(harness.container, 'pointerup', { pointerId: 3, clientX: 140, clientY: 120, buttons: 0 });

    const target = canvas.getObjects()[canvas.getObjects().length - 1];

    assert.ok(target, 'the first stroke was not committed');

    nativePen(32, 0, false);
    nativeContact('down', 400, 400);
    nativeContact('move', 120, 110);
    await wait(40);

    assert.equal(canvas.getObjects().includes(target), false, 'the native-driven object eraser erased nothing');

    nativeContact('up', 120, 110);
    nativePen(0, 32, false);
    await wait(160);
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

// Device report (APK c4738e7c): held in the air → touch → the eraser activates, BUT its cursor circle
// stays frozen where it started and it erases for only a couple of seconds although the pen keeps
// moving. Two causes: (1) the cursor indicator only followed DOM pointer events, and the WebView sends
// none during this contact; (2) the idle stuck-ink backstop (every 700 ms, once no DOM input for
// 1200 ms, pen device, no DOM pen down) committed the "stranded" stroke — native moves never counted as
// input, so ~1.2–1.9 s in, the native-driven erase stroke was closed and later moves drew nothing.
function nativeContactBatch(type: 'down' | 'move' | 'up', points: Array<[number, number]>): void {
  const actGlobals = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const wasActEnvironment = actGlobals.IS_REACT_ACT_ENVIRONMENT;
  const [x, y] = points[points.length - 1];

  actGlobals.IS_REACT_ACT_ENVIRONMENT = false;

  try {
    window.dispatchEvent(
      new window.CustomEvent('wb-native-pen', {
        detail: { kind: 'contact', type, x, y, pts: points.flat(), pressure: 0.4, buttonState: 32 },
      }),
    );
  } finally {
    actGlobals.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
  }
}

test('native-driven erase: 3 s of 60 Hz native moves with NO DOM events keeps erasing the whole path; the cursor follows', async () => {
  const cursor: Array<{ x: number; y: number } | null> = [];
  const harness = await mountWhiteboard({
    toggleableTool: true,
    eraserMode: 'partial',
    onNativePenPoint: (point) => cursor.push(point),
  });

  try {
    const canvas = harness.canvas() as DrawingCanvas;

    // A pen device (the WebView did report the pen while hovering), button held in the air.
    firePen(harness.container, 'pointermove', { pointerId: 8, clientX: 100, clientY: 100, buttons: 0, pressure: 0 });
    nativePen(32, 0, false);
    nativeContactBatch('down', [[100, 100]]);

    assert.equal(brushName(canvas), 'LiveEraserBrush', 'the native touch-down did not switch to the eraser');
    assert.equal(canvas._isCurrentlyDrawing, true, 'no erase drag started from the native touch-down');

    const started = Date.now();
    let x = 100;

    while (Date.now() - started < 3000) {
      await wait(16);
      // One frame = two batched samples (the historical one + the current one).
      nativeContactBatch('move', [
        [x + 1, 100 + (x % 7)],
        [x + 2, 100],
      ]);
      x += 2;

      assert.equal(
        canvas._isCurrentlyDrawing,
        true,
        `the native-driven erase stroke stopped ${Date.now() - started} ms in (pen still moving)`,
      );
    }

    const brush = canvas.freeDrawingBrush as unknown as { _points?: Array<{ x: number; y: number }> };
    const points = brush._points ?? [];
    const last = points[points.length - 1];

    assert.ok(last && Math.abs(last.x - x) < 3, `the erase path did not follow the pen to x=${x} (last ${last?.x})`);
    assert.ok(points.length > 150, `the batched samples were not all applied (${points.length} points)`);

    const lastCursor = cursor[cursor.length - 1];

    assert.ok(cursor.length > 150, `the cursor indicator was not driven by the native samples (${cursor.length})`);
    assert.deepEqual(lastCursor, { x, y: 100 }, 'the cursor indicator did not follow the pen');

    nativeContactBatch('up', [[x, 100]]);

    assert.equal(canvas._isCurrentlyDrawing, false, 'the native touch-up did not end the erase stroke');
    assert.equal(cursor[cursor.length - 1], null, 'the cursor indicator was left up after the native touch-up');

    nativePen(0, 32, false);
    await wait(160);

    assert.notEqual(brushName(canvas), 'LiveEraserBrush', 'the button release did not restore the nib');
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

// Device report (APK 0c625134): erase-hold works, but finishing it leaves a small DOT at the end. The
// owner's log (SM-X910) shows the tail: native contact UP with the button still held, then the WebView
// keeps sending pen pointermove/rawupdate buttons=1 pressure=0 every ~9 ms (no pointerdown), then a native
// HOVER_EXIT with the button released. Two ways that tail left a dot: (1) the cursor indicator was never
// hidden (no DOM pointerleave comes) and, once the nib was restored, kept the eraser's opaque '1' — a
// solid ink-coloured disc where the erase ended; (2) a zero-pressure button-held pen-down from the
// WebView opened a one-sample INK stroke with the restored nib.
function fakeButtonHeldFrame(target: HTMLElement, type: string, x: number, y: number): void {
  firePen(target, type, { pointerId: 266, clientX: x, clientY: y, buttons: 1, pressure: 0 });
}

function nativeHoverExit(): void {
  const actGlobals = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const wasActEnvironment = actGlobals.IS_REACT_ACT_ENVIRONMENT;

  actGlobals.IS_REACT_ACT_ENVIRONMENT = false;

  try {
    window.dispatchEvent(
      new window.CustomEvent('wb-native-pen', {
        detail: {
          kind: 'motion',
          action: 'ACTION_HOVER_EXIT',
          buttonState: 0,
          prevButtonState: 32,
          toolType: 2,
          prevToolType: 2,
          contact: false,
          x: 1877,
          y: 519,
        },
      }),
    );
  } finally {
    actGlobals.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
  }
}

test('erase-hold tail (device log): zero-pressure button-held frames after the native UP leave no dot and no cursor', async () => {
  const cursor: Array<{ x: number; y: number } | null> = [];
  const harness = await mountWhiteboard({
    toggleableTool: true,
    eraserMode: 'partial',
    onNativePenPoint: (point) => cursor.push(point),
  });

  try {
    const canvas = harness.canvas() as DrawingCanvas;
    const reachedBoard: string[] = [];
    const spy = (event: Event) => reachedBoard.push(event.type);

    harness.container.addEventListener('pointermove', spy);
    harness.container.addEventListener('pointerdown', spy);

    firePen(harness.container, 'pointermove', { pointerId: 266, clientX: 300, clientY: 300, buttons: 0, pressure: 0 });
    // HOVER_ENTER with the button held, then the WebView's fake "contact" frames BEFORE the native DOWN.
    nativePen(32, 0, false);
    fakeButtonHeldFrame(harness.container, 'pointerover', 300, 300);
    fakeButtonHeldFrame(harness.container, 'pointermove', 300, 300);
    fakeButtonHeldFrame(harness.container, 'pointerrawupdate', 301, 300);

    nativeContactBatch('down', [[302, 300]]);

    for (let i = 1; i <= 20; i += 1) {
      await wait(8);
      nativeContactBatch('move', [[302 + i * 4, 300 - i]]);
    }

    fakeButtonHeldFrame(harness.container, 'pointerrawupdate', 382, 280);
    fakeButtonHeldFrame(harness.container, 'pointermove', 382, 280);
    nativeContactBatch('up', [[382, 280]]);

    const objectsAfterErase = canvas.getObjects().length;

    reachedBoard.length = 0;

    // The tail: ~9 ms frames, buttons=1 pressure=0, no pointerdown.
    for (let i = 0; i < 7; i += 1) {
      await wait(9);
      fakeButtonHeldFrame(harness.container, 'pointerrawupdate', 384 + i, 278 - i);
      fakeButtonHeldFrame(harness.container, 'pointermove', 384 + i, 278 - i);
    }

    nativeHoverExit();
    await wait(160);

    assert.notEqual(brushName(canvas), 'LiveEraserBrush', 'the button release did not restore the nib');
    assert.deepEqual(reachedBoard, [], 'the zero-pressure button-held frames reached the board');
    assert.equal(cursor[cursor.length - 1], null, 'the cursor indicator was left where the erase ended');

    // The same tail with a zero-pressure pen-DOWN after the nib is back (and its compat mouse events).
    fakeButtonHeldFrame(harness.container, 'pointerdown', 392, 270);
    fireMouse(canvas.upperCanvasEl, 'mousedown', { clientX: 392, clientY: 270, buttons: 1 });
    fireMouse(canvas.upperCanvasEl, 'mousemove', { clientX: 392, clientY: 270, buttons: 1 });
    fireMouse(document, 'mouseup', { clientX: 392, clientY: 270, buttons: 0 });
    firePen(harness.container, 'pointerup', { pointerId: 266, clientX: 392, clientY: 270, buttons: 0, pressure: 0 });

    assert.equal(canvas._isCurrentlyDrawing, false, 'a zero-pressure button-held pen-down opened an ink stroke');
    assert.equal(canvas.getObjects().length, objectsAfterErase, 'the erase-hold tail left a dot on the board');

    // A real hover ends the tail; a genuine stroke afterwards inks as usual.
    firePen(harness.container, 'pointermove', { pointerId: 266, clientX: 200, clientY: 200, buttons: 0, pressure: 0 });
    firePen(harness.container, 'pointerdown', { pointerId: 266, clientX: 200, clientY: 200, buttons: 1, pressure: 0.5 });
    fireMouse(canvas.upperCanvasEl, 'mousedown', { clientX: 200, clientY: 200, buttons: 1 });
    fireMouse(canvas.upperCanvasEl, 'mousemove', { clientX: 240, clientY: 220, buttons: 1 });
    fireMouse(document, 'mouseup', { clientX: 240, clientY: 220, buttons: 0 });
    firePen(harness.container, 'pointerup', { pointerId: 266, clientX: 240, clientY: 220, buttons: 0, pressure: 0 });

    assert.equal(canvas.getObjects().length, objectsAfterErase + 1, 'a genuine stroke after the tail did not ink');

    harness.container.removeEventListener('pointermove', spy);
    harness.container.removeEventListener('pointerdown', spy);
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

// --- The "earthquake" crown, the real cause (device trace, build c57e291, 2026-11-11 01:00 UTC) --------
//
// On the owner's SM-X910 the pen's COALESCED samples (PointerEvent.getCoalescedEvents) sit 9.1 px ABOVE
// the board's own point for the same frame (Fabric's twin touch), dx 0, every frame, tilt setting 0:
//   "pen frame mismatch  twin vs pen dx=0.0 dy=9.1 (scene px), nib offset 0.0,-2.0, tilt setting 0"
// The board takes each frame's own point from the twin and appends the sub-frame samples before it, so
// any frame with 2+ samples put points 9.1 px up between points on the line: the zig-zag crown (saved
// strokes: single points ≈ −8 px after smoothing, in the normal x rhythm). Round 2 (c57e291) took EVERY
// point from the pen's samples instead — the whole line after the first point then sat 9.1 px off the
// tip ("the ink starts away from the tip"). The fix anchors each frame's sub-frame samples to the twin.

const DEVICE_COALESCED_DY = -9.1;

/** A pen frame as the device delivers it: coalesced samples offset by `coalescedDy` from the true
 *  position, then its twin touchmove at the true frame position. */
function deviceFrame(
  harness: TouchHarness,
  canvas: DrawingCanvas,
  pointerId: number,
  positions: Array<{ x: number; y: number }>,
  coalescedDy: number,
): void {
  const frame = positions[positions.length - 1];
  const event = new window.MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: frame.x, clientY: frame.y, buttons: 1 });
  const coalesced = positions.map((p) => ({
    clientX: p.x,
    clientY: p.y + coalescedDy,
    buttons: 1,
    pressure: 0.5,
    pointerId,
    pointerType: 'pen',
    isPrimary: true,
    tiltX: 20,
    tiltY: 30,
  }));

  Object.assign(event, {
    pointerId,
    pointerType: 'pen',
    width: 1,
    height: 1,
    pressure: 0.5,
    tiltX: 20,
    tiltY: 30,
    twist: 0,
    isPrimary: true,
    getCoalescedEvents: () => coalesced,
    getPredictedEvents: () => [],
  });

  const actGlobals = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const wasActEnvironment = actGlobals.IS_REACT_ACT_ENVIRONMENT;

  actGlobals.IS_REACT_ACT_ENVIRONMENT = false;

  try {
    harness.container.dispatchEvent(event);
  } finally {
    actGlobals.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
  }

  fireTouch(canvas.upperCanvasEl, 'touchmove', [{ identifier: 0, clientX: frame.x, clientY: frame.y, radiusX: 1, radiusY: 1 }]);
}

/** Draw a horizontal stroke at client y=200 starting x=100: 6 frames of 3 samples. Returns raw points. */
async function drawDeviceStroke(options: {
  coalescedDy: number;
  zoom?: number;
  panX?: number;
  panY?: number;
  tabletInputSettings?: TabletInputSettings;
}) {
  const harness = await mountWhiteboard(options.tabletInputSettings ? { tabletInputSettings: options.tabletInputSettings } : {});

  try {
    const canvas = harness.canvas() as DrawingCanvas;

    if (options.zoom || options.panX || options.panY) {
      const z = options.zoom ?? 1;

      canvas.setViewportTransform([z, 0, 0, z, options.panX ?? 0, options.panY ?? 0]);
    }

    const brush = canvas.freeDrawingBrush as unknown as { smoothing: boolean; _points: Array<{ x: number; y: number }> };

    brush.smoothing = false;
    // A real pen lands with the same tilt it keeps while writing.
    firePen(harness.container, 'pointerdown', { pointerId: 7, clientX: 100, clientY: 200, buttons: 1, tiltX: 20, tiltY: 30 });
    fireTouch(canvas.upperCanvasEl, 'touchstart', [{ identifier: 0, clientX: 100, clientY: 200, radiusX: 1, radiusY: 1 }]);
    assert.equal(canvas._isCurrentlyDrawing, true, 'the pen twin did not open the stroke');

    let x = 100;

    for (let f = 0; f < 6; f += 1) {
      deviceFrame(harness, canvas, 7, [{ x: x + 2, y: 200 }, { x: x + 4, y: 200 }, { x: x + 6, y: 200 }], options.coalescedDy);
      x += 6;
    }

    const points = brush._points.map((p) => ({ x: p.x, y: p.y }));
    // Where the tip is in scene coords (client y=200; the aim correction is off by default), through
    // the same viewport.
    const vpt = canvas.viewportTransform;
    const tip = { y: (200 - vpt[5]) / vpt[3] };

    firePen(harness.container, 'pointerup', { pointerId: 7, clientX: x, clientY: 200, buttons: 0 });

    return { points, tipY: tip.y, zoom: canvas.getZoom() };
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
}

test('a normal stroke lands exactly under the pointer: no lift, every sample kept (zoom 1, zoom 2, panned)', async () => {
  for (const view of [{}, { zoom: 2 }, { zoom: 2, panX: -137, panY: -61 }]) {
    const { points, tipY } = await drawDeviceStroke({ coalescedDy: 0, ...view });

    assert.ok(points.length >= 12, 'the stroke lost its sub-frame samples');

    // Exact points of the b6cf380 pipeline (smoothing off): pen-down twice, then 3 samples per frame.
    const expectedX = [100, 100];

    for (let x = 102; x <= 136; x += 2) expectedX.push(x);

    const z = view.zoom ?? 1;
    const toScene = (clientX: number) => (clientX - 0 - (view.panX ?? 0)) / z;

    assert.deepEqual(
      points.map((p) => Math.round(p.x * 1000) / 1000),
      expectedX.map((x) => Math.round(toScene(x) * 1000) / 1000),
      `x positions changed (${JSON.stringify(view)})`,
    );

    for (const p of points) {
      assert.ok(Math.abs(p.y - tipY) < 1e-6, `a point left the tip line by ${(p.y - tipY).toFixed(2)} (${JSON.stringify(view)})`);
    }
  }
});

test("the device's offset sub-frame samples never leave the line, and the ink starts and stays at the tip", async () => {
  for (const view of [{}, { zoom: 2 }, { zoom: 2, panX: -137, panY: -61 }]) {
    const { points, tipY, zoom } = await drawDeviceStroke({ coalescedDy: DEVICE_COALESCED_DY, ...view });

    assert.ok(points.length >= 12, 'the stroke lost its sub-frame samples');
    assert.ok(Math.abs(points[0].y - tipY) < 1e-6, 'the stroke does not start at the tip');

    for (const [i, p] of points.entries()) {
      assert.ok(
        Math.abs(p.y - tipY) * zoom < 0.5,
        `point ${i} is ${((p.y - tipY) * zoom).toFixed(1)} screen px off the tip line (${JSON.stringify(view)})`,
      );
    }
  }
});

test('the aim correction, when turned on, moves every point of the stroke by the same amount', async () => {
  const { DEFAULT_TABLET_INPUT_SETTINGS } = await import('@repo/whiteboard-core');

  for (const view of [{}, { zoom: 2 }]) {
    const off = await drawDeviceStroke({ coalescedDy: DEVICE_COALESCED_DY, ...view });
    const on = await drawDeviceStroke({
      coalescedDy: DEVICE_COALESCED_DY,
      ...view,
      tabletInputSettings: { ...DEFAULT_TABLET_INPUT_SETTINGS, penTiltOffset: 3 },
    });

    assert.equal(on.points.length, off.points.length, 'turning the correction on changed which samples were kept');

    const z = view.zoom ?? 1;
    const shiftY = (on.points[on.points.length - 1].y - off.points[off.points.length - 1].y) * z;

    // The lift (2 px) plus the tilt part (3 px along tilt 20,30 → 2.5 px up).
    assert.ok(shiftY < -4, `the correction did not reach the ink (shift ${shiftY.toFixed(2)} px)`);

    for (const [i, p] of on.points.entries()) {
      const dx = (p.x - off.points[i].x) * z;
      const dy = (p.y - off.points[i].y) * z;
      const lastDx = (on.points[on.points.length - 1].x - off.points[off.points.length - 1].x) * z;

      assert.ok(Math.abs(dy - shiftY) < 0.01 && Math.abs(dx - lastDx) < 0.01, `point ${i} got a different correction (${dx.toFixed(2)}, ${dy.toFixed(2)}) ${JSON.stringify(view)}`);
    }
  }
});

test('with the aim correction off, the board never writes an offset into the pen events', async () => {
  const harness = await mountWhiteboard();

  try {
    const seen: number[] = [];

    harness.container.addEventListener('pointermove', (event) => seen.push((event as PointerEvent).clientY));
    openPenTwinStroke(harness, { identifier: 0, clientX: 100, clientY: 200 });
    firePen(harness.container, 'pointermove', { pointerId: 7, clientX: 110, clientY: 200, buttons: 1 });
    firePen(harness.container, 'pointerup', { pointerId: 7, clientX: 110, clientY: 200, buttons: 0 });

    assert.ok(seen.length > 0);
    assert.deepEqual([...new Set(seen)], [200], 'a pen event was moved by a correction that is turned off');
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

// --- With the aim correction off (the default), the earlier spike scenarios cannot move a point ----------
//
// Round 2 chased three ways a point could get a different nib/tilt correction from its neighbours: a hand
// lifting mid-stroke (which cleared the correction for that frame), the S Pen button let go mid-contact
// (the restarted stroke's first point), and a frame reporting no tilt. With the correction off nothing is
// computed at all, so in every one of them each point must equal the pointer exactly.

/** A tilted pen pointermove whose getCoalescedEvents() replays `samples` (the last one is the frame). */
function firePenFrameTilted(target: HTMLElement, pointerId: number, samples: Array<{ clientX: number; clientY: number }>, tiltY = 30): void {
  const frame = samples[samples.length - 1];
  const event = new window.MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: frame.clientX, clientY: frame.clientY, buttons: 1 });
  const coalesced = samples.map((s) => ({ ...s, buttons: 1, pressure: 0.5, pointerId, pointerType: 'pen', isPrimary: true, tiltX: 0, tiltY }));

  Object.assign(event, {
    pointerId,
    pointerType: 'pen',
    width: 1,
    height: 1,
    pressure: 0.5,
    tiltX: 0,
    tiltY,
    twist: 0,
    isPrimary: true,
    getCoalescedEvents: () => coalesced,
    getPredictedEvents: () => [],
  });

  const actGlobals = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const wasActEnvironment = actGlobals.IS_REACT_ACT_ENVIRONMENT;

  actGlobals.IS_REACT_ACT_ENVIRONMENT = false;

  try {
    target.dispatchEvent(event);
  } finally {
    actGlobals.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
  }
}

function strokePoints(canvas: DrawingCanvas): Array<{ x: number; y: number }> {
  return (canvas.freeDrawingBrush as unknown as { _points: Array<{ x: number; y: number }> })._points.map((p) => ({ x: p.x, y: p.y }));
}

/** Pen frames of 3 samples moving right along y=100, each followed by its twin touchmove. */
function writeAlong(harness: TouchHarness, canvas: DrawingCanvas, pointerId: number, fromX: number, frames: number, opts: { between?: (frame: number) => void; tiltY?: (frame: number) => number } = {}): number {
  let x = fromX;

  for (let frame = 0; frame < frames; frame += 1) {
    firePenFrameTilted(
      harness.container,
      pointerId,
      [
        { clientX: x + 2, clientY: 100 },
        { clientX: x + 4, clientY: 100 },
        { clientX: x + 6, clientY: 100 },
      ],
      opts.tiltY?.(frame) ?? 30,
    );
    x += 6;
    opts.between?.(frame);
    fireTouch(canvas.upperCanvasEl, 'touchmove', [{ identifier: 0, clientX: x, clientY: 100, radiusX: 1, radiusY: 1 }]);
  }

  return x;
}

/** Every point is exactly on the pointer's line (y=100), in order, one per sample: 100, 100, 102, 104, … */
function assertExactlyThePointer(points: Array<{ x: number; y: number }>, fromX: number, label: string): void {
  const expected = [fromX, fromX];

  for (let x = fromX + 2; expected.length < points.length; x += 2) expected.push(x);

  // The two pen-down points are split by a hair on purpose (so a tap draws a dot): 0.01 px tolerance.
  const rounded = points.map((p) => ({ x: Math.round(p.x * 100) / 100, y: p.y }));

  assert.deepEqual(rounded, expected.map((x) => ({ x, y: 100 })), `${label}: a point is not where the pointer was`);
}

test('correction off: a hand lifting mid-stroke leaves every point exactly on the pointer', async () => {
  const harness = await mountWhiteboard();

  try {
    const canvas = openPenTwinStroke(harness, { identifier: 0, clientX: 100, clientY: 100 });

    (canvas.freeDrawingBrush as unknown as { smoothing: boolean }).smoothing = false;

    const x = writeAlong(harness, canvas, 7, 100, 6, {
      between: (frame) => {
        if (frame !== 2) return;
        firePointer(harness.container, 'pointerdown', { pointerId: 40, clientX: 300, clientY: 300 });
        firePointer(harness.container, 'pointerup', { pointerId: 40, clientX: 300, clientY: 300 });
      },
    });

    assertExactlyThePointer(strokePoints(canvas), 100, 'hand lifted mid-stroke');
    firePen(harness.container, 'pointerup', { pointerId: 7, clientX: x, clientY: 100, buttons: 0 });
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

test('correction off: a pen frame that reports no tilt leaves every point exactly on the pointer', async () => {
  const harness = await mountWhiteboard();

  try {
    const canvas = openPenTwinStroke(harness, { identifier: 0, clientX: 100, clientY: 100 });

    (canvas.freeDrawingBrush as unknown as { smoothing: boolean }).smoothing = false;

    const x = writeAlong(harness, canvas, 7, 100, 6, { tiltY: (frame) => (frame % 2 ? 0.5 : 30) });

    assertExactlyThePointer(strokePoints(canvas), 100, 'tilt dropped out on alternate frames');
    firePen(harness.container, 'pointerup', { pointerId: 7, clientX: x, clientY: 100, buttons: 0 });
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

test('correction off: the S Pen button let go mid-contact restarts the stroke exactly on the pointer', async () => {
  const harness = await mountWhiteboard({ toggleableTool: true, eraserMode: 'partial' });

  try {
    const canvas = openPenTwinStroke(harness, { pointerId: 9, identifier: 0, clientX: 100, clientY: 100 });

    firePenFrameTilted(harness.container, 9, [{ clientX: 104, clientY: 100 }, { clientX: 108, clientY: 100 }]);
    nativePen(32, 0, true); // ▼ erase while on the glass
    firePenFrameTilted(harness.container, 9, [{ clientX: 112, clientY: 100 }, { clientX: 116, clientY: 100 }]);
    nativePen(0, 32, true); // ▲ let go, keep writing
    await wait(160);

    (canvas.freeDrawingBrush as unknown as { smoothing: boolean }).smoothing = false;

    const x = writeAlong(harness, canvas, 9, 116, 4);
    const points = strokePoints(canvas);

    assert.notEqual(brushName(canvas), 'LiveEraserBrush');

    // Known, and not a spike: the restarted stroke is seeded at the first frame's own sample, then that
    // frame's earlier sub-frame samples follow — a step back of at most one frame ALONG the line.
    for (const [i, p] of points.entries()) {
      assert.equal(p.y, 100, `point ${i} of the restarted stroke is off the pointer's line: y ${p.y}`);
      assert.ok(p.x >= 116 && p.x <= x, `point ${i} is outside the written span: x ${p.x}`);
    }

    firePen(harness.container, 'pointerup', { pointerId: 9, clientX: x, clientY: 100, buttons: 0 });
  } finally {
    await harness.unmount();
    forgetPenDevice();
  }
});

test('touch panel opt-in: with the aim correction turned on, a drawing contact gets the 2 px lift', async () => {
  const { DEFAULT_TABLET_INPUT_SETTINGS } = await import('@repo/whiteboard-core');

  setStubRect({ left: 10, top: 10, width: 400, height: 300 });

  // A touch-only panel (ViewSonic): no pen ever seen, the finger/IR pen draws. The slider only has to be
  // non-zero; a touch contact reports no tilt, so what it switches on is the fixed 2 px lift.
  const harness = await mountWhiteboard({ tabletInputSettings: { ...DEFAULT_TABLET_INPUT_SETTINGS, penTiltOffset: 1 } });

  try {
    const canvas = harness.canvas();

    canvas.enableRetinaScaling = false;
    canvas.setDimensions({ width: 400, height: 300 });
    firePointer(harness.container, 'pointerdown', { pointerId: 11, clientX: 150, clientY: 120 });

    const point = canvas.getScenePoint({ clientX: 150, clientY: 120, target: null } as unknown as MouseEvent);

    assert.deepEqual({ x: Math.round(point.x), y: Math.round(point.y) }, { x: 140, y: 108 }, 'the opt-in lift did not reach the ink');
    firePointer(harness.container, 'pointerup', { pointerId: 11, clientX: 150, clientY: 120 });
  } finally {
    setStubRect({ left: 0, top: 0, width: 0, height: 0 });
    await harness.unmount();
  }
});
