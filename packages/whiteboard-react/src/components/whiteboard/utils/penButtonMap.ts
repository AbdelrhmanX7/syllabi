// i18n-ignore-file: copy for the pen-button settings page, not the editor chrome
import type { BoardAiCommand } from '../ai/commands';

/**
 * Learned pen-button map: the teacher presses a physical pen button on the «Pen buttons» page, the page
 * sees which raw signal(s) that press produced (a PointerEvent `buttons` bit, a contextmenu, a key, or a
 * NATIVE Android MotionEvent button/tool edge forwarded by MainActivity), and the teacher names it and
 * picks what it does. The board then looks every incoming signal up in the same map.
 *
 * Why learn instead of hard-coding: the old path assumed a ThinkPad pen (barrel = `buttons` bit 2,
 * second button = bit 32) and was OFF by default. A Samsung S Pen / Huawei M-Pen surfaces its button
 * however the vendor WebView decides — or not at all to the page, only to the activity — so the only
 * reliable mapping is the one measured on the device itself.
 *
 * Everything here is pure (no DOM) so it is unit-tested; storage takes a Storage-like argument.
 */

export const PEN_BUTTON_MAP_STORAGE_KEY = 'whiteboard-pen-button-map';
/** Fired on `window` after the map is written, so a mounted board picks the change up immediately. */
export const PEN_BUTTON_MAP_CHANGED_EVENT = 'wb-pen-button-map-changed';
/** CustomEvent MainActivity dispatches on `window` for native stylus button/tool/key EDGES. */
export const NATIVE_PEN_EVENT = 'wb-native-pen';

export type PenButtonAction =
  | 'erase-hold'
  | 'eraser-toggle'
  | 'color-toggle'
  | 'pen-shortcuts'
  | 'undo'
  | 'ai-lasso'
  /** Hold in the air to talk to the study buddy (long hover only): listens while held. */
  | 'buddy-talk'
  | 'none';

/** Where the pen was when the button went down — each context has its own action (see penButtonGesture). */
export type PenButtonContext = 'hover' | 'long-hover' | 'contact';

/** Actions for a button held while the pen TOUCHES (the binding's `action`). */
export const PEN_BUTTON_ACTIONS: ReadonlyArray<{ action: PenButtonAction; label: string; hint: string }> = [
  {
    action: 'erase-hold',
    label: 'Erase while held',
    hint: 'Hold the button and erase; release it to get the pen back. If the button never reports its release, each press toggles between pen and eraser.',
  },
  { action: 'color-toggle', label: 'Swap colour', hint: 'Each press swaps between your two chosen colours.' },
  { action: 'pen-shortcuts', label: 'Open pen shortcuts', hint: 'Opens the quick colour and width menu.' },
  { action: 'undo', label: 'Undo', hint: 'Each press undoes one step.' },
  { action: 'none', label: 'Nothing', hint: 'Recognises the button and ignores it (handy for silencing the system menu).' },
];

/** Actions for a short press while HOVERING (fires on release). */
export const PEN_BUTTON_HOVER_ACTIONS: ReadonlyArray<{ action: PenButtonAction; label: string; hint: string }> = [
  { action: 'pen-shortcuts', label: 'Open pen shortcuts', hint: 'Opens the quick menu at the pen.' },
  { action: 'color-toggle', label: 'Swap to secondary colour', hint: 'Swaps between your two chosen colours.' },
  { action: 'undo', label: 'Undo', hint: 'Undoes one step.' },
  { action: 'eraser-toggle', label: 'Eraser (toggle)', hint: 'Toggles between pen and eraser.' },
  { action: 'ai-lasso', label: 'Ask AI (select)', hint: 'Circle part of the board with the pen and ask the AI about it.' },
  { action: 'none', label: 'Nothing', hint: 'Does nothing.' },
];

/** Actions for a long press while HOVERING (fires at the threshold, with a short vibration). */
export const PEN_BUTTON_LONG_HOVER_ACTIONS: ReadonlyArray<{ action: PenButtonAction; label: string; hint: string }> = [
  { action: 'buddy-talk', label: 'Talk to the buddy', hint: 'Hold the button in the air and ask your question; let go and the buddy answers on your page.' },
  { action: 'color-toggle', label: 'Swap to secondary colour', hint: 'Swaps between your two chosen colours.' },
  { action: 'pen-shortcuts', label: 'Open pen shortcuts', hint: 'Opens the quick menu at the pen.' },
  { action: 'undo', label: 'Undo', hint: 'Undoes one step.' },
  { action: 'eraser-toggle', label: 'Eraser (toggle)', hint: 'Toggles between pen and eraser.' },
  { action: 'ai-lasso', label: 'Ask AI (select)', hint: 'Circle part of the board with the pen and ask the AI about it.' },
  { action: 'none', label: 'Nothing', hint: 'Does nothing.' },
];

export const DEFAULT_PEN_BUTTON_HOVER_ACTION: PenButtonAction = 'pen-shortcuts';
// Owner decision 2026-10-04: no in-air long-press action by default — a press in the air opens the
// menu on release however long it was held. Still configurable on the «Pen buttons» page.
// Owner decision 2026-11-11: a long hold in the air talks to the study buddy (a quick press still
// opens the menu). Maps saved as version 2 move their untouched «Nothing» over (see normalize).
export const DEFAULT_PEN_BUTTON_LONG_HOVER_ACTION: PenButtonAction = 'buddy-talk';
export const DEFAULT_PEN_BUTTON_CONTACT_ACTION: PenButtonAction = 'erase-hold';

const ACTION_SET = new Set<PenButtonAction>([...PEN_BUTTON_ACTIONS.map((entry) => entry.action), 'eraser-toggle']);
// The in-air slots also accept the AI lasso; the while-touching slot does not (the pen is writing).
const AIR_ACTION_SET = new Set<PenButtonAction>([...Array.from(ACTION_SET), 'ai-lasso']);
// Only the long in-air hold can talk to the buddy (it needs a release to stop listening).
const LONG_AIR_ACTION_SET = new Set<PenButtonAction>([...Array.from(AIR_ACTION_SET), 'buddy-talk']);

/** The board AI command a pen-button action fires, if any (see ai/commands). */
export function boardAiCommandForPenAction(action: PenButtonAction): BoardAiCommand | null {
  return action === 'ai-lasso' ? 'ai-lasso-once' : null;
}

export interface PenButtonBinding {
  id: string;
  label: string;
  /** What the button does while the pen TOUCHES the glass. */
  action: PenButtonAction;
  /** Short press while hovering (fires on release). */
  hoverAction: PenButtonAction;
  /** Long press while hovering (fires at {@link PEN_BUTTON_LONG_PRESS_MS}). */
  longHoverAction: PenButtonAction;
  /** Every raw signature one physical press produced (e.g. a `buttons` bit AND its native twin). */
  signatures: string[];
  createdAt: number;
}

export interface PenButtonMap {
  /** 3 since the in-air long hold defaulted to «Talk to the buddy» (see normalizePenButtonMap). */
  version: 3;
  bindings: PenButtonBinding[];
}

export const EMPTY_PEN_BUTTON_MAP: PenButtonMap = { version: 3, bindings: [] };

/** Android MotionEvent constants (mirrored so the log reads in words). */
export const ANDROID_BUTTON_NAMES: Record<number, string> = {
  1: 'BUTTON_PRIMARY',
  2: 'BUTTON_SECONDARY',
  4: 'BUTTON_TERTIARY',
  8: 'BUTTON_BACK',
  16: 'BUTTON_FORWARD',
  32: 'BUTTON_STYLUS_PRIMARY',
  64: 'BUTTON_STYLUS_SECONDARY',
};

export const ANDROID_TOOL_NAMES: Record<number, string> = {
  0: 'UNKNOWN',
  1: 'FINGER',
  2: 'STYLUS',
  3: 'MOUSE',
  4: 'ERASER',
  5: 'PALM',
};

const ANDROID_TOOL_TYPE_ERASER = 4;

/** W3C `buttons` bits by name, for the log. Bit 1 is tip contact and is never a "button". */
export const POINTER_BUTTON_BIT_NAMES: Record<number, string> = {
  2: 'secondary/barrel (2)',
  4: 'middle (4)',
  8: 'back (8)',
  16: 'forward (16)',
  32: 'eraser (32)',
};

export type PenSignal =
  | {
      source: 'pointer';
      pointerType: string;
      buttons: number;
      prevButtons: number;
    }
  | { source: 'contextmenu'; pointerType: string }
  | { source: 'mouse'; type: 'mousedown' | 'mouseup'; button: number }
  | { source: 'key'; type: 'keydown' | 'keyup'; key: string; code: string; keyCode: number; repeat: boolean }
  | {
      source: 'native';
      kind: 'motion';
      buttonState: number;
      prevButtonState: number;
      toolType: number;
      prevToolType: number;
      /** Native: the stylus was ON the glass when the state changed (MainActivity). */
      contact?: boolean;
    }
  | { source: 'native'; kind: 'key'; type: 'down' | 'up'; keyCode: number; repeat: number };

export interface PenSignalEdge {
  signature: string;
  phase: 'press' | 'release';
  /** False for one-shot signals that never report a release. */
  hasRelease: boolean;
  /** Known only for native edges: whether the pen was touching when it happened. */
  contact?: boolean;
}

const MAX_BUTTON_BIT = 1 << 10;

function bitEdges(prefix: string, previous: number, current: number, skipBits: number): PenSignalEdge[] {
  const edges: PenSignalEdge[] = [];

  if (previous === current) return edges;

  for (let bit = 1; bit <= MAX_BUTTON_BIT; bit <<= 1) {
    if (bit & skipBits) continue;

    const was = (previous & bit) !== 0;
    const is = (current & bit) !== 0;

    if (was === is) continue;

    edges.push({ signature: `${prefix}${bit}`, phase: is ? 'press' : 'release', hasRelease: true });
  }

  return edges;
}

/** Turn one raw signal into the button edges it carries (possibly none). */
export function detectPenSignalEdges(signal: PenSignal): PenSignalEdge[] {
  switch (signal.source) {
    case 'pointer':
      // Bit 1 is the tip touching the glass — that is writing, not a button.
      return bitEdges(`pointer:${signal.pointerType || 'unknown'}:bit:`, signal.prevButtons, signal.buttons, 1);
    case 'contextmenu':
      // Never a button: on the Samsung WebView (SM-X910, Chrome 155) contextmenu is the ~600 ms
      // long-press of a still pen, and the S Pen button never produces one. Learning it bound every
      // long-press to the button's action. Logged by the page, never turned into an edge.
      return [];
    case 'mouse':
      if (signal.button === 0) return [];

      return [
        {
          signature: `mouse:button:${signal.button}`,
          phase: signal.type === 'mousedown' ? 'press' : 'release',
          hasRelease: true,
        },
      ];
    case 'key': {
      if (signal.type === 'keydown' && signal.repeat) return [];

      const id = signal.code || signal.key || String(signal.keyCode);

      return [{ signature: `key:${id}`, phase: signal.type === 'keydown' ? 'press' : 'release', hasRelease: true }];
    }
    case 'native': {
      if (signal.kind === 'key') {
        if (signal.type === 'down' && signal.repeat > 0) return [];

        return [
          {
            signature: `native:key:${signal.keyCode}`,
            phase: signal.type === 'down' ? 'press' : 'release',
            hasRelease: true,
          },
        ];
      }

      // BUTTON_PRIMARY (1) is a mouse/tip primary — not a pen button.
      const edges = bitEdges('native:button:', signal.prevButtonState, signal.buttonState, 1).map((edge) =>
        typeof signal.contact === 'boolean' ? { ...edge, contact: signal.contact } : edge,
      );
      const wasEraser = signal.prevToolType === ANDROID_TOOL_TYPE_ERASER;
      const isEraser = signal.toolType === ANDROID_TOOL_TYPE_ERASER;

      if (wasEraser !== isEraser) {
        edges.push({ signature: 'native:tool:eraser', phase: isEraser ? 'press' : 'release', hasRelease: true });
      }

      return edges;
    }
    default:
      return [];
  }
}

/** Human-readable description of a signature, for the page. */
export function describeSignature(signature: string): string {
  const parts = signature.split(':');

  if (parts[0] === 'pointer') {
    const type = parts[1] === 'pen' ? 'pen' : parts[1] === 'touch' ? 'touch' : parts[1] === 'mouse' ? 'mouse' : parts[1];
    const bit = Number(parts[3]);

    return `buttons bit ${POINTER_BUTTON_BIT_NAMES[bit] ?? bit} — ${type}`;
  }

  if (parts[0] === 'contextmenu') return `context menu (contextmenu) — ${parts[1]}`;

  if (parts[0] === 'mouse') return `mouse button ${parts[2]}`;

  if (parts[0] === 'key') return `key ${parts.slice(1).join(':')}`;

  if (parts[0] === 'native') {
    if (parts[1] === 'button') {
      const bit = Number(parts[2]);

      return `Android ${ANDROID_BUTTON_NAMES[bit] ?? `button ${bit}`}`;
    }

    if (parts[1] === 'tool') return 'Android eraser tip (TOOL_TYPE_ERASER)';

    if (parts[1] === 'key') return `Android key ${parts[2]}`;
  }

  return signature;
}

// ---------------------------------------------------------------------------------------------
// Map lookup + normalisation + storage
// ---------------------------------------------------------------------------------------------

export function findBindingForSignature(map: PenButtonMap, signature: string): PenButtonBinding | null {
  for (const binding of map.bindings) {
    if (binding.signatures.includes(signature)) return binding;
  }

  return null;
}

export function hasPenButtonBindings(map: PenButtonMap): boolean {
  return map.bindings.length > 0;
}

/** The Android stylus primary button (S Pen / M-Pen), as MainActivity forwards it. */
export const NATIVE_STYLUS_PRIMARY_SIGNATURE = 'native:button:32';
export const DEFAULT_STYLUS_BINDING_ID = 'default-stylus-primary';

/**
 * The map the board acts on: the learned one, plus — unless a learned binding already owns it — a
 * built-in binding for the native stylus primary button, so an S Pen works without visiting the page.
 */
export function withDefaultStylusBinding(map: PenButtonMap): PenButtonMap {
  if (findBindingForSignature(map, NATIVE_STYLUS_PRIMARY_SIGNATURE)) return map;

  return {
    version: 3,
    bindings: [
      ...map.bindings,
      {
        id: DEFAULT_STYLUS_BINDING_ID,
        label: 'Pen button',
        action: DEFAULT_PEN_BUTTON_CONTACT_ACTION,
        hoverAction: DEFAULT_PEN_BUTTON_HOVER_ACTION,
        longHoverAction: DEFAULT_PEN_BUTTON_LONG_HOVER_ACTION,
        signatures: [NATIVE_STYLUS_PRIMARY_SIGNATURE],
        createdAt: 0,
      },
    ],
  };
}

export function normalizePenButtonMap(value: unknown): PenButtonMap {
  if (!value || typeof value !== 'object') return EMPTY_PEN_BUTTON_MAP;

  const rawBindings = (value as { bindings?: unknown }).bindings;

  if (!Array.isArray(rawBindings)) return EMPTY_PEN_BUTTON_MAP;

  const seen = new Set<string>();
  const bindings: PenButtonBinding[] = [];
  // Maps written before version 2 carry the OLD default long press (colour swap) that nobody chose:
  // it becomes «Nothing». A version-2 map keeps whatever the teacher picked.
  const version = (value as { version?: unknown }).version;
  const isLegacyMap = version !== 2 && version !== 3;
  // Version 2 carried «Nothing» as the in-air long hold by default; it becomes «Talk to the buddy».
  const isV2Map = version === 2;

  for (const raw of rawBindings) {
    if (!raw || typeof raw !== 'object') continue;

    const entry = raw as Partial<PenButtonBinding>;
    const action = ACTION_SET.has(entry.action as PenButtonAction) ? (entry.action as PenButtonAction) : null;
    // A signature belongs to ONE binding: the first one wins, later duplicates are dropped.
    const signatures: string[] = [];

    if (action && Array.isArray(entry.signatures)) {
      for (const sig of entry.signatures) {
        // contextmenu signatures were learned by the first build; they are long-presses (see above).
        if (typeof sig !== 'string' || sig.length === 0 || seen.has(sig) || sig.startsWith('contextmenu:')) continue;

        seen.add(sig);
        signatures.push(sig);
      }
    }

    if (!action || signatures.length === 0) continue;

    bindings.push({
      id: typeof entry.id === 'string' && entry.id ? entry.id : `b${bindings.length}-${signatures[0]}`,
      label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim().slice(0, 60) : 'Pen button',
      action,
      hoverAction: AIR_ACTION_SET.has(entry.hoverAction as PenButtonAction)
        ? (entry.hoverAction as PenButtonAction)
        : DEFAULT_PEN_BUTTON_HOVER_ACTION,
      longHoverAction:
        LONG_AIR_ACTION_SET.has(entry.longHoverAction as PenButtonAction) &&
        !(isLegacyMap && entry.longHoverAction === 'color-toggle') &&
        !(isV2Map && entry.longHoverAction === 'none')
          ? (entry.longHoverAction as PenButtonAction)
          : DEFAULT_PEN_BUTTON_LONG_HOVER_ACTION,
      signatures,
      createdAt: typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt) ? entry.createdAt : 0,
    });
  }

  return { version: 3, bindings };
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function readPenButtonMap(storage: StorageLike | null | undefined): PenButtonMap {
  if (!storage) return EMPTY_PEN_BUTTON_MAP;

  try {
    const raw = storage.getItem(PEN_BUTTON_MAP_STORAGE_KEY);

    return raw ? normalizePenButtonMap(JSON.parse(raw)) : EMPTY_PEN_BUTTON_MAP;
  } catch {
    return EMPTY_PEN_BUTTON_MAP;
  }
}

export function writePenButtonMap(storage: StorageLike | null | undefined, map: PenButtonMap): void {
  if (!storage) return;

  try {
    if (map.bindings.length === 0) {
      storage.removeItem(PEN_BUTTON_MAP_STORAGE_KEY);
    } else {
      storage.setItem(PEN_BUTTON_MAP_STORAGE_KEY, JSON.stringify(normalizePenButtonMap(map)));
    }
  } catch {
    // Storage can throw in locked-down contexts; the board simply keeps its previous map.
  }
}

export function addPenButtonBinding(
  map: PenButtonMap,
  input: {
    id: string;
    label: string;
    action: PenButtonAction;
    hoverAction?: PenButtonAction;
    longHoverAction?: PenButtonAction;
    signatures: string[];
    createdAt: number;
  },
): PenButtonMap {
  const incoming = new Set(input.signatures);
  // Re-learning a button replaces it: strip its signatures from every older binding first.
  const kept = map.bindings
    .map((binding) => ({ ...binding, signatures: binding.signatures.filter((sig) => !incoming.has(sig)) }))
    .filter((binding) => binding.signatures.length > 0);

  return normalizePenButtonMap({ version: 3, bindings: [...kept, { ...input, signatures: Array.from(incoming) }] });
}

export function removePenButtonBinding(map: PenButtonMap, bindingId: string): PenButtonMap {
  return { version: 3, bindings: map.bindings.filter((binding) => binding.id !== bindingId) };
}

export function updatePenButtonBinding(
  map: PenButtonMap,
  bindingId: string,
  patch: Partial<Pick<PenButtonBinding, 'label' | 'action' | 'hoverAction' | 'longHoverAction'>>,
): PenButtonMap {
  return normalizePenButtonMap({
    version: 3,
    bindings: map.bindings.map((binding) => (binding.id === bindingId ? { ...binding, ...patch } : binding)),
  });
}

// ---------------------------------------------------------------------------------------------
// Learning: group the signatures one physical press produced
// ---------------------------------------------------------------------------------------------

/** One physical press can raise several signals within a few ms (bit 2 + contextmenu + native twin). */
export const PEN_CAPTURE_WINDOW_MS = 400;

export interface PenButtonCapture {
  /** New (unbound) press signatures, in arrival order. */
  signatures: string[];
  /** Press signatures from the same burst that are ALREADY bound (for "this is known as …"). */
  knownBindingIds: string[];
  firstAt: number;
}

/**
 * Fold press edges into the capture in progress. A press after the window starts a new capture.
 * Returns the (possibly new) capture, or the previous one unchanged when nothing new arrived.
 */
export function mergePenButtonCapture(
  capture: PenButtonCapture | null,
  map: PenButtonMap,
  edges: PenSignalEdge[],
  now: number,
  windowMs = PEN_CAPTURE_WINDOW_MS,
): PenButtonCapture | null {
  const presses = edges.filter((edge) => edge.phase === 'press');

  if (presses.length === 0) return capture;

  const base: PenButtonCapture =
    capture && now - capture.firstAt <= windowMs
      ? { signatures: [...capture.signatures], knownBindingIds: [...capture.knownBindingIds], firstAt: capture.firstAt }
      : { signatures: [], knownBindingIds: [], firstAt: now };

  for (const edge of presses) {
    const binding = findBindingForSignature(map, edge.signature);

    if (binding) {
      if (!base.knownBindingIds.includes(binding.id)) base.knownBindingIds.push(binding.id);
    } else if (!base.signatures.includes(edge.signature)) {
      base.signatures.push(edge.signature);
    }
  }

  return base;
}

// ---------------------------------------------------------------------------------------------
// Runtime dispatch (consumed by the board)
// ---------------------------------------------------------------------------------------------

/** A one-shot signal this soon after the same binding fired is the same press seen twice. */
export const PEN_BUTTON_DEDUPE_MS = 250;
/**
 * A press from ANOTHER signature of the same binding this soon after its last press is that press
 * seen again, even when the first signature has already released. The learning page groups the signals
 * of one physical press with the same window ({@link PEN_CAPTURE_WINDOW_MS}); the dispatcher used to
 * absorb a twin only while the first signature was still held, so a twin that trailed a quick click
 * (a key the system raises after the release, a DOM bit the WebView reports late) counted as a second
 * click — and a toggled action (the pen menu) opened, closed, and opened again.
 */
export const PEN_BUTTON_TWIN_WINDOW_MS = PEN_CAPTURE_WINDOW_MS;

export interface PenButtonDispatchEvent {
  binding: PenButtonBinding;
  kind: 'press' | 'release';
  /** True when the press will be followed by a release (hold semantics are possible). */
  momentary: boolean;
  /** The pressing edge's contact state, when the signal knows it (native). */
  contact?: boolean;
}

export interface PenButtonDispatcher {
  handle(map: PenButtonMap, edges: PenSignalEdge[], now: number): PenButtonDispatchEvent[];
  /**
   * Release any held `pointer:<type>:bit:N` signature whose bit is clear in `buttons` — a pen that
   * left hover range with its button held comes back under a NEW pointerId, so its falling edge is
   * never seen as a diff. Cheap no-op when nothing is held.
   */
  reconcilePointer(map: PenButtonMap, pointerType: string, buttons: number, now: number): PenButtonDispatchEvent[];
  hasHeld(): boolean;
  reset(): void;
}

export function createPenButtonDispatcher(): PenButtonDispatcher {
  // binding id -> signatures currently down for it
  const held = new Map<string, Set<string>>();
  const lastFiredAt = new Map<string, number>();
  // binding id -> the signatures that took part in its latest press (the first one + its twins), so a
  // twin arriving after the press already released is still recognised as that press.
  const lastPress = new Map<string, { at: number; signatures: Set<string> }>();

  const releaseSignature = (map: PenButtonMap, signature: string, out: PenButtonDispatchEvent[]) => {
    const binding = findBindingForSignature(map, signature);

    if (!binding) return;

    const down = held.get(binding.id);

    if (!down || !down.delete(signature)) return;

    if (down.size === 0) {
      held.delete(binding.id);
      out.push({ binding, kind: 'release', momentary: true });
    }
  };

  return {
    handle(map, edges, now) {
      const out: PenButtonDispatchEvent[] = [];

      for (const edge of edges) {
        if (edge.phase === 'release') {
          releaseSignature(map, edge.signature, out);
          continue;
        }

        const binding = findBindingForSignature(map, edge.signature);

        if (!binding) continue;

        const down = held.get(binding.id);
        const previous = lastPress.get(binding.id);

        if (down) {
          if (down.has(edge.signature)) {
            // The same signature pressed again: its release was lost. Close the old press first.
            held.delete(binding.id);
            out.push({ binding, kind: 'release', momentary: true });
          } else {
            // A twin signal of a press already in progress (e.g. native + DOM): absorb it.
            if (edge.hasRelease) down.add(edge.signature);

            previous?.signatures.add(edge.signature);
            continue;
          }
        } else if (
          edge.hasRelease &&
          previous !== undefined &&
          now - previous.at < PEN_BUTTON_TWIN_WINDOW_MS &&
          !previous.signatures.has(edge.signature)
        ) {
          // A late twin: another signature of the SAME physical press, arriving after the first one
          // already released. Not a new click — its own release finds nothing held and is silent too.
          previous.signatures.add(edge.signature);
          continue;
        }

        const last = lastFiredAt.get(binding.id);

        if (!edge.hasRelease && last !== undefined && now - last < PEN_BUTTON_DEDUPE_MS) continue;

        lastFiredAt.set(binding.id, now);

        if (edge.hasRelease) {
          held.set(binding.id, new Set([edge.signature]));
          lastPress.set(binding.id, { at: now, signatures: new Set([edge.signature]) });
        }

        out.push(
          typeof edge.contact === 'boolean'
            ? { binding, kind: 'press', momentary: edge.hasRelease, contact: edge.contact }
            : { binding, kind: 'press', momentary: edge.hasRelease },
        );
      }

      return out;
    },
    reconcilePointer(map, pointerType, buttons, now) {
      void now;
      const out: PenButtonDispatchEvent[] = [];

      if (held.size === 0) return out;

      const prefix = `pointer:${pointerType || 'unknown'}:bit:`;

      for (const signatures of Array.from(held.values())) {
        for (const signature of Array.from(signatures)) {
          if (!signature.startsWith(prefix)) continue;

          const bit = Number(signature.slice(prefix.length));

          if ((buttons & bit) === 0) releaseSignature(map, signature, out);
        }
      }

      return out;
    },
    hasHeld() {
      return held.size > 0;
    },
    reset() {
      held.clear();
      lastFiredAt.clear();
      lastPress.clear();
    },
  };
}
