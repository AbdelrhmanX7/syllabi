/**
 * Auto-colour handwriting («Auto colour») — the fixed contract between the board and its hosts.
 *
 * The board groups fresh pen strokes into words and lines, asks the host's {@link InkRecognizer} what each
 * word says (ML Kit Digital Ink on the Study Android app), classifies the line with rules + layout cues,
 * optionally escalates ambiguous lines to an {@link InkCloudClassifier}, and recolours default-ink words.
 */

/** One pen sample: scene x/y and a timestamp in ms (relative to the word's first sample). */
export interface InkPoint {
  x: number;
  y: number;
  t: number;
}

export interface InkRecognizeRequest {
  /** Strokes in writing order. */
  strokes: InkPoint[][];
  /** ML Kit language tags to run, e.g. ['en']. */
  langs: string[];
  /** Last ≤ 20 characters written before this word (ML Kit `preContext`). */
  preContext?: string;
  /** The line's area in the strokes' units (ML Kit `WritingArea`). */
  writingArea?: { width: number; height: number };
}

export interface InkCandidate {
  text: string;
  /** Lower = better, when the model scores at all (ML Kit text models do not). */
  score?: number;
  /** The language tag of the model that produced it. */
  lang: string;
}

export interface InkRecognizer {
  /** Engine id for telemetry and the debug overlay ('mlkit'). */
  id: string;
  available(): Promise<boolean>;
  /** Download / warm the models; `fraction` 0–1. */
  prepare?(onProgress?: (fraction: number) => void): Promise<void>;
  /** Every model's candidates, best first per language. */
  recognize(req: InkRecognizeRequest, signal?: AbortSignal): Promise<InkCandidate[]>;
}

export type InkClass = 'heading' | 'term' | 'definition' | 'formula' | 'example' | 'keypoint' | 'plain';

/** One line sent to the cloud classifier: recognised text + layout cues, never ink. */
export interface InkLineForCloud {
  text: string;
  lang: string;
  cues: { relHeight: number; underlined: boolean; boxed: boolean; indent: number; lineIndex: number };
}

export interface InkCloudClassifier {
  /** One answer per line, same order. */
  classify(lines: InkLineForCloud[], signal?: AbortSignal): Promise<Array<{ cls: InkClass; confidence: number }>>;
}
