/**
 * Board AI — the shapes the editor and a host-supplied transport agree on.
 *
 * The editor never talks to a backend itself. The host app hands it a {@link BoardAiService}
 * (`boardAi` prop) the same way it hands over `fileBridge` / `nativePdf`; the app ships two
 * implementations behind one interface — the public guest chat surface (`/ai/uploads` +
 * `/ai/chat`) that exists today, and the dedicated `/whiteboard/ai/*` teacher endpoints. Every
 * method yields the SAME frame stream, so the panel cannot tell which one answered.
 */
import type { GlyphBank } from './glyphBank/types';
import type { GlyphBankRemoteSnapshot } from './glyphBank/store';

/** One renderable unit of an AI answer. The teacher endpoints send these in a `result` frame; the
 *  guest transport derives them from the markdown answer (see `markdownBlocks.ts`). */
export type BoardAiBlock = (
  | { type: 'heading'; text: string; level?: number }
  | { type: 'paragraph'; text: string }
  | { type: 'math'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; header: string[]; rows: string[][] }
  | {
      type: 'question';
      stem: string;
      choices?: string[];
      answerIndex?: number;
      /** A written (non-MCQ) model answer. */
      answer?: string;
      explanation?: string;
    }
  | { type: 'diagram'; mermaid: string }
  /** A generated or fetched picture (the «Illustration» kind). `labels`: drawn on the board by us. */
  | { type: 'image'; src: string; alt?: string; labels?: BoardAiImageLabel[] }
) & {
  /**
   * What the block MEANS, from a `> [!success]` / `:::wrong` callout in the answer (`tones.ts`): the
   * panel tints it, the board writes it in the matching ink. Absent = a plain block.
   */
  tone?: BoardAiTone;
};

/** Semantic colour of an answer part: correct (green), a mistake (red), caution (amber), a tip (blue). */
export type BoardAiTone = 'success' | 'wrong' | 'warning' | 'info';

/** /image `labels[]`: the picture is text-free; each label is an editable board text + leader line. */
export interface BoardAiImageLabel {
  text: string;
  /** Where the label text sits, 0..1 of the picture. */
  anchor: { x: number; y: number };
  /** The point it names, 0..1 — a thin leader line goes there. */
  target?: { x: number; y: number };
  /** Text height as a fraction of the picture height. */
  sizeRel?: number;
}

export type BoardAiAskAction = 'solve' | 'explain' | 'check_answer' | 'custom' | 'concept_map';

export type BoardAiGenerateKind = 'questions' | 'summary' | 'table' | 'diagram' | 'free' | 'concept_map' | 'image';

/** A study scope the guest catalog understands (`phase` = grade id, `subject` = catalog slug). */
export interface BoardAiScope {
  grade?: string;
  subject?: string;
  /** Reply language. The board always sends `en`. */
  lang?: 'en';
}

export interface BoardAiAskRequest extends BoardAiScope {
  image: Blob;
  action: BoardAiAskAction;
  prompt?: string;
}

export interface BoardAiGenerateRequest extends BoardAiScope {
  prompt: string;
  kind: Exclude<BoardAiGenerateKind, 'concept_map' | 'image'>;
  /** A snapshot of the current page, when the teacher ticked «Use the current page». */
  contextImage?: Blob;
}

export interface BoardAiAnalyzeRequest extends BoardAiScope {
  image: Blob;
}

/** «Make a similar page»: the page snapshot + what to change. */
export interface RemakePageRequest extends BoardAiScope {
  image: Blob;
  /** Pixel size of `image` — the layout's font sizes come back in these px. */
  imageSize: { width: number; height: number };
  mode: 'similar' | 'edit_question' | 'fix_errors';
  /** `edit_question`: the question number to change. */
  target?: string;
  /** `edit_question`: how to change it. */
  instruction?: string;
  /** Ink line boxes measured from `image` (normalised, top → bottom) — positions for a text-only model. */
  lines?: NormalizedBox[];
  /** Image-edit path only: «Normal» / «High». */
  quality?: 'normal' | 'high';
  /** A re-ask: what the previous answer got wrong (e.g. a question that changed type). */
  correction?: string;
  /**
   * Image-edit path: `overlay` (default) = the server erases the question text and returns a layout
   * the board writes in IBM Plex Sans + KaTeX; `baked` = the model draws the text into the picture.
   */
  textMode?: 'overlay' | 'baked';
}

/** One text block of an overlay remake: where it goes on the text-free page and how it looks. */
export interface RemakeOverlayBlock {
  /** Question number — blocks sharing it are grouped. */
  n?: string;
  /** BE #564 emits `question` and `choice`; the other kinds are reserved (not sent yet). */
  kind: 'question' | 'choice' | 'instruction' | 'header_text' | 'answer_line';
  /** The erased area the text replaces (0..1 of the page). */
  bbox: NormalizedBox;
  /** Text, math inline as `$…$`, display as `$$…$$`. A question's printed number is NOT in it. */
  text: string;
  /** `question`: the number as printed (e.g. «1)»), drawn before the text; absent/null = none printed. */
  number?: string | null;
  /** `choice`: its label (e.g. «a»), drawn as «label) text». */
  label?: string;
  style?: {
    /** Font size as a fraction of the page height. */
    fontSizeRel?: number;
    weight?: 'regular' | 'medium' | 'semibold' | 'bold';
    align?: 'right' | 'center' | 'left';
    color?: string;
  };
  /** `question`: its choices — the fallback when a `choice` block for one of them is missing. */
  choices?: Array<{ label: string; text: string }>;
  choiceLayout?: 'inline' | 'stacked';
}

/** The image-edit remake: the same page, redrawn with new questions (BE /whiteboard/ai/remake-page). */
export interface RemakeImageResult {
  /** `https://…` or a `data:` URL; null with `noChanges` (fix_errors found nothing to fix). */
  src: string | null;
  width: number;
  height: number;
  newQuestions: Array<{ n: string; text: string; choices?: string[]; answer?: string; type?: 'written' | 'mcq' | 'true_false' | 'fill_blank' }>;
  /** `mismatches` are ready-to-show lines. */
  verification: { ok: boolean; mismatches: string[] };
  noChanges?: boolean;
  attempts?: number;
  model?: string;
  /** Overlay mode: `src` is the page with its question text erased; the board writes these blocks. */
  layout?: { blocks: RemakeOverlayBlock[]; width?: number; height?: number };
  /** BE #564 result extras (overlay mode). */
  textMode?: 'overlay' | 'baked';
  eraseMethod?: string;
  timings?: Record<string, number>;
}

/** The partial `questions` frame of /remake-page. */
export type RemakePartialQuestions = Pick<RemakeImageResult, 'newQuestions' | 'layout'>;

/** The partial `image` frame of /remake-page. */
export type RemakePartialPicture = { src: string; width: number; height: number };

// ---------------------------------------------------------------------------
// Page analysis («Check this page»)
// ---------------------------------------------------------------------------

export type PageAnalysisVerdict = 'correct' | 'wrong' | 'unclear' | 'no_answer';

export type PageAnalysisType = 'questions' | 'explanation' | 'solution' | 'blank' | 'other';

/** Normalised to the analysed image: every value in 0..1, origin top-left. */
export interface NormalizedBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageAnalysisQuestion {
  n: string;
  text: string;
  choices?: string[];
  /** 0..1 — the teacher endpoint only says «wrong» at ≥ 0.8. */
  confidence?: number;
  bbox?: NormalizedBox;
  givenAnswer?: string;
  givenAnswerBbox?: NormalizedBox;
  correctAnswer?: string;
  verdict: PageAnalysisVerdict;
  reason?: string;
}

export interface PageAnalysis {
  pageType: PageAnalysisType;
  questions: PageAnalysisQuestion[];
}

// ---------------------------------------------------------------------------
// Concept maps («Concept map»)
// ---------------------------------------------------------------------------

export type ConceptMapDirection = 'rtl' | 'ltr' | 'tb' | 'radial';

/** `diamond` only comes from flowchart decisions (`{…}` in mermaid); maps use the other four. */
export type ConceptNodeShape = 'ellipse' | 'rect' | 'rounded' | 'none' | 'diamond';

export type ConceptEdgeArrow = 'none' | 'end' | 'both';

export interface ConceptMapNode {
  id: string;
  text: string;
  bbox?: NormalizedBox;
  shape?: ConceptNodeShape;
  color?: string;
  level?: number;
}

export interface ConceptMapEdge {
  from: string;
  to: string;
  label?: string;
  arrow?: ConceptEdgeArrow;
}

/** How the teacher draws maps — learned from one of theirs, reused for every generated map. */
export interface ConceptMapStyle {
  direction: ConceptMapDirection;
  shape: ConceptNodeShape;
  nodeColors: string[];
  edgeColor: string;
  strokeWidth: number;
  arrow: ConceptEdgeArrow;
  font: 'handwriting' | 'typed';
  /** Gap between levels / siblings, in on-screen px at 100% zoom. */
  spacing?: number;
}

export interface ConceptMap {
  /** Node bboxes are a ready layout (server-generated map): place them, don't re-layout. */
  serverLayout?: boolean;
  title?: string;
  direction?: ConceptMapDirection;
  nodes: ConceptMapNode[];
  edges: ConceptMapEdge[];
  style?: Partial<ConceptMapStyle>;
}

export type ConceptMapFixOp =
  | { op: 'rename_node'; id: string; text: string }
  | { op: 'add_node'; id: string; text: string; parent?: string; label?: string }
  | { op: 'remove_node'; id: string }
  | { op: 'add_edge'; from: string; to: string; label?: string }
  | { op: 'remove_edge'; from: string; to: string }
  | { op: 'relabel_edge'; from: string; to: string; label: string };

export interface ConceptMapSuggestion {
  /** Spelling fixes: the label as the teacher drew it (the fix replaces it on the copy). */
  drawn?: string;
  id: string;
  kind: 'fact' | 'missing_concept' | 'link' | 'spelling' | 'other';
  message: string;
  fix?: ConceptMapFixOp;
}

export interface ConceptMapAnalysis {
  map: ConceptMap;
  suggestions: ConceptMapSuggestion[];
  /** false = the facts were NOT checked (the server could not verify them) — never read as «no mistakes». */
  checked?: boolean;
}

export interface ConceptMapAnalyzeRequest extends BoardAiScope {
  image: Blob;
}

export interface ConceptMapGenerateRequest extends BoardAiScope {
  topic: string;
  style?: ConceptMapStyle;
  contextImage?: Blob;
}

// ---------------------------------------------------------------------------
// «Map my terms»: handwritten terms → a concept map drawn in the owner's own ink
// ---------------------------------------------------------------------------

/** One ink cluster (a written term or word) the client found in the selection. */
export interface TermCluster {
  /** `c1`…`cn`, reading order. */
  id: string;
  /** Where it sits in `image` (0..1, origin top-left). */
  bbox: NormalizedBox;
}

export interface TermsMapRequest extends BoardAiScope {
  /** The selection rendered on white — the model reads the terms off it. */
  image: Blob;
  /** Pixel size of `image`. */
  imageSize: { width: number; height: number };
  clusters: TermCluster[];
  /** Optional: what the map is about («the water cycle»). */
  hint?: string;
}

/** A node made of the owner's own ink: one or more clusters (a term written as several word blobs). */
export interface TermsMapNode {
  id: string;
  /** What the model read — never drawn (the ink is), kept for the record. */
  text: string;
  clusterIds: string[];
  level: number;
  /** The central idea — drawn with a second ring. */
  focus?: boolean;
}

export interface TermsMapEdge {
  from: string;
  to: string;
  /** The linking phrase, written by hand on the arrow. Empty = a bare arrow. */
  label: string;
}

/** A concept the model says is missing — written in the handwriting font, dashed outline. */
export interface TermsMapExtra {
  id: string;
  text: string;
  level: number;
}

export type TermsMapDirection = 'TB' | 'LR' | 'radial';

/**
 * The structure only — the model never sends a coordinate. The client owns geometry: it lays the map
 * out, copies the clusters' strokes into the nodes and draws the outlines/arrows in the owner's hand.
 */
export interface TermsMapResult {
  title?: string;
  direction: TermsMapDirection;
  nodes: TermsMapNode[];
  edges: TermsMapEdge[];
  extra: TermsMapExtra[];
}

// ---------------------------------------------------------------------------
// «Explain on my page»: the AI marks the student's own page up with a pen and a pointer
// ---------------------------------------------------------------------------

/** A point on the page sheet, 0..1 of its width / height, origin top-left (the {@link NormalizedBox} convention). */
export interface PagePoint {
  x: number;
  y: number;
}

/** Existing ink is named by its cluster id (snapped to the real box); anything else is a box of the page. */
export type PenActionTarget = { clusterId: string } | { box: NormalizedBox };

export type PenActionEnd = PagePoint | { clusterId: string };

export type PenStrokeTool = 'pen' | 'marker' | 'highlighter';

/** One step of the model's plan (POST /study/ai/board-actions contract). The client owns the geometry. */
export type PenAction =
  /** `at` as the contract says; a model that aims the pointer at a cluster instead sends `target`. */
  | { type: 'point_at'; at?: PagePoint; target?: PenActionTarget; note?: string }
  | { type: 'circle'; target: PenActionTarget }
  | { type: 'underline'; target: PenActionTarget }
  | { type: 'arrow'; from: PenActionEnd; to: PenActionEnd; label?: string }
  /** `size`: letter height as a fraction of the page height. `near` (v2): beside that region — the client finds the gap. */
  | { type: 'write'; text: string; at?: PagePoint; near?: PenActionTarget; size?: number }
  /** v2: ✓ / ✗ / ! beside a region, with a few words (the fix or the reason). */
  | { type: 'mark'; target: PenActionTarget; verdict: PenMarkVerdict; label?: string }
  | { type: 'pen_stroke'; points: PagePoint[]; tool?: PenStrokeTool };

export interface PenPlanRequest extends BoardAiScope {
  /** The visible page sheet as a JPEG (long edge ≤ 1600 px). */
  image: Blob;
  imageSize: { width: number; height: number };
  /** The page's ink clusters, boxes normalised to `image`. */
  clusters: TermCluster[];
  /** What the student asked; empty = «explain what matters on this page». */
  question?: string;
  /** The question written by hand (the buddy's pad) — sent beside the page; needs `v: 2`. */
  questionImage?: Blob;
  /**
   * 2 = this caller draws `mark` actions and `write … near`, and reads `verdict`: the tutor then
   * checks the student's work first. Absent = the first contract (the step checker relies on it).
   */
  v?: 2;
}

export type PenMarkVerdict = 'correct' | 'wrong' | 'warning';
/** Was the student's own work right? */
export type PenPageVerdict = 'correct' | 'wrong' | 'partly';

export interface PenPlanResult {
  actions: PenAction[];
  /** v2: the verdict on the student's work; absent when there was nothing to check. */
  verdict?: PenPageVerdict;
  /** v2: a handwritten question as the tutor read it. */
  heard?: string;
  /** v2, «solve it»: the worked solution, one step per item. */
  steps?: string[];
  /** A short spoken answer, shown in the panel next to the board. */
  say?: string;
}

// ---------------------------------------------------------------------------
// Routing + images (optional, backend-only)
// ---------------------------------------------------------------------------

/** What a lassoed region is (BE /whiteboard/ai/classify). `answer` / `text` are the pre-contract names. */
export type BoardAiRegionKind =
  | 'question'
  | 'answer_to_check'
  | 'concept_map'
  | 'diagram'
  | 'handwriting_text'
  | 'table'
  | 'figure'
  | 'other'
  | 'answer'
  | 'text';

export type BoardAiSuggestedAction = 'solve' | 'explain' | 'check_answer' | 'concept_map_analyze' | 'concept_map_fix' | 'none';

export interface BoardAiClassification {
  kind: BoardAiRegionKind;
  confidence: number;
  subject?: string;
  hasHandwriting?: boolean;
  suggestedAction?: BoardAiSuggestedAction;
}

export type BoardAiClassifyContext = 'lasso' | 'selection' | 'page';

export type BoardAiImageStyle = 'illustration' | 'diagram' | 'photo' | 'sketch' | 'cartoon' | 'map';
export type BoardAiImageSize = 'square' | 'landscape' | 'portrait' | 'wide';

/** BE /whiteboard/ai/image (#561). The picture has NO text by design — labels go on the board. */
export interface BoardAiImageRequest extends BoardAiScope {
  /** ≤ 1000 characters. */
  prompt: string;
  style?: BoardAiImageStyle;
  size?: BoardAiImageSize;
  quality?: 'low' | 'medium' | 'high';
  /** Ask for `labels[]` (text-free picture + label positions the board writes itself). */
  labels?: boolean;
}

export const IMAGE_PROMPT_MAX = 1000;

// ---------------------------------------------------------------------------
// Stream frames
// ---------------------------------------------------------------------------

export type BoardAiStreamEvent =
  | { type: 'status'; data: string }
  | { type: 'thinking'; data?: string }
  /** What the vision model read off the picture (teacher /ask), once, before the answer. */
  | { type: 'transcript'; data: string }
  | { type: 'text'; data: string }
  | { type: 'result'; data: { blocks: BoardAiBlock[] } }
  | { type: 'analysis'; data: PageAnalysis }
  | { type: 'concept_map'; data: ConceptMapAnalysis }
  /** «Map my terms»: the structure for the selected ink clusters (the client draws it). */
  | { type: 'terms_map'; data: unknown }
  /** A page layout (`pageLayout.ts` shape) — the editable remake result. */
  | { type: 'layout'; data: unknown }
  /** The image-edit remake result. */
  | { type: 'remake_image'; data: RemakeImageResult }
  /**
   * Streamed early (optional): the new questions + overlay layout, before the picture exists. The
   * final `remake_image` still follows; a transport that never sends these keeps working unchanged.
   */
  | { type: 'remake_questions'; data: RemakePartialQuestions }
  /** Streamed early (optional): the text-free picture, before verification finishes. */
  | { type: 'remake_picture'; data: RemakePartialPicture }
  | { type: 'error'; data: string }
  | { type: 'done' };

export interface BoardAiCapabilities {
  classify: boolean;
  generateImage: boolean;
  /** The image-edit page remake endpoint answers. Absent = false. */
  remakeImage?: boolean;
}

/**
 * The transport. Every streaming method yields frames until `done` or `error`; a failure before the
 * first byte throws an `Error` whose `message` is user-facing. Aborting `signal` ends the
 * iteration quietly.
 */
export interface BoardAiService {
  /** Which surface answers — shown as a small hint, never a gate. */
  readonly label?: string;
  ask(request: BoardAiAskRequest, signal: AbortSignal): AsyncIterable<BoardAiStreamEvent>;
  generate(request: BoardAiGenerateRequest, signal: AbortSignal): AsyncIterable<BoardAiStreamEvent>;
  analyzePage(request: BoardAiAnalyzeRequest, signal: AbortSignal): AsyncIterable<BoardAiStreamEvent>;
  analyzeConceptMap(request: ConceptMapAnalyzeRequest, signal: AbortSignal): AsyncIterable<BoardAiStreamEvent>;
  generateConceptMap(request: ConceptMapGenerateRequest, signal: AbortSignal): AsyncIterable<BoardAiStreamEvent>;
  /** «Editable copy»: the page as a layout, rebuilt as editable objects. */
  remakePage(request: RemakePageRequest, signal: AbortSignal): AsyncIterable<BoardAiStreamEvent>;
  /**
   * «Exact same look»: the page redrawn by an image-edit model, only the questions changed. Optional
   * and server-only; `capabilities().remakeImage` says whether the endpoint is live.
   */
  remakePageImage?(request: RemakePageRequest, signal: AbortSignal): AsyncIterable<BoardAiStreamEvent>;
  /**
   * Optional «Map my terms»: the selected handwritten terms (as ink clusters) → a map structure,
   * ending in a `terms_map` frame. Absent = no «Map my terms» on the selection bar.
   */
  mapTerms?(request: TermsMapRequest, signal: AbortSignal): AsyncIterable<BoardAiStreamEvent>;
  /**
   * Optional «Explain on my page»: the page picture + its ink clusters + a question → a one-shot plan
   * of pen and pointer actions the board executes itself. Absent = no «Explain on my page» entry. A
   * server that does not have the route yet throws an `Error` whose `code` is `'NOT_AVAILABLE'`.
   */
  penPlan?(request: PenPlanRequest, signal: AbortSignal): Promise<PenPlanResult>;
  /** Optional cheap router: what is in this region? Used ONLY to preselect/reorder actions. */
  classify?(image: Blob, signal: AbortSignal, context?: BoardAiClassifyContext, lang?: 'en'): Promise<BoardAiClassification | null>;
  /** Optional picture generator; the «Illustration» kind is hidden while this is absent/unsupported. */
  generateImage?(request: BoardAiImageRequest, signal: AbortSignal): AsyncIterable<BoardAiStreamEvent>;
  /** Live capability flags for the optional methods (they may exist but be unsupported by the server). */
  capabilities?(): BoardAiCapabilities;
  /** Grade → subjects the guest catalog offers; absent = no subject chips. */
  getCatalog?(): Promise<BoardAiCatalog | null>;
  /**
   * «My handwriting»: the owner's glyph bank on the server (GET /study/handwriting/bank). Null = no bank yet;
   * throws `GlyphBankUnavailableError` when the route does not exist (the sheet then stays local-only).
   * Both absent = no remote at all.
   */
  getGlyphBank?(signal?: AbortSignal): Promise<GlyphBankRemoteSnapshot | null>;
  /** PUT with `version` as the expected server version; throws `GlyphBankConflictError` on a mismatch. */
  putGlyphBank?(bank: GlyphBank, version: number, signal?: AbortSignal): Promise<GlyphBankRemoteSnapshot>;
}

export interface BoardAiCatalog {
  phases: Array<{ id: string; label: string; subjects: Array<{ id: string; label: string }> }>;
}

/** A scene-space rectangle (Fabric canvas coordinates, before the viewport transform). */
export interface SceneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ScenePoint {
  x: number;
  y: number;
}
