/**
 * Auto-colour handwriting — the board-internal model (the host contract is `types.ts`).
 */
import type { InkClass, InkCloudClassifier, InkPoint, InkRecognizer } from './types';

export const INK_CLASSES: readonly InkClass[] = ['heading', 'term', 'definition', 'formula', 'example', 'keypoint', 'plain'];

/** The script a note is read in; the recognizer runs the English model. */
export type InkScript = 'en';

/** Geometric writing direction of a run of strokes (stroke travel + successive starts). */
export type InkDirection = 'rtl' | 'ltr';

/** Scene-space axis-aligned box. */
export interface InkBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Not handwriting: a line drawn under words, or a frame drawn round them. Kept out of word grouping and
 * recognition; used as a layout cue and recoloured with the words it marks.
 */
export type InkDecorationKind = 'underline' | 'box';

/** A committed stroke as the grouper sees it. */
export interface InkStrokeInput {
  id: string;
  points: InkPoint[];
  box: InkBox;
  /** ms of pen-down / pen-up on the same clock as the points. */
  startedAt: number;
  endedAt: number;
}

/** Layout cues of one word, measured from ink alone. */
export interface InkGroupCues {
  underlined: boolean;
  boxed: boolean;
  /** Ends with a colon drawn as two stacked dots (geometry, whatever the recogniser read). */
  colon: boolean;
  /** Shaped like a list bullet at the line start (a short dash / arrow at mid-height). */
  bullet: boolean;
}

/** Layout cues of one line. */
export interface InkLineCues {
  /** The line's ink height ÷ the page's median line height. */
  sizeRatio: number;
  groupCount: number;
  /** One decoration underlines (almost) the whole line. */
  fullyUnderlined: boolean;
  dir: InkDirection | null;
}

/** One classified word. */
export interface InkClassification {
  cls: InkClass;
  /** 0–1. Below {@link AMBIGUOUS_CONFIDENCE} a `plain` word may go to the cloud. */
  conf: number;
  src: 'rules' | 'geo' | 'cloud' | 'memory' | 'none';
  /** Colour unit within the line: words sharing it always get one class, applied in one frame. */
  seg?: number;
}

export const AMBIGUOUS_CONFIDENCE = 0.6;

/** Colour per class; null/absent = leave the ink as written. */
export type InkPalette = Partial<Record<InkClass, string | null>>;

/**
 * The student's own corrections, remembered per phrase («the law» → formula). Consulted before the rules;
 * stays on the device (the host decides where).
 */
export interface InkPhraseMemory {
  lookup(text: string): InkClass | null;
  remember(text: string, cls: InkClass): void;
}

/** What the editor's `autoColor` prop carries. */
export interface AutoColorConfig {
  recognizer: InkRecognizer;
  cloud?: InkCloudClassifier | null;
  palette?: InkPalette;
  memory?: InkPhraseMemory | null;
  /** Show the per-word debug list. (Telemetry carries the recognised text either way: the owner's notes.) */
  debug?: boolean;
  /** The ink colour auto-colour may change (the pen's default). Default `#000000`. */
  defaultInk?: string;
  /** Pen-lift pause before a word is classified. Default 800 ms. */
  pauseMs?: number;
  /** Cross-fade length; 0 = instant. Default 180 ms. */
  fadeMs?: number;
  /** `live` (default): colour each line after a pen-lift pause. `manual`: only «colour the page». */
  mode?: 'live' | 'manual';
}

/** One row of the debug overlay. */
export interface InkDebugEntry {
  groupId: string;
  text: string;
  script: InkScript | null;
  cls: InkClass;
  conf: number;
  src: InkClassification['src'];
  engine: string;
  recognizeMs: number;
  totalMs: number;
}
