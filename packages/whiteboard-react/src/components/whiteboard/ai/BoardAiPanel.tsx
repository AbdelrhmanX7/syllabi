import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  Check,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Copy,
  CopyPlus,
  GripHorizontal,
  LassoSelect,
  ListCollapse,
  Loader2,
  MessageSquarePlus,
  MessagesSquare,
  PenLine,
  RotateCcw,
  ScanSearch,
  Send,
  Sparkles,
  TextQuote,
  WandSparkles,
  X,
} from 'lucide-react';

import { AiAnswerView, GraphPreview, InlineMarkdown, useKatex } from './AiAnswerView';
import { applyConceptFixes, deriveConceptStyle, DIRECTION_LABELS, dominantInkColors, SUGGESTION_KIND_LABELS } from './conceptMap';
import { blobPixels, BOARD_TEXT_FONT } from './rasterize';

import type { VisionPrepInfo } from './rasterize';
import {
  askPrompt,
  CHAT_QUESTION_MAX,
  chatContextPrompt,
  clearChat,
  clipRef,
  expandQuestion,
  inkFollowUpQuestion,
  newTurnId,
  placeTurn,
  readAnswerLength,
  readChat,
  summarizeQuestion,
  writeAnswerLength,
  writeChat,
} from './askChat';
import { blocksToMarkdown, choiceLetters, markdownToBlocks } from './markdownBlocks';
import { safeLocalStorage } from './panelDrag';
import { KIND_LABELS, suggestedAskAction } from './classifyRouting';
import { handwritingDefault } from './handwritingLayout';
import type { HandPrefs } from './handwritingLayout';
import { correctedVersionBlocks, markableQuestions, PAGE_TYPE_LABELS, VERDICT_LABELS } from './pageAnalysis';
import { describeTypeViolation, enforceQuestionTypes, findTypeViolations, normalizeQuestionType, QUESTION_TYPE_LABELS } from './pageLayout';
import { reaskPrompt, typeCorrectionPrompt } from './clientPrompts';
import { errorMessage, useAiRun, useOfflineReason, useOnline } from './useAiRun';
import { StepCheckBody } from './StepCheckBody';

import type { StepCheckActions } from './StepCheckBody';

import type { AnswerLength, AskChatTurn } from './askChat';
import type { PageLayout, RemakeMode, TypeViolation } from './pageLayout';
import type { PanelPoint, PanelSize } from './panelDrag';
import type { RemakeDraftRequest } from './remakeDraft';
import type { WbLocale } from '../../../i18n/strings';
import type {
  BoardAiAskAction,
  BoardAiBlock,
  BoardAiCatalog,
  BoardAiClassification,
  BoardAiGenerateKind,
  BoardAiService,
  ConceptMap,
  ConceptMapStyle,
  NormalizedBox,
  PageAnalysis,
  RemakeImageResult,
  BoardAiImageSize,
  BoardAiImageStyle,
  BoardAiScope,
} from './types';
import { IMAGE_PROMPT_MAX } from './types';
import { useWbStrings } from '../../../i18n/context';
import type { WbStringKey } from '../../../i18n/strings';

/**
 * The AI panel: «Ask AI» (a lassoed region), «Create with AI» (generate from a prompt) and
 * «Check this page» (check a whole page). Streams live, renders math, and hands finished blocks to the
 * layer to insert — it never touches the canvas itself.
 */

export type PanelSession =
  | {
      mode: 'ask';
      image: Blob;
      previewUrl: string;
      source: 'lasso' | 'selection';
      /** The picture actually sent, after vision prep — shown so a bad crop is visible. */
      sent?: VisionPrepInfo & { width: number; height: number };
      /** The page's chat thread (askChat.ts) — fixed when the session opened, not the page now on screen. */
      chatKey: string;
      /**
       * «Circle new writing»: this picture continues the thread — asked about at once, with the question
       * (and quoted part) the composer held when the student went to circle it.
       */
      followUp?: CircleFollowUp;
    }
  /** The page's «Ask AI» chat reopened without a new picture: read it back, ask text follow-ups. */
  | { mode: 'chat'; chatKey: string }
  | { mode: 'generate' }
  /** «Explain on my page»: the AI marks the selection / the page up with a pen; the layer runs it. */
  | { mode: 'pen'; source: 'selection' | 'page' }
  | { mode: 'analyze'; image: Blob; previewUrl: string }
  /** «Check this page» as a step checker (StepCheckBody.tsx); `run` restarts it. */
  | { mode: 'stepcheck'; run: number }
  | { mode: 'remake'; image: Blob; previewUrl: string; imageSize: { width: number; height: number }; lines: NormalizedBox[] };

export interface BoardAiPanelActions {
  /** `handwriting` set = «Write it by hand» (written as traced ink, optionally in the teacher's own hand). */
  insertBlocks: (blocks: BoardAiBlock[], options: { withAnswers: boolean; handwriting?: { matchHand: boolean } | null }) => Promise<void>;
  insertBlocksOnNewPage: (blocks: BoardAiBlock[], notice?: string) => Promise<void>;
  markErrors: (analysis: PageAnalysis) => Promise<number>;
  insertConceptMap: (map: ConceptMap, style: ConceptMapStyle, where: 'beside' | 'new-page') => Promise<void>;
  snapshotPage: () => Promise<Blob | null>;
  /** Builds the remade page right after the current one; `asImage` = flattened image page. */
  insertRemadePage: (layout: PageLayout, options: { asImage: boolean }) => Promise<boolean>;
  /**
   * «Exact same look»: starts the image-edit remake on a DRAFT page inserted right after the current
   * one (the dissolve overlay, the review and keep/retry/delete live on that page, not in this panel).
   * False when it could not start (the panel stays open and says so).
   */
  startRemakeDraft: (request: RemakeDraftRequest) => Promise<boolean>;
  /** The style remembered for this board (or the device default), else null. */
  storedStyle: ConceptMapStyle | null;
  saveStyle: (style: ConceptMapStyle) => void;
  /** Teacher's current pen, the fallback style for a first generated map. */
  penStyle: Partial<ConceptMapStyle>;
  /** «Write it by hand» / «Match my handwriting», remembered per board. */
  handPrefs: { read: () => HandPrefs; save: (prefs: HandPrefs) => void };
  /**
   * «Explain on my page»: captures the page, asks the service for a pen plan and plays it on the
   * board (one undo step). Resolves with the spoken answer and how many marks landed; rejects with a
   * user-facing Error (`code: 'NOT_AVAILABLE'` = the server has no such tool yet).
   */
  penExplain?: (question: string, signal: AbortSignal, onStatus: (line: string | null) => void) => Promise<{ say?: string; added: number }>;
  /**
   * «Circle new writing»: the panel steps aside, the lasso arms, and the circled picture opens as an ask
   * session on the same thread carrying `followUp`. Absent = the host has no lasso.
   */
  circleMore?: (followUp: CircleFollowUp) => void;
  /** «Check this page» (step checker) — present when the service can plan on the page. */
  checkSteps?: StepCheckActions['checkSteps'];
  clearStepMarks?: StepCheckActions['clearStepMarks'];
}

/** What the composer held when «Circle new writing» sent the student back to the board to circle. */
export interface CircleFollowUp {
  question: string;
  quote?: string;
}

/** What «Add to the board» was asked to do. */
export interface InsertChoice {
  withAnswers: boolean;
  handwriting: { matchHand: boolean } | null;
}

interface BoardAiPanelProps {
  session: PanelSession;
  service: BoardAiService;
  actions: BoardAiPanelActions;
  style?: React.CSSProperties;
  className?: string;
  onClose: () => void;
  /**
   * Header drag: the top-left the panel was dragged to (viewport px), its size, and whether the drag
   * ended. The layer clamps and places it; absent = the panel cannot be dragged.
   */
  onMove?: (point: PanelPoint, size: PanelSize, done: boolean) => void;
  /** Corner drag: the size the panel was dragged to (viewport px) and whether the drag ended. */
  onResize?: (size: PanelSize, done: boolean) => void;
  /** The panel's element, for the layer to measure (it is portalled out of the layer's DOM). */
  elementRef?: React.MutableRefObject<HTMLDivElement | null>;
}

const ASK_ACTIONS: Array<{ action: Exclude<BoardAiAskAction, 'custom'>; label: WbStringKey; prompt: string }> = [
  { action: 'solve', label: 'ai.ask.solve', prompt: 'Solve' },
  { action: 'explain', label: 'ai.ask.explain', prompt: 'Explain' },
  { action: 'check_answer', label: 'ai.ask.check', prompt: 'Check' },
  { action: 'concept_map', label: 'ai.ask.conceptMap', prompt: 'Concept map' },
];

/** The router never blocks the panel: past this, the actions just stay in their usual order. */
const CLASSIFY_TIMEOUT_MS = 3000;

const GENERATE_KINDS: Array<{ kind: BoardAiGenerateKind; label: WbStringKey; placeholder: WbStringKey }> = [
  { kind: 'questions', label: 'ai.gen.questions', placeholder: 'ai.gen.questionsHint' },
  { kind: 'summary', label: 'ai.gen.summary', placeholder: 'ai.gen.summaryHint' },
  { kind: 'table', label: 'ai.gen.table', placeholder: 'ai.gen.tableHint' },
  { kind: 'diagram', label: 'ai.gen.diagram', placeholder: 'ai.gen.diagramHint' },
  { kind: 'concept_map', label: 'ai.ask.conceptMap', placeholder: 'ai.gen.conceptMapHint' },
  { kind: 'free', label: 'ai.gen.free', placeholder: 'ai.gen.freeHint' },
  { kind: 'image', label: 'ai.gen.image', placeholder: 'ai.gen.imageHint' },
];

const GRADE_IDS = ['prep1', 'prep2', 'prep3', 'sec1', 'sec2', 'sec3'];
const SCOPE_KEY = 'wb-ai-scope';

function readStoredScope(): { grade?: string; subject?: string } {
  try {
    const raw = localStorage.getItem(SCOPE_KEY);

    return raw ? (JSON.parse(raw) as { grade?: string; subject?: string }) : {};
  } catch {
    return {};
  }
}

/** The scope every request carries, plus `lang: 'en'`: every answer is in English. */
function readScope(_locale?: WbLocale): BoardAiScope {
  return { ...readStoredScope(), lang: 'en' };
}

function writeScope(scope: { grade?: string; subject?: string }) {
  try {
    localStorage.setItem(SCOPE_KEY, JSON.stringify(scope));
  } catch {
    /* convenience only */
  }
}

// Clay look (the Study tokens, with fallbacks): 2px same-hue edge, straight-down lip, press = sink.
const EDGE = 'border-2 border-[rgb(var(--st-clay-edge,205_209_224))]';
const LIP = 'shadow-[0_3px_0_rgb(var(--st-clay-edge,205_209_224))]';
const PRESS = 'transition-[transform,box-shadow] duration-100 active:translate-y-[2px] active:shadow-none';
const SURFACE = 'bg-[rgb(var(--st-surface,255_255_255))] text-ink';

const chipClass = (selected: boolean, disabled = false) =>
  `inline-flex h-8 items-center rounded-sm border-2 px-3 text-xs font-semibold ${PRESS} ${
    selected
      ? 'border-[rgb(var(--st-accent,47_91_234))] bg-[rgb(var(--st-accent-soft,227_233_253))] text-ink shadow-[0_3px_0_rgb(var(--st-accent,47_91_234))]'
      : `border-[rgb(var(--st-clay-edge,205_209_224))] ${SURFACE} ${LIP}`
  } ${disabled ? 'cursor-not-allowed opacity-45' : ''}`;

const primaryClass = `inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-xl border-2 border-[rgb(var(--st-accent-lip,43_76_190))] bg-[rgb(var(--st-accent,47_91_234))] px-3 text-xs font-bold text-[rgb(var(--st-accent-fg,255_255_255))] shadow-[0_3px_0_rgb(var(--st-accent-lip,43_76_190))] ${PRESS} disabled:cursor-not-allowed disabled:opacity-45`;
const secondaryClass = `inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-xl px-2.5 text-xs font-semibold ${EDGE} ${SURFACE} ${LIP} ${PRESS} disabled:cursor-not-allowed disabled:opacity-45`;

function ScopePicker({ catalog, suggestedSubject }: { catalog: BoardAiCatalog | null; suggestedSubject?: string }) {
  const [scope, setScope] = useState(readStoredScope);
  const phases = (catalog?.phases ?? []).filter((phase) => GRADE_IDS.includes(phase.id));
  const subjects = phases.find((phase) => phase.id === scope.grade)?.subjects ?? [];

  const update = (next: { grade?: string; subject?: string }) => {
    setScope(next);
    writeScope(next);
  };

  // The router's subject (confidence ≥ 0.6) fills an EMPTY subject chip for the chosen grade — it
  // never overrides one the teacher picked. Matched by catalog id or label.
  useEffect(() => {
    if (!suggestedSubject || scope.subject || !scope.grade) return;

    const wanted = suggestedSubject.trim().toLowerCase();
    const match = subjects.find((subject) => subject.id.toLowerCase() === wanted || subject.label === suggestedSubject.trim());

    if (match) update({ grade: scope.grade, subject: match.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestedSubject, scope.grade, subjects.length]);

  if (phases.length === 0) return null;

  return (
    <div className='space-y-1.5'>
      <div className='flex flex-wrap gap-1'>
        {phases.map((phase) => (
          <button
            key={phase.id}
            className={chipClass(scope.grade === phase.id)}
            type='button'
            onClick={() => update(scope.grade === phase.id ? {} : { grade: phase.id })}
          >
            {phase.label}
          </button>
        ))}
      </div>
      {subjects.length > 0 ? (
        <div className='flex flex-wrap gap-1'>
          {subjects.map((subject) => (
            <button
              key={subject.id}
              className={chipClass(scope.subject === subject.id)}
              type='button'
              onClick={() => update({ grade: scope.grade, subject: scope.subject === subject.id ? undefined : subject.id })}
            >
              {subject.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StatusRow({ line, thinking }: { line: string | null; thinking: boolean }) {
  const { t } = useWbStrings();
  return (
    <div className='text-ink/70 flex items-center gap-2 text-xs' role='status'>
      <Loader2 aria-hidden className='h-3.5 w-3.5 animate-spin' />
      {line ?? (thinking ? t('ai.thinking') : t('ai.requesting'))}
    </div>
  );
}

function useCatalog(service: BoardAiService): BoardAiCatalog | null {
  const [catalog, setCatalog] = useState<BoardAiCatalog | null>(null);

  useEffect(() => {
    let alive = true;

    void service
      .getCatalog?.()
      .then((value) => {
        if (alive) setCatalog(value);
      })
      .catch(() => undefined);

    return () => {
      alive = false;
    };
  }, [service]);

  return catalog;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);

    return true;
  } catch {
    return false;
  }
}

/** Concept-map review: the transcribed map, the suggested fixes, and «same style, new topic». */
function ConceptReview({
  service,
  actions,
  image,
}: {
  service: BoardAiService;
  actions: BoardAiPanelActions;
  image: Blob;
}) {
  const { t, dir, locale } = useWbStrings();
  const analysisRun = useAiRun();
  const generateRun = useAiRun();
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [topic, setTopic] = useState('');
  const [busy, setBusy] = useState(false);
  const online = useOnline();
  const [inkColors, setInkColors] = useState<string[] | null>(null);
  const concept = analysisRun.state.concept;
  const { penStyle, saveStyle } = actions;

  // Colours come from the pixels: the guest model reads the map through a text transcript.
  useEffect(() => {
    let alive = true;

    void blobPixels(image).then((data) => {
      if (alive) setInkColors(data ? dominantInkColors(data) : []);
    });

    return () => {
      alive = false;
    };
  }, [image]);

  const style = useMemo(() => {
    if (!concept || inkColors === null) return null;

    const derived = deriveConceptStyle(concept.map, penStyle);

    return inkColors.length > 0 ? { ...derived, nodeColors: [inkColors[0]!], edgeColor: inkColors[1] ?? inkColors[0]! } : derived;
  }, [concept, inkColors, penStyle]);
  const fixed = useMemo(() => {
    if (!concept) return null;

    const fixes = concept.suggestions.filter((s) => accepted.has(s.id) && s.fix).map((s) => s.fix!);
    const map = applyConceptFixes(concept.map, fixes);

    // Measured colours beat the transcript's guesses for the copy.
    return inkColors?.length ? { ...map, nodes: map.nodes.map(({ color: _color, ...node }) => node) } : map;
  }, [accepted, concept, inkColors]);

  useEffect(() => {
    void analysisRun.run((signal) => service.analyzeConceptMap({ image, ...readScope(locale) }, signal), { expect: 'concept' });
    // Once per opened review.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image, service]);

  // The learned style is remembered as soon as it is read — the next generated map uses it. Once per
  // distinct style: saving re-renders the layer, which must not feed back into another save.
  const savedStyleRef = useRef<string | null>(null);

  useEffect(() => {
    if (!style) return;

    const key = JSON.stringify(style);

    if (savedStyleRef.current === key) return;
    savedStyleRef.current = key;
    saveStyle(style);
  }, [saveStyle, style]);

  const generated = generateRun.state.concept?.map ?? null;

  const insert = async (map: ConceptMap, where: 'beside' | 'new-page') => {
    if (!style) return;
    setBusy(true);

    try {
      await actions.insertConceptMap(map, style, where);
    } finally {
      setBusy(false);
    }
  };

  if (analysisRun.state.status === 'running' && !concept) {
    return <StatusRow line={analysisRun.state.statusLine ?? t('ai.concept.reading')} thinking={analysisRun.state.thinking} />;
  }

  if (!concept || !style || !fixed) {
    return (
      <div className='space-y-2'>
        <p className='text-sm text-[#e11d48]'>
          {analysisRun.state.error ?? t('ai.concept.readFailed')}
        </p>
        <button className={secondaryClass} disabled={!online} type='button' onClick={() => void analysisRun.run((signal) => service.analyzeConceptMap({ image, ...readScope(locale) }, signal), { expect: 'concept' })}>
          <RotateCcw aria-hidden className='h-3.5 w-3.5' />
          {t('ai.retry')}
        </button>
      </div>
    );
  }

  const fixable = concept.suggestions.filter((s) => s.fix);

  return (
    <div className='space-y-3'>
      <div>
        <p className='text-ink text-sm font-bold'>{concept.map.title ?? t('ai.concept.map')}</p>
        <p className='text-ink/60 text-[11px]'>
          {t('ai.concept.counts', { direction: t(DIRECTION_LABELS[style.direction]), edges: concept.map.edges.length, nodes: concept.map.nodes.length })}
        </p>
      </div>
      <GraphPreview map={fixed} maxHeight={200} style={style} />
      {concept.suggestions.length > 0 ? (
        <div className='space-y-1.5'>
          <div className='flex items-center justify-between'>
            <p className='text-ink text-xs font-bold'>
              {t('ai.concept.suggestions')}
              {concept.checked === false ? <span className='text-ink/55 ms-1.5 text-[10px] font-normal'>{t('ai.concept.unchecked')}</span> : null}
            </p>
            {fixable.length > 1 ? (
              <button
                className='text-ink/70 text-[11px] font-semibold underline underline-offset-4'
                type='button'
                onClick={() => setAccepted(accepted.size === fixable.length ? new Set() : new Set(fixable.map((s) => s.id)))}
              >
                {accepted.size === fixable.length ? t('ai.concept.rejectAll') : t('ai.concept.acceptAll')}
              </button>
            ) : null}
          </div>
          <ul className='space-y-1'>
            {concept.suggestions.map((suggestion) => {
              const isAccepted = accepted.has(suggestion.id);

              return (
                <li key={suggestion.id} className='border-ink/10 flex items-start gap-2 rounded-md border px-2 py-1.5 text-xs leading-5'>
                  {suggestion.fix ? (
                    <button
                      aria-pressed={isAccepted}
                      aria-label={isAccepted ? t('ai.concept.unaccept') : t('ai.concept.accept')}
                      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border ${
                        isAccepted ? 'border-ink bg-citrine' : 'border-ink/30 bg-paper'
                      }`}
                      type='button'
                      onClick={() => {
                        const next = new Set(accepted);

                        if (isAccepted) next.delete(suggestion.id);
                        else next.add(suggestion.id);
                        setAccepted(next);
                      }}
                    >
                      {isAccepted ? <Check aria-hidden className='h-3.5 w-3.5' /> : null}
                    </button>
                  ) : (
                    <CircleHelp aria-hidden className='text-ink/40 mt-0.5 h-4 w-4 shrink-0' />
                  )}
                  <span>
                    <span className='text-ink/55 me-1 font-semibold'>{t(SUGGESTION_KIND_LABELS[suggestion.kind])}:</span>
                    {suggestion.message}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p className='text-ink/70 text-xs'>
          {concept.checked === false ? t('ai.concept.uncheckedFull') : t('ai.concept.clean')}
        </p>
      )}
      <div className='flex flex-wrap gap-1.5'>
        <button className={primaryClass} disabled={busy} type='button' onClick={() => void insert(fixed, 'beside')}>
          {accepted.size > 0 ? t('ai.concept.addFixed') : t('ai.concept.addTidy')}
        </button>
        <button className={secondaryClass} disabled={busy} type='button' onClick={() => void insert(fixed, 'new-page')}>
          {t('ai.onNewPage')}
        </button>
      </div>
      <div className='border-ink/10 space-y-1.5 border-t pt-2'>
        <p className='text-ink text-xs font-bold'>{t('ai.concept.similar')}</p>
        <div className='flex gap-1.5'>
          <input
            className={`h-8 min-w-0 flex-1 rounded-xl px-2.5 text-xs outline-none focus:border-[rgb(var(--st-accent,47_91_234))] ${EDGE} ${SURFACE}`}
            dir={dir}
            placeholder={t('ai.concept.newTopic')}
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
          />
          <button
            className={primaryClass}
            disabled={!online || !topic.trim() || generateRun.state.status === 'running'}
            type='button'
            onClick={() =>
              void generateRun.run((signal) => service.generateConceptMap({ topic: topic.trim(), style, ...readScope(locale) }, signal), { expect: 'concept' })
            }
          >
            <WandSparkles aria-hidden className='h-3.5 w-3.5' />
            {t('ai.concept.make')}
          </button>
        </div>
        {generateRun.state.status === 'running' ? <StatusRow line={generateRun.state.statusLine} thinking={generateRun.state.thinking} /> : null}
        {generateRun.state.error ? <p className='text-xs text-[#e11d48]'>{generateRun.state.error}</p> : null}
        {generated ? (
          <div className='space-y-1.5'>
            <GraphPreview map={generated} maxHeight={200} style={style} />
            <div className='flex flex-wrap gap-1.5'>
              <button className={primaryClass} disabled={busy} type='button' onClick={() => void insert(generated, 'beside')}>
                {t('ai.addToBoard')}
              </button>
              <button className={secondaryClass} disabled={busy} type='button' onClick={() => void insert(generated, 'new-page')}>
                {t('ai.onNewPage')}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * «Read: …» — what the AI read off the lasso, OPEN by default so a misread is obvious before the
 * answer is trusted. «Fix the reading» lets the teacher fix it and re-ask from the text alone.
 */
function TranscriptNote({ text, onCorrect }: { text: string; onCorrect?: (corrected: string) => void }) {
  const { t } = useWbStrings();
  const katex = useKatex();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);

  useEffect(() => setDraft(text), [text]);

  return (
    <details open className='border-ink/15 bg-ink/5 text-ink/80 rounded-xl border px-2.5 py-1.5 text-xs leading-6'>
      <summary className='cursor-pointer select-none font-semibold'>{t('ai.transcript.read')}</summary>
      {editing ? (
        <div className='space-y-1.5 pt-1'>
          <textarea
            aria-label={t('ai.transcript.fix')}
            className='border-2 border-[rgb(var(--st-clay-edge,205_209_224))] bg-[rgb(var(--st-surface,255_255_255))] text-ink w-full resize-none rounded-xl px-2 py-1.5 text-xs leading-6 outline-none focus:border-[rgb(var(--st-accent,47_91_234))]'
            dir='auto'
            rows={3}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className='flex gap-1.5'>
            <button
              className={primaryClass}
              disabled={!draft.trim()}
              type='button'
              onClick={() => {
                setEditing(false);
                onCorrect?.(draft.trim());
              }}
            >
              {t('ai.transcript.askWith')}
            </button>
            <button className={secondaryClass} type='button' onClick={() => setEditing(false)}>
              {t('ai.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className='whitespace-pre-line pt-1'>
            <InlineMarkdown katex={katex} text={text} />
          </p>
          {onCorrect ? (
            <button className='text-ink/70 hover:text-ink mt-1 text-[11px] font-semibold underline underline-offset-4' type='button' onClick={() => setEditing(true)}>
              {t('ai.transcript.fix')}
            </button>
          ) : null}
        </>
      )}
    </details>
  );
}

/** «The picture that was sent» — the exact picture the AI got, with a way to save it for a bug report. */
function SentImage({ session }: { session: Extract<PanelSession, { mode: 'ask' }> }) {
  const { t } = useWbStrings();
  const [large, setLarge] = useState(false);
  const sent = session.sent;

  return (
    <div className='space-y-1'>
      <button className='block w-full' title={t('ai.enlarge')} type='button' onClick={() => setLarge((value) => !value)}>
        <img
          alt={t('ai.sent.alt')}
          className={`border-ink/10 mx-auto rounded-md border bg-white object-contain ${large ? 'max-h-[60vh]' : 'max-h-28'}`}
          src={session.previewUrl}
        />
      </button>
      <div className='text-ink/55 flex items-center justify-between gap-2 text-[10px]'>
        <span>
          {t('ai.sent.label')}{sent ? ` · ${sent.width}×${sent.height}` : ''}
          {sent?.inverted ? t('ai.sent.inverted') : ''}
          {sent?.thickened ? t('ai.sent.thickened') : ''}
        </span>
        <a className='font-semibold underline underline-offset-4' download={`board-ai-${Date.now()}.png`} href={session.previewUrl}>
          {t('ai.sent.save')}
        </a>
      </div>
    </div>
  );
}

function AnswerFooter({
  blocks,
  text,
  onInsert,
  onRetry,
  onSummarize,
  busy,
  handPrefs,
  action = null,
}: {
  blocks: BoardAiBlock[];
  text: string;
  onInsert: (choice: InsertChoice) => void;
  /** Absent = nothing to re-run (a turn read back from an earlier visit). */
  onRetry?: () => void;
  /** «Summarize»: a follow-up that boils the answer down to a few bullets (a new turn). */
  onSummarize?: () => void;
  busy: boolean;
  handPrefs?: BoardAiPanelActions['handPrefs'];
  /** The ask action that produced the answer — «Solve» / «Explain» are written by hand by default. */
  action?: string | null;
}) {
  const { t } = useWbStrings();
  const [withAnswers, setWithAnswers] = useState(false);
  const [copied, setCopied] = useState(false);
  const [prefs, setPrefs] = useState<HandPrefs>(() => handPrefs?.read() ?? { on: null, matchHand: false });
  const hasQuestions = blocks.some((block) => block.type === 'question' && (block.answerIndex !== undefined || block.answer || block.explanation));
  // Only words can be handwritten: a lone picture / table / diagram has nothing to write.
  const writable = blocks.some((block) => block.type !== 'image' && block.type !== 'table' && block.type !== 'diagram');
  const handwriting = writable && handwritingDefault(prefs, action);
  const update = (next: HandPrefs) => {
    setPrefs(next);
    handPrefs?.save(next);
  };

  return (
    <div className='border-ink/10 flex flex-wrap items-center gap-1.5 border-t pt-2'>
      <button
        className={primaryClass}
        disabled={busy || blocks.length === 0}
        type='button'
        onClick={() => onInsert({ withAnswers, handwriting: handwriting ? { matchHand: prefs.matchHand } : null })}
      >
        {busy ? <Loader2 aria-hidden className='h-3.5 w-3.5 animate-spin' /> : <Sparkles aria-hidden className='h-3.5 w-3.5' />}
        {t('ai.addToBoard')}
      </button>
      {writable && handPrefs ? (
        <button
          aria-pressed={handwriting}
          className={chipClass(handwriting)}
          title={t('ai.hand.title')}
          type='button'
          onClick={() => update({ ...prefs, on: !handwriting })}
        >
          <PenLine aria-hidden className='me-1 inline h-3 w-3' />
          {t('ai.hand.write')}
        </button>
      ) : null}
      {handwriting && handPrefs ? (
        <button
          aria-pressed={prefs.matchHand}
          className={chipClass(prefs.matchHand)}
          title={t('ai.hand.matchTitle')}
          type='button'
          onClick={() => update({ ...prefs, matchHand: !prefs.matchHand })}
        >
          {t('ai.hand.match')}
        </button>
      ) : null}
      {hasQuestions ? (
        <button aria-pressed={withAnswers} className={chipClass(withAnswers)} type='button' onClick={() => setWithAnswers((value) => !value)}>
          {t('ai.withAnswers')}
        </button>
      ) : null}
      <button
        className={secondaryClass}
        type='button'
        onClick={() =>
          void copyText(text || blocksToMarkdown(blocks)).then((ok) => {
            setCopied(ok);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <Check aria-hidden className='h-3.5 w-3.5' /> : <Copy aria-hidden className='h-3.5 w-3.5' />}
        {copied ? t('ai.copied') : t('ai.copy')}
      </button>
      {onRetry ? (
        <button className={secondaryClass} type='button' onClick={onRetry}>
          <RotateCcw aria-hidden className='h-3.5 w-3.5' />
          {t('ai.retry')}
        </button>
      ) : null}
      {onSummarize ? (
        <button className={secondaryClass} type='button' onClick={onSummarize}>
          <ListCollapse aria-hidden className='h-3.5 w-3.5' />
          {t('ai.chat.summarize')}
        </button>
      ) : null}
    </div>
  );
}

/** What the run in flight was asked — saved with its answer as one chat turn. */
interface PendingTurn {
  action: BoardAiAskAction;
  question: string;
  quote?: string;
  saved: boolean;
  /** «Retry»: the turn this run re-asks — its answer takes that turn's place instead of a new one. */
  replaceId: string | null;
}

/**
 * One AI run wired to the page's chat thread: a run that finishes with an answer is appended (once)
 * and saved, so closing the panel or reloading keeps the conversation.
 */
function useAskThread(chatKey: string) {
  const runner = useAiRun();
  const { state } = runner;
  const [turns, setTurns] = useState<AskChatTurn[]>(() => readChat(safeLocalStorage(), chatKey));
  const turnsRef = useRef(turns);
  const pendingRef = useRef<PendingTurn | null>(null);
  /** The turn the latest run saved (null while it runs, or when it failed) — what a retry replaces. */
  const lastSavedIdRef = useRef<string | null>(null);

  turnsRef.current = turns;

  useEffect(() => {
    const stored = readChat(safeLocalStorage(), chatKey);

    turnsRef.current = stored;
    setTurns(stored);
  }, [chatKey]);

  useEffect(() => {
    const pending = pendingRef.current;

    if (state.status !== 'done' || !pending || pending.saved || state.blocks.length === 0) return;

    pending.saved = true;

    const turn: AskChatTurn = {
      id: newTurnId(),
      at: Date.now(),
      action: pending.action,
      question: pending.question,
      ...(pending.quote ? { quote: pending.quote } : {}),
      ...(state.transcript ? { transcript: state.transcript } : {}),
      text: state.text || blocksToMarkdown(state.blocks),
      blocks: state.blocks,
    };
    const next = writeChat(safeLocalStorage(), chatKey, placeTurn(turnsRef.current, turn, pending.replaceId));

    lastSavedIdRef.current = turn.id;
    turnsRef.current = next;
    setTurns(next);
  }, [chatKey, state.blocks, state.status, state.text, state.transcript]);

  const send = useCallback(
    (turn: Omit<PendingTurn, 'saved' | 'replaceId'>, start: Parameters<typeof runner.run>[0], retry = false) => {
      pendingRef.current = { ...turn, saved: false, replaceId: retry ? lastSavedIdRef.current : null };
      lastSavedIdRef.current = null;
      void runner.run(start);
    },
    [runner.run],
  );

  const clear = useCallback(() => {
    pendingRef.current = null;
    lastSavedIdRef.current = null;
    runner.reset();
    clearChat(safeLocalStorage(), chatKey);
    turnsRef.current = [];
    setTurns([]);
  }, [chatKey, runner.reset]);

  return { state, turns, send, clear, cancel: runner.cancel };
}

const ACTION_LABELS: Record<Exclude<BoardAiAskAction, 'custom'>, WbStringKey> = {
  solve: 'ai.ask.solve',
  explain: 'ai.ask.explain',
  check_answer: 'ai.ask.check',
  concept_map: 'ai.ask.conceptMap',
};

/** «Short / Detailed», remembered on the device. Short by default — the owner wants compact answers. */
function useAnswerLength() {
  const [length, setLength] = useState<AnswerLength>(() => readAnswerLength(safeLocalStorage()));
  const toggle = useCallback(() => {
    setLength((current) => {
      const next: AnswerLength = current === 'short' ? 'detailed' : 'short';

      writeAnswerLength(safeLocalStorage(), next);

      return next;
    });
  }, []);

  return { length, toggle };
}

/**
 * Text selected inside a finished answer (mouse drag, or a long-press on a tablet / phone), and
 * where to float the chip for it — just below the selection, so it clears the OS copy/paste bar
 * that sits above it. A tap on the chip can collapse the selection before the click lands, so a
 * collapse while the chip is being pressed (or within a beat of it) keeps the chip.
 */
function useAnswerSelection(boxRef: React.RefObject<HTMLDivElement | null>, scrollerRef: React.RefObject<HTMLDivElement | null>, enabled: boolean) {
  const [picked, setPicked] = useState<{ text: string; left: number; top: number } | null>(null);
  const pressingRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setPicked(null);

      return;
    }

    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      const box = boxRef.current;
      const selection = typeof document !== 'undefined' ? document.getSelection() : null;
      const text = selection && !selection.isCollapsed ? selection.toString().trim() : '';
      const range = text && selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      const node = range?.commonAncestorContainer;
      const element = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null;

      if (!box || !range || !element?.closest('[data-ai-answer]') || !box.contains(element)) {
        if (pressingRef.current) return;

        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => setPicked(null), 250);

        return;
      }

      clearTimeout(hideTimer);

      const rect = range.getBoundingClientRect();
      const frame = box.getBoundingClientRect();
      // Centre under the selection, kept inside the thread (the chip is ~180 px wide).
      const half = Math.min(96, frame.width / 2);
      const left = Math.min(Math.max(rect.left + rect.width / 2 - frame.left, half), frame.width - half);
      const top = Math.min(Math.max(rect.bottom - frame.top + 6, 0), frame.height - 8);

      // Unchanged = the same object: a drag fires selectionchange per step, and every new object would
      // re-render the whole thread (KaTeX and all) on a low-end tablet.
      setPicked((current) => (current && current.text === text && current.left === left && current.top === top ? current : { text, left, top }));
    };
    const scroller = scrollerRef.current;

    document.addEventListener('selectionchange', read);
    scroller?.addEventListener('scroll', read, { passive: true });

    return () => {
      clearTimeout(hideTimer);
      document.removeEventListener('selectionchange', read);
      scroller?.removeEventListener('scroll', read);
    };
  }, [boxRef, enabled, scrollerRef]);

  const take = useCallback(() => {
    const text = picked?.text ?? '';

    pressingRef.current = false;
    setPicked(null);

    try {
      document.getSelection()?.removeAllRanges();
    } catch {
      /* nothing selected */
    }

    return text;
  }, [picked]);

  const press = useCallback(() => {
    pressingRef.current = true;
    // Released on its own: a press that never became a click must not pin the chip.
    setTimeout(() => {
      pressingRef.current = false;
    }, 800);
  }, []);

  return { picked, take, press };
}

/** Answers are selectable even inside a board that turns selection off for the pen. */
const SELECTABLE: React.CSSProperties = { userSelect: 'text', WebkitUserSelect: 'text', WebkitTouchCallout: 'default' } as React.CSSProperties;

/**
 * The thread so far, oldest first, then the answer streaming in (not yet a turn). Keeps itself
 * scrolled to the newest message. Selecting text in a finished answer floats «Explain more» / «Quote».
 */
function ChatThread({
  turns,
  live,
  onNewChat,
  onExpand,
  onQuote,
}: {
  turns: AskChatTurn[];
  /** The run in flight / the failed run (its partial answer and error). */
  live: { running: boolean; statusLine: string | null; thinking: boolean; blocks: BoardAiBlock[]; error: string | null; question: string | null; quote?: string | null } | null;
  onNewChat: () => void;
  /** «Explain more» on a selection; absent (offline, a run in flight) = no chip. */
  onExpand?: (text: string) => void;
  /** «Quote»: the selection goes onto the composer as a reference. */
  onQuote?: (text: string) => void;
}) {
  const { t } = useWbStrings();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const liveSize = live ? live.blocks.length : -1;
  const selection = useAnswerSelection(boxRef, scrollerRef, Boolean(onExpand || onQuote));

  useEffect(() => {
    const scroller = scrollerRef.current;

    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [turns.length, liveSize, live?.running]);

  if (turns.length === 0 && !live) return null;

  const bubble = (text: string, quote?: string | null) => (
    <div className='flex justify-end'>
      <div className='bg-ink/5 text-ink max-w-[85%] rounded-xl px-2.5 py-1.5 text-xs'>
        {quote ? (
          <p className='text-ink/55 border-ink/20 mb-0.5 line-clamp-2 border-s-2 ps-1.5 text-[11px]'>{quote}</p>
        ) : null}
        <p className='whitespace-pre-wrap break-words font-semibold'>{text}</p>
      </div>
    </div>
  );
  const chipButton = `inline-flex h-9 items-center gap-1 rounded-md px-3 text-xs font-bold ${EDGE} ${SURFACE} ${LIP} ${PRESS}`;

  return (
    <div className='space-y-1.5'>
      {turns.length > 0 ? (
        <div className='flex items-center justify-between gap-2'>
          <span className='text-ink/55 text-[11px] font-semibold'>{t('ai.chat.count', { n: turns.length })}</span>
          <button className={secondaryClass} disabled={Boolean(live?.running)} type='button' onClick={onNewChat}>
            <MessageSquarePlus aria-hidden className='h-3.5 w-3.5' />
            {t('ai.chat.new')}
          </button>
        </div>
      ) : null}
      <div ref={boxRef} className='relative'>
        <div ref={scrollerRef} aria-live='polite' className='max-h-[min(46vh,28rem)] space-y-3 overflow-y-auto pe-1'>
          {turns.map((turn) => (
            <div key={turn.id} className='space-y-1.5'>
              {bubble(turn.question.trim() || (turn.action === 'custom' ? '' : t(ACTION_LABELS[turn.action])), turn.quote)}
              <div data-ai-answer style={SELECTABLE}>
                <AiAnswerView blocks={turn.blocks.length > 0 ? turn.blocks : markdownToBlocks(turn.text)} />
              </div>
            </div>
          ))}
          {live ? (
            <div className='space-y-1.5'>
              {live.question ? bubble(live.question, live.quote) : null}
              {live.running && live.blocks.length === 0 ? <StatusRow line={live.statusLine} thinking={live.thinking} /> : null}
              {live.blocks.length > 0 ? <AiAnswerView blocks={live.blocks} /> : null}
              {live.error ? <p className='text-xs text-[#e11d48]'>{live.error}</p> : null}
            </div>
          ) : null}
        </div>
        {selection.picked ? (
          <div
            className='shadow-sk absolute z-10 flex -translate-x-1/2 gap-1 rounded-full'
            role='toolbar'
            style={{ left: selection.picked.left, top: selection.picked.top }}
            onMouseDown={(event) => event.preventDefault()}
            onPointerDown={selection.press}
          >
            {onExpand ? (
              <button className={chipButton} type='button' onClick={() => onExpand(selection.take())}>
                <Sparkles aria-hidden className='h-3.5 w-3.5' />
                {t('ai.chat.moreDetail')}
              </button>
            ) : null}
            {onQuote ? (
              <button className={chipButton} type='button' onClick={() => onQuote(selection.take())}>
                <TextQuote aria-hidden className='h-3.5 w-3.5' />
                {t('ai.chat.quote')}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The composer under the thread: one line — «Short / Detailed», the question, «Circle new writing», «Send».
 * A quoted part («Quote») sits on it as a one-line pill. When `revealKey` changes (a new turn
 * landed) the panel body scrolls just enough to bring it back into view — in «Ask AI» it sits
 * under the picture, the chips, the thread and the answer actions, below the fold.
 */
function ChatComposer({
  value,
  placeholder,
  disabled,
  revealKey,
  length,
  quote,
  onChange,
  onSubmit,
  onLength,
  onClearQuote,
  onCircle,
}: {
  value: string;
  placeholder: string;
  disabled: boolean;
  revealKey?: number;
  length: AnswerLength;
  quote: string | null;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onLength: () => void;
  onClearQuote: () => void;
  /** «Circle new writing»; absent = the host has no lasso (or a run is in flight). */
  onCircle?: () => void;
}) {
  const { t, dir } = useWbStrings();
  const formRef = useRef<HTMLFormElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const form = formRef.current;
    // The panel body's own scroll — never scrollIntoView, which also scrolls the board's
    // overflow-hidden ancestors.
    const scroller = form?.closest<HTMLElement>('[data-board-ai-body]');

    if (!form || !scroller || !revealKey) return;

    const below = form.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom;

    if (below > 0) scroller.scrollTop += below + 12;
  }, [revealKey]);

  // A fresh quote: straight to typing about it.
  useEffect(() => {
    if (quote) inputRef.current?.focus();
  }, [quote]);

  const iconButton = `${secondaryClass} w-8 !px-0`;

  return (
    <form
      ref={formRef}
      className='space-y-1'
      onSubmit={(event) => {
        event.preventDefault();

        if (value.trim()) onSubmit();
      }}
    >
      {quote ? (
        <div className='bg-ink/5 text-ink/70 flex items-center gap-1.5 rounded-md py-0.5 pe-0.5 ps-2 text-[11px]'>
          <TextQuote aria-hidden className='h-3 w-3 shrink-0' />
          <span className='min-w-0 flex-1 truncate' title={quote}>
            {quote}
          </span>
          <button aria-label={t('ai.chat.unquote')} className='hover:bg-ink/10 rounded-sm p-1' type='button' onClick={onClearQuote}>
            <X aria-hidden className='h-3 w-3' />
          </button>
        </div>
      ) : null}
      <div className='flex items-center gap-1.5 pb-1'>
        <button
          aria-pressed={length === 'short'}
          className={`${chipClass(length === 'short')} shrink-0 !px-2`}
          title={t('ai.chat.lengthTitle')}
          type='button'
          onClick={onLength}
        >
          {t(length === 'short' ? 'ai.chat.short' : 'ai.chat.detailed')}
        </button>
        <input
          ref={inputRef}
          className={`h-8 min-w-0 flex-1 rounded-xl px-2.5 text-xs outline-none focus:border-[rgb(var(--st-accent,47_91_234))] ${EDGE} ${SURFACE}`}
          dir={dir}
          disabled={disabled}
          maxLength={CHAT_QUESTION_MAX}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        {onCircle ? (
          <button aria-label={t('ai.chat.circleMore')} className={iconButton} disabled={disabled} title={t('ai.chat.circleMore')} type='button' onClick={onCircle}>
            <LassoSelect aria-hidden className='h-3.5 w-3.5' />
          </button>
        ) : null}
        <button aria-label={t('ai.send')} className={`${primaryClass} w-8 !px-0`} disabled={disabled || !value.trim()} type='submit'>
          <Send aria-hidden className='h-3.5 w-3.5' />
        </button>
      </div>
    </form>
  );
}

/** The answer actions for the newest message: the failed run's partial answer, else the last turn. */
function threadFooterBlocks(state: { status: string; blocks: BoardAiBlock[]; text: string }, turns: AskChatTurn[]) {
  if (state.status === 'running') return null;
  if (state.status === 'error' && state.blocks.length > 0) return { blocks: state.blocks, text: state.text, action: null };

  const last = turns[turns.length - 1];

  return last ? { blocks: last.blocks.length > 0 ? last.blocks : markdownToBlocks(last.text), text: last.text, action: last.action } : null;
}

/**
 * A follow-up with no new picture («Summarize», «Explain more», a typed question in the chat): the thread
 * rides along as text on the generate route. Returns the run, so «Retry» can repeat it.
 */
function textFollowUp(
  service: BoardAiService,
  send: ReturnType<typeof useAskThread>['send'],
  turns: AskChatTurn[],
  ask: { question: string; quote?: string; short: boolean; locale: WbLocale },
  onLive: (question: string, quote: string | null) => void,
) {
  const sent = chatContextPrompt(turns, ask.question, ask.locale, undefined, { quote: ask.quote, short: ask.short });
  const scope = readScope(ask.locale);

  return (retry = false) => {
    onLive(ask.question, ask.quote ?? null);
    send({ action: 'custom', question: ask.question, ...(ask.quote ? { quote: ask.quote } : {}) }, (signal) => service.generate({ kind: 'free', prompt: sent, ...scope }, signal), retry);
  };
}

function AskBody({ session, service, actions }: { session: Extract<PanelSession, { mode: 'ask' }>; service: BoardAiService; actions: BoardAiPanelActions }) {
  const { t, locale } = useWbStrings();
  const offlineReason = useOfflineReason();
  const thread = useAskThread(session.chatKey);
  const { state, turns, send } = thread;
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<'answer' | 'concept'>('answer');
  const [lastAction, setLastAction] = useState<{ action: BoardAiAskAction; prompt?: string } | null>(null);
  const [liveQuestion, setLiveQuestion] = useState<{ text: string; quote: string | null } | null>(null);
  const [quote, setQuote] = useState<string | null>(null);
  const answerLength = useAnswerLength();
  const short = answerLength.length === 'short';
  const [recommended, setRecommended] = useState<BoardAiClassification | null>(null);
  const [busy, setBusy] = useState(false);
  const online = useOnline();
  const catalog = useCatalog(service);
  /** Re-runs the last request exactly as sent (same context), for «Retry». */
  const lastRunRef = useRef<((retry?: boolean) => void) | null>(null);

  // «What did you circle?» — fired the moment the panel opens, in parallel, capped at 3 s. It only
  // preselects / reorders / presets the subject; it never runs anything. Any failure = usual order.
  useEffect(() => {
    if (!service.classify) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLASSIFY_TIMEOUT_MS);

    void service
      .classify(session.image, controller.signal, session.source, 'en')
      .then((result) => {
        if (!controller.signal.aborted && result && result.confidence >= 0.5) setRecommended(result);
      })
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [locale, service, session.image, session.source]);

  const preferred = suggestedAskAction(recommended);
  const ordered = useMemo(
    () => (preferred ? [...ASK_ACTIONS].sort((a, b) => (a.action === preferred ? -1 : b.action === preferred ? 1 : 0)) : ASK_ACTIONS),
    [preferred],
  );

  const ask = useCallback(
    (action: BoardAiAskAction, customPrompt?: string, ref: string | null = quote) => {
      if (action === 'concept_map') {
        setMode('concept');

        return;
      }

      // A typed question, a quote, «Short» or a page whose thread already has turns: the earlier
      // turns ride along inside the prompt. A bare chip on a fresh thread sends none, as before.
      const refText = ref ?? undefined;
      const sent = askPrompt(turns, action, customPrompt ?? '', locale, { short, quote: refText });
      const scope = readScope(locale);
      const image = session.image;
      const turn = { action, question: customPrompt ?? '', ...(refText ? { quote: refText } : {}) };
      const runIt = (retry = false) => {
        setLiveQuestion({ text: customPrompt ?? t(ACTION_LABELS[action as Exclude<BoardAiAskAction, 'custom'>]), quote: ref });
        send(turn, (signal) => service.ask({ image, action, prompt: sent, ...scope }, signal), retry);
      };

      setMode('answer');
      setLastAction({ action, prompt: customPrompt });
      setQuote(null);
      lastRunRef.current = runIt;
      runIt();
    },
    [locale, quote, send, service, session.image, short, t, turns],
  );

  /** «Summarize» / «Explain more»: about an answer already in the thread — no picture needed. */
  const askText = useCallback(
    (question: string, ref?: string) => {
      const runIt = textFollowUp(service, send, turns, { question, quote: ref, short, locale }, (text, q) => setLiveQuestion({ text, quote: q }));

      setMode('answer');
      lastRunRef.current = runIt;
      runIt();
    },
    [locale, send, service, short, turns],
  );

  // «Circle new writing»: this picture continues the thread. It is asked the moment the panel opens
  // ONLY when the student typed a question to go with it — nothing is ever sent in their name that
  // they did not write: with no question the panel just shows the picture and waits for a tap.
  useEffect(() => {
    const followUp = session.followUp;

    if (followUp && followUp.question.trim()) ask('custom', inkFollowUpQuestion(followUp.question, locale), followUp.quote ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Re-ask from the teacher's corrected reading — text only, no picture to misread. */
  const askWithText = useCallback(
    (corrected: string) => {
      const action = lastAction?.action ?? 'solve';
      const scope = readScope(locale);
      const runIt = (retry = false) =>
        send(
          { action, question: lastAction?.prompt ?? '' },
          async function* (signal) {
            yield { type: 'transcript' as const, data: corrected };
            yield* service.generate({ kind: 'free', prompt: reaskPrompt(action, lastAction?.prompt, corrected, locale), ...scope }, signal);
          },
          retry,
        );

      setMode('answer');
      lastRunRef.current = runIt;
      // The same question from the corrected reading: its answer replaces the misread one.
      runIt(true);
    },
    [lastAction, locale, send, service],
  );

  const footer = threadFooterBlocks(state, turns);

  const insert = async (choice: InsertChoice) => {
    if (!footer) return;

    setBusy(true);

    try {
      await actions.insertBlocks(footer.blocks, choice);
    } finally {
      setBusy(false);
    }
  };

  const showLive = state.status === 'running' || state.status === 'error';
  const canFollow = online && state.status !== 'running';
  const canCircle = Boolean(actions.circleMore) && state.status !== 'running';

  return (
    <div className='space-y-3'>
      <SentImage session={session} />
      {recommended ? (
        <p className='text-ink/55 text-[11px]' title={t('ai.ask.confidence', { pct: Math.round(recommended.confidence * 100) })}>
          {t('ai.ask.looksLike', { kind: t(KIND_LABELS[recommended.kind]) })}
          {recommended.hasHandwriting ? t('ai.ask.handwritten') : ''}
        </p>
      ) : null}
      <div className='flex flex-wrap gap-1.5'>
        {ordered.map((item) => {
          const isRecommended = preferred === item.action;
          // Preselected = highlighted until the teacher picks something; still one tap to run.
          const isActive =
            (mode === 'concept' && item.action === 'concept_map') ||
            (mode === 'answer' && lastAction?.action === item.action) ||
            (isRecommended && !lastAction && mode === 'answer');

          return (
            <button
              key={item.action}
              className={chipClass(Boolean(isActive), !online)}
              disabled={!online}
              title={!online ? offlineReason : undefined}
              type='button'
              onClick={() => ask(item.action)}
            >
              {t(item.label)}
              {isRecommended ? <span className='text-ink/60 ms-1 text-[10px]'>{t('ai.ask.suggested')}</span> : null}
            </button>
          );
        })}
      </div>
      {mode === 'concept' ? (
        <ConceptReview actions={actions} image={session.image} service={service} />
      ) : (
        <>
          {state.transcript && state.status !== 'idle' ? <TranscriptNote text={state.transcript} onCorrect={askWithText} /> : null}
          <ChatThread
            live={
              showLive
                ? { running: state.status === 'running', statusLine: state.statusLine, thinking: state.thinking, blocks: state.blocks, error: state.error, question: liveQuestion?.text ?? null, quote: liveQuestion?.quote }
                : null
            }
            turns={turns}
            onExpand={canFollow ? (text) => askText(expandQuestion(locale), clipRef(text)) : undefined}
            onNewChat={thread.clear}
            onQuote={canFollow ? (text) => setQuote(clipRef(text)) : undefined}
          />
          {footer && footer.blocks.length > 0 ? (
            <AnswerFooter
              blocks={footer.blocks}
              busy={busy}
              text={footer.text}
              action={footer.action}
              handPrefs={actions.handPrefs}
              onInsert={(choice) => void insert(choice)}
              onRetry={lastRunRef.current ? () => lastRunRef.current?.(true) : undefined}
              onSummarize={canFollow && turns.length > 0 ? () => askText(summarizeQuestion(locale)) : undefined}
            />
          ) : null}
        </>
      )}
      <ChatComposer
        disabled={!online}
        length={answerLength.length}
        placeholder={t(turns.length > 0 ? 'ai.chat.followUp' : 'ai.ask.placeholder')}
        quote={quote}
        revealKey={turns.length}
        value={prompt}
        onChange={setPrompt}
        onCircle={canCircle ? () => actions.circleMore?.({ question: prompt.trim(), ...(quote ? { quote } : {}) }) : undefined}
        onClearQuote={() => setQuote(null)}
        onLength={answerLength.toggle}
        onSubmit={() => {
          ask('custom', prompt.trim());
          setPrompt('');
        }}
      />
      <details className='text-ink/80 text-xs'>
        <summary className='cursor-pointer select-none font-semibold'>{t('ai.scope')}</summary>
        <div className='pt-2'>
          <ScopePicker catalog={catalog} suggestedSubject={recommended && recommended.confidence >= 0.6 ? recommended.subject : undefined} />
        </div>
      </details>
      {!online ? <p className='text-xs text-[#e11d48]'>{offlineReason}</p> : null}
    </div>
  );
}

/**
 * The page's chat reopened from the AI menu: the thread, and text follow-ups (no picture this time —
 * each earlier turn carries what was read off its picture).
 */
function ChatBody({ session, service, actions }: { session: Extract<PanelSession, { mode: 'chat' }>; service: BoardAiService; actions: BoardAiPanelActions }) {
  const { t, locale } = useWbStrings();
  const offlineReason = useOfflineReason();
  const thread = useAskThread(session.chatKey);
  const { state, turns, send } = thread;
  const [prompt, setPrompt] = useState('');
  const [liveQuestion, setLiveQuestion] = useState<{ text: string; quote: string | null } | null>(null);
  const [quote, setQuote] = useState<string | null>(null);
  const answerLength = useAnswerLength();
  const [busy, setBusy] = useState(false);
  const online = useOnline();
  const lastRunRef = useRef<((retry?: boolean) => void) | null>(null);
  const footer = threadFooterBlocks(state, turns);
  const showLive = state.status === 'running' || state.status === 'error';
  const canFollow = online && state.status !== 'running';
  const canCircle = Boolean(actions.circleMore) && state.status !== 'running';

  const followUp = (question: string, ref?: string) => {
    const runIt = textFollowUp(service, send, turns, { question, quote: ref, short: answerLength.length === 'short', locale }, (text, q) => setLiveQuestion({ text, quote: q }));

    lastRunRef.current = runIt;
    runIt();
  };

  const insert = async (choice: InsertChoice) => {
    if (!footer) return;

    setBusy(true);

    try {
      await actions.insertBlocks(footer.blocks, choice);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className='space-y-3'>
      {turns.length === 0 && !showLive ? <p className='text-ink/60 text-xs'>{t('ai.chat.empty')}</p> : null}
      <ChatThread
        live={
          showLive
            ? { running: state.status === 'running', statusLine: state.statusLine, thinking: state.thinking, blocks: state.blocks, error: state.error, question: liveQuestion?.text ?? null, quote: liveQuestion?.quote }
            : null
        }
        turns={turns}
        onExpand={canFollow ? (text) => followUp(expandQuestion(locale), clipRef(text)) : undefined}
        onNewChat={thread.clear}
        onQuote={canFollow ? (text) => setQuote(clipRef(text)) : undefined}
      />
      {footer && footer.blocks.length > 0 ? (
        <AnswerFooter
          blocks={footer.blocks}
          busy={busy}
          text={footer.text}
          action={footer.action}
          handPrefs={actions.handPrefs}
          onInsert={(choice) => void insert(choice)}
          onRetry={lastRunRef.current ? () => lastRunRef.current?.(true) : undefined}
          onSummarize={canFollow && turns.length > 0 ? () => followUp(summarizeQuestion(locale)) : undefined}
        />
      ) : null}
      <ChatComposer
        disabled={!online}
        length={answerLength.length}
        placeholder={t(turns.length > 0 ? 'ai.chat.followUp' : 'ai.chat.placeholder')}
        quote={quote}
        revealKey={turns.length}
        value={prompt}
        onChange={setPrompt}
        onCircle={canCircle ? () => actions.circleMore?.({ question: prompt.trim(), ...(quote ? { quote } : {}) }) : undefined}
        onClearQuote={() => setQuote(null)}
        onLength={answerLength.toggle}
        onSubmit={() => {
          followUp(prompt.trim(), quote ?? undefined);
          setQuote(null);
          setPrompt('');
        }}
      />
      {!online ? <p className='text-xs text-[#e11d48]'>{offlineReason}</p> : null}
    </div>
  );
}

function GenerateBody({ service, actions }: { service: BoardAiService; actions: BoardAiPanelActions }) {
  const { t, dir, locale } = useWbStrings();
  const offlineReason = useOfflineReason();
  const { state, run, setState } = useAiRun();
  const [kind, setKind] = useState<BoardAiGenerateKind>('questions');
  const [prompt, setPrompt] = useState('');
  const [useContext, setUseContext] = useState(false);
  const [busy, setBusy] = useState(false);
  const online = useOnline();
  const catalog = useCatalog(service);
  const imageSupported = Boolean(service.generateImage && service.capabilities?.().generateImage);
  const kinds = GENERATE_KINDS.filter((item) => item.kind !== 'image' || imageSupported);
  const conceptStyle = actions.storedStyle ?? deriveConceptStyle({ nodes: [], edges: [] }, actions.penStyle);
  const lastRef = useRef<() => void>(() => undefined);
  const [imageStyle, setImageStyle] = useState<BoardAiImageStyle>('illustration');
  const [imageSize, setImageSize] = useState<BoardAiImageSize>('landscape');
  const [imageQuality, setImageQuality] = useState<'normal' | 'high'>('normal');
  const elapsed = useElapsed(state.status === 'running');
  const tooLong = kind === 'image' && prompt.trim().length > IMAGE_PROMPT_MAX;

  const generate = async () => {
    const text = prompt.trim();

    if (!text) return;

    const contextImage = useContext ? ((await actions.snapshotPage()) ?? undefined) : undefined;
    const scope = readScope(locale);

    if (kind === 'concept_map') {
      lastRef.current = () =>
        void run((signal) => service.generateConceptMap({ topic: text, style: conceptStyle, contextImage, ...scope }, signal), { expect: 'concept' });
    } else if (kind === 'image') {
      const request = { prompt: text.slice(0, IMAGE_PROMPT_MAX), style: imageStyle, size: imageSize, quality: imageQuality === 'high' ? ('high' as const) : ('medium' as const), ...scope };

      lastRef.current = () => void run((signal) => service.generateImage!(request, signal));
    } else {
      lastRef.current = () => void run((signal) => service.generate({ prompt: text, kind, contextImage, ...scope }, signal));
    }

    lastRef.current();
  };

  const insert = async (choice: InsertChoice) => {
    setBusy(true);

    try {
      if (state.concept) await actions.insertConceptMap(state.concept.map, conceptStyle, 'beside');
      else await actions.insertBlocks(state.blocks, choice);
    } finally {
      setBusy(false);
    }
  };

  const placeholderKey = kinds.find((item) => item.kind === kind)?.placeholder;
  const placeholder = placeholderKey ? t(placeholderKey) : '';

  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap gap-1'>
        {kinds.map((item) => (
          <button
            key={item.kind}
            className={chipClass(kind === item.kind)}
            type='button'
            onClick={() => {
              setKind(item.kind);
              setState((current) => ({ ...current, concept: null }));
            }}
          >
            {t(item.label)}
          </button>
        ))}
      </div>
      <textarea
        className='border-2 border-[rgb(var(--st-clay-edge,205_209_224))] bg-[rgb(var(--st-surface,255_255_255))] text-ink w-full resize-none rounded-xl px-2.5 py-2 text-sm leading-6 outline-none focus:border-[rgb(var(--st-accent,47_91_234))]'
        dir={dir}
        disabled={!online}
        placeholder={placeholder}
        rows={3}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void generate();
        }}
      />
      {kind === 'image' ? (
        <div className='space-y-1.5'>
          <p className={`text-[11px] ${tooLong ? 'text-[#e11d48]' : 'text-ink/50'}`}>
            {prompt.trim().length}/{IMAGE_PROMPT_MAX}
            {tooLong ? t('ai.gen.tooLong') : ''}
            {t('ai.gen.imageNoText')}
          </p>
          <div className='flex flex-wrap gap-1'>
            {IMAGE_STYLES.map((item) => (
              <button key={item.value} aria-pressed={imageStyle === item.value} className={chipClass(imageStyle === item.value)} type='button' onClick={() => setImageStyle(item.value)}>
                {t(item.label)}
              </button>
            ))}
          </div>
          <div className='flex flex-wrap items-center gap-1'>
            {IMAGE_SIZES.map((item) => (
              <button key={item.value} aria-pressed={imageSize === item.value} className={chipClass(imageSize === item.value)} type='button' onClick={() => setImageSize(item.value)}>
                {t(item.label)}
              </button>
            ))}
            <span className='bg-ink/15 mx-1 h-4 w-px' />
            <button aria-pressed={imageQuality === 'normal'} className={chipClass(imageQuality === 'normal')} type='button' onClick={() => setImageQuality('normal')}>
              {t('ai.quality.normal')}
            </button>
            <button aria-pressed={imageQuality === 'high'} className={chipClass(imageQuality === 'high')} type='button' onClick={() => setImageQuality('high')}>
              {t('ai.quality.high')}
            </button>
          </div>
        </div>
      ) : null}
      {kind === 'concept_map' ? (
        <p className='text-ink/60 text-[11px]'>
          {actions.storedStyle ? t('ai.gen.conceptStored', { direction: t(DIRECTION_LABELS[conceptStyle.direction]) }) : t('ai.gen.conceptPenStyle')}
        </p>
      ) : null}
      <div className='flex flex-wrap items-center gap-1.5'>
        {kind !== 'image' ? (
          <button aria-pressed={useContext} className={chipClass(useContext)} type='button' onClick={() => setUseContext((value) => !value)}>
            {t('ai.gen.useContext')}
          </button>
        ) : null}
        <button className={primaryClass} disabled={!online || !prompt.trim() || tooLong || state.status === 'running'} type='button' onClick={() => void generate()}>
          <WandSparkles aria-hidden className='h-3.5 w-3.5' />
          {t('ai.gen.create')}
        </button>
      </div>
      <details className='text-ink/80 text-xs'>
        <summary className='cursor-pointer select-none font-semibold'>{t('ai.scope')}</summary>
        <div className='pt-2'>
          <ScopePicker catalog={catalog} />
        </div>
      </details>
      {!online ? <p className='text-xs text-[#e11d48]'>{offlineReason}</p> : null}
      {state.status === 'running' && state.blocks.length === 0 && !state.concept ? (
        <div className='space-y-0.5'>
          <StatusRow line={state.statusLine ?? (kind === 'image' ? t('ai.gen.drawingImage') : null)} thinking={state.thinking} />
          {kind === 'image' ? <p className='text-ink/50 text-[11px]'>{t('ai.seconds', { n: elapsed })}</p> : null}
        </div>
      ) : null}
      {state.concept ? (
        <GraphPreview map={state.concept.map} style={conceptStyle} />
      ) : state.blocks.length > 0 ? (
        <div className='max-h-[min(42vh,26rem)] overflow-y-auto pe-1'>
          <AiAnswerView blocks={state.blocks} />
        </div>
      ) : null}
      {state.error ? <p className='text-xs text-[#e11d48]'>{state.error}</p> : null}
      {state.status === 'done' && (state.blocks.length > 0 || state.concept) ? (
        <AnswerFooter blocks={state.concept ? [{ type: 'paragraph', text: state.concept.map.title ?? '' }] : state.blocks} busy={busy} handPrefs={state.concept ? undefined : actions.handPrefs} text={state.text} onInsert={(choice) => void insert(choice)} onRetry={() => lastRef.current()} />
      ) : null}
    </div>
  );
}

/** A thrown value that means «the server has no such tool yet» — shown calmly, never as a failure. */
const isUnavailable = (error: unknown) => Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'NOT_AVAILABLE');

function PenBody({ session, actions }: { session: Extract<PanelSession, { mode: 'pen' }>; actions: BoardAiPanelActions }) {
  const { t, dir, locale } = useWbStrings();
  const offlineReason = useOfflineReason();
  const online = useOnline();
  const katex = useKatex();
  const [question, setQuestion] = useState('');
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error' | 'unavailable'>('idle');
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [say, setSay] = useState<string | null>(null);
  const [added, setAdded] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const run = async () => {
    if (!actions.penExplain || status === 'running') return;

    controllerRef.current?.abort();

    const controller = new AbortController();

    controllerRef.current = controller;
    setStatus('running');
    setStatusLine(null);
    setSay(null);
    setError(null);

    try {
      const result = await actions.penExplain(question.trim(), controller.signal, setStatusLine);

      if (controller.signal.aborted) return;

      setSay(result.say ?? null);
      setAdded(result.added);
      setStatus('done');
    } catch (failure) {
      if (controller.signal.aborted) return;

      if (isUnavailable(failure)) {
        setStatus('unavailable');
      } else {
        setError(errorMessage(failure, locale));
        setStatus('error');
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setStatusLine(null);
    }
  };

  const cancel = () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setStatus('idle');
    setStatusLine(null);
  };

  return (
    <div className='space-y-3'>
      <p className='text-ink/70 text-xs'>
        {t('ai.pen.intro')} <span className='font-semibold'>{t(session.source === 'selection' ? 'ai.pen.scopeSelection' : 'ai.pen.scopePage')}</span>
      </p>
      <textarea
        className='border-2 border-[rgb(var(--st-clay-edge,205_209_224))] bg-[rgb(var(--st-surface,255_255_255))] text-ink w-full resize-none rounded-xl px-2.5 py-2 text-sm leading-6 outline-none focus:border-[rgb(var(--st-accent,47_91_234))]'
        dir={dir}
        disabled={!online || status === 'running'}
        placeholder={t('ai.pen.hint')}
        rows={2}
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void run();
        }}
      />
      <div className='flex flex-wrap items-center gap-1.5'>
        {status === 'running' ? (
          <button className={secondaryClass} data-pen-cancel type='button' onClick={cancel}>
            <X aria-hidden className='h-3.5 w-3.5' />
            {t('ai.pen.cancel')}
          </button>
        ) : (
          <button className={primaryClass} data-pen-run disabled={!online || !actions.penExplain} type='button' onClick={() => void run()}>
            <PenLine aria-hidden className='h-3.5 w-3.5' />
            {status === 'done' || status === 'error' ? t('ai.pen.again') : t('ai.pen.run')}
          </button>
        )}
      </div>
      {!online ? <p className='text-xs text-[#e11d48]'>{offlineReason}</p> : null}
      {status === 'running' ? <StatusRow line={statusLine ?? t('ai.pen.reading')} thinking={false} /> : null}
      {status === 'done' ? (
        <div className='space-y-1.5' data-pen-say>
          {say ? (
            <p className='text-ink text-sm leading-6' dir={dir}>
              <InlineMarkdown katex={katex} text={say} />
            </p>
          ) : null}
          <p className='text-ink/60 text-[11px]'>{added > 0 ? t('ai.pen.added') : t('ai.pen.nothing')}</p>
        </div>
      ) : null}
      {status === 'unavailable' ? <p className='text-ink/60 text-xs' data-pen-unavailable role='status'>{t('ai.pen.unavailable')}</p> : null}
      {status === 'error' && error ? <p className='text-xs text-[#e11d48]'>{error}</p> : null}
    </div>
  );
}

function AnalyzeBody({ session, service, actions }: { session: Extract<PanelSession, { mode: 'analyze' }>; service: BoardAiService; actions: BoardAiPanelActions }) {
  const { t, locale } = useWbStrings();
  const offlineReason = useOfflineReason();
  const { state, run, cancel } = useAiRun();
  // The teacher endpoint solves every question (~20 s each): show it is alive and let it be stopped.
  const elapsed = useElapsed(state.status === 'running');
  const katex = useKatex();
  const [busy, setBusy] = useState<'page' | 'marks' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const online = useOnline();
  const start = useCallback(() => {
    setNotice(null);
    void run((signal) => service.analyzePage({ image: session.image, ...readScope(locale) }, signal), { expect: 'analysis' });
  }, [run, service, session.image]);

  useEffect(() => {
    if (online) start();
    // Once per opened page check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.image]);

  const analysis = state.analysis;
  const markable = analysis ? markableQuestions(analysis) : [];
  const wrong = analysis?.questions.filter((q) => q.verdict === 'wrong').length ?? 0;

  return (
    <div className='space-y-3'>
      <img alt={t('ai.currentPage')} className='border-ink/10 bg-paper mx-auto max-h-24 rounded-md border object-contain' src={session.previewUrl} />
      {!online ? <p className='text-xs text-[#e11d48]'>{offlineReason}</p> : null}
      {state.status === 'running' && !analysis ? (
        <div className='flex items-center justify-between gap-2'>
          <div className='min-w-0 space-y-0.5'>
            <StatusRow line={state.statusLine ?? t('ai.analyze.checking')} thinking={state.thinking} />
            <p className='text-ink/50 text-[11px]'>{t('ai.analyze.slowNote', { n: elapsed })}</p>
          </div>
          <button className={secondaryClass} type='button' onClick={cancel}>
            <X aria-hidden className='h-3.5 w-3.5' />
            {t('ai.cancel')}
          </button>
        </div>
      ) : null}
      {state.error ? <p className='text-xs text-[#e11d48]'>{state.error}</p> : null}
      {analysis ? (
        <>
          <p className='text-ink text-sm font-bold'>
            {t(PAGE_TYPE_LABELS[analysis.pageType])}
            {analysis.questions.length > 0 ? <span className='text-ink/60 ms-2 text-xs font-semibold'>{t('ai.analyze.counts', { n: analysis.questions.length, wrong })}</span> : null}
          </p>
          {analysis.questions.length > 0 ? (
            <ul className='max-h-[min(38vh,22rem)] space-y-1.5 overflow-y-auto pe-1'>
              {analysis.questions.map((question, index) => {
                const symbol = question.verdict === 'correct' ? '✓' : question.verdict === 'wrong' ? '✗' : '?';
                const tone =
                  question.verdict === 'correct' ? 'bg-[#22c55e]/15 text-ink' : question.verdict === 'wrong' ? 'bg-[#e11d48]/10 text-ink' : 'bg-ink/5 text-ink';

                return (
                  <li key={`${question.n}-${index}`} className={`rounded-xl px-2.5 py-2 text-xs leading-5 ${tone}`}>
                    <div className='flex items-start gap-2'>
                      <span aria-hidden className='w-4 shrink-0 text-center text-sm font-bold'>
                        {symbol}
                      </span>
                      <div className='min-w-0 space-y-0.5'>
                        <p className='font-semibold'>
                          {question.n}) <InlineMarkdown katex={katex} text={question.text} />
                        </p>
                        <p className='text-ink/65'>
                          {t(VERDICT_LABELS[question.verdict])}
                          {question.confidence !== undefined ? (
                            <span className='text-ink/45' title={t('ai.analyze.confidenceTitle')}>
                              {t('ai.analyze.confidencePct', { pct: Math.round(question.confidence * 100) })}
                            </span>
                          ) : null}
                          {question.givenAnswer ? (
                            <>
                              {t('ai.analyze.written')}
                              <InlineMarkdown katex={katex} text={question.givenAnswer} />
                            </>
                          ) : null}
                        </p>
                        {question.verdict !== 'correct' && question.correctAnswer ? (
                          <p>
                            {t('ai.analyze.correct')} <InlineMarkdown katex={katex} text={question.correctAnswer} />
                          </p>
                        ) : null}
                        {question.reason && question.verdict !== 'correct' ? (
                          // «unclear» is now the common answer for handwriting the reader could not
                          // confirm — its reason is the point, so it is not muted.
                          <p className={question.verdict === 'unclear' ? 'text-ink' : 'text-ink/70'}>
                            {question.verdict === 'unclear' ? <span className='font-semibold'>{t('ai.analyze.why')} </span> : null}
                            <InlineMarkdown katex={katex} text={question.reason} />
                            {question.verdict === 'unclear' ? <span className='text-ink/60'> {t('ai.analyze.checkYourself')}</span> : null}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className='text-ink/70 text-xs'>{t('ai.analyze.noQuestions')}</p>
          )}
          {notice ? <p className='text-ink/75 text-xs'>{notice}</p> : null}
          <div className='border-ink/10 flex flex-wrap gap-1.5 border-t pt-2'>
            <button
              className={primaryClass}
              disabled={busy !== null || analysis.questions.length === 0}
              type='button'
              onClick={() => {
                setBusy('page');
                void actions.insertBlocksOnNewPage(correctedVersionBlocks(analysis, undefined, locale)).finally(() => setBusy(null));
              }}
            >
              {busy === 'page' ? <Loader2 aria-hidden className='h-3.5 w-3.5 animate-spin' /> : null}
              {t('ai.analyze.correctedCopy')}
            </button>
            <button
              className={secondaryClass}
              disabled={busy !== null || markable.length === 0}
              title={markable.length === 0 ? t('ai.analyze.noMarkSpots') : undefined}
              type='button'
              onClick={() => {
                setBusy('marks');
                void actions
                  .markErrors(analysis)
                  .then((count) =>
                    setNotice(
                      count > 0 ? t(count === 1 ? 'ai.analyze.markedOne' : 'ai.analyze.markedMany', { n: count }) : t('ai.analyze.markFailed'),
                    ),
                  )
                  .finally(() => setBusy(null));
              }}
            >
              {t('ai.analyze.markErrors')}
            </button>
            <button className={secondaryClass} disabled={!online || state.status === 'running'} type='button' onClick={start}>
              <RotateCcw aria-hidden className='h-3.5 w-3.5' />
              {t('ai.retry')}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

const REMAKE_MODES: Array<{ mode: RemakeMode; label: WbStringKey }> = [
  { mode: 'similar', label: 'ai.remake.similar' },
  { mode: 'edit_question', label: 'ai.remake.editQuestion' },
  { mode: 'fix_errors', label: 'ai.remake.fixErrors' },
];

/** The layout as boxes on a page — what lands where, before anything is built. */
function LayoutPreview({ layout }: { layout: PageLayout }) {
  const { t } = useWbStrings();
  const { w, h } = layout.page;

  return (
    <svg aria-label={t('ai.remake.previewAria')} className='border-ink/15 mx-auto max-h-72 w-full rounded-md border bg-white' role='img' viewBox={`0 0 ${w} ${h}`}>
      {layout.blocks.map((block, index) => {
        const x = block.bbox.x * w;
        const y = block.bbox.y * h;
        const bw = block.bbox.w * w;
        const bh = block.bbox.h * h;

        if (block.kind === 'figure') {
          return <rect key={index} fill='#f1eee4' height={bh} stroke='#18204a' strokeDasharray='6 4' width={bw} x={x} y={y} />;
        }

        if (block.kind === 'answer_lines') {
          return <rect key={index} fill='none' height={bh} stroke='#18204a' strokeDasharray='2 6' strokeOpacity={0.4} width={bw} x={x} y={y} />;
        }

        const text = block.kind === 'choices' && block.choices ? block.choices.join('   ') : block.kind === 'table' ? (block.header ?? []).join(' | ') : (block.content ?? '');

        return (
          <text
            key={index}
            fill={block.style?.color ?? '#18204a'}
            fontFamily={BOARD_TEXT_FONT}
            fontSize={Math.min(block.style?.fontSize ?? bh * 0.6, bh * 0.8)}
            fontWeight={block.kind === 'header' || block.style?.weight === 'bold' ? 700 : 400}
            textAnchor={block.style?.align === 'center' ? 'middle' : block.style?.align === 'right' ? 'end' : 'start'}
            x={block.style?.align === 'center' ? x + bw / 2 : block.style?.align === 'right' ? x + bw : x}
            y={y + bh * 0.75}
          >
            {text.replace(/\$/g, '').slice(0, 90)}
          </text>
        );
      })}
    </svg>
  );
}

/** Seconds since `running` became true — the image path takes 30–90 s and must show it is alive. */
function useElapsed(running: boolean): number {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!running) return;

    setSeconds(0);

    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);

    return () => clearInterval(timer);
  }, [running]);

  return seconds;
}

/** The new questions and their answers — for the teacher only, never drawn on the page. */
export function RemakeAnswers({ result }: { result: RemakeImageResult }) {
  const { t } = useWbStrings();
  const katex = useKatex();

  if (result.newQuestions.length === 0) return null;

  return (
    <details className='border-ink/15 rounded-xl border px-2.5 py-1.5 text-xs leading-6'>
      <summary className='text-ink cursor-pointer select-none font-semibold'>{t('ai.remake.answersN', { n: result.newQuestions.length })}</summary>
      <ol className='space-y-1.5 pt-1'>
        {result.newQuestions.map((question, index) => (
          <li key={`${question.n}-${index}`}>
            <p className='text-ink font-semibold'>
              {question.n}) <InlineMarkdown katex={katex} text={question.text} />
              {normalizeQuestionType(question.type) ? (
                <span className='text-ink/45 ms-1.5 text-[10px] font-normal'>· {t(QUESTION_TYPE_LABELS[normalizeQuestionType(question.type)!])}</span>
              ) : null}
            </p>
            {question.choices?.length ? (
              <p className='text-ink/70'>
                {question.choices.map((choice, choiceIndex) => (
                  <span key={choiceIndex} className='me-3 inline-block'>
                    {choiceLetters()[choiceIndex] ?? choiceIndex + 1}) <InlineMarkdown katex={katex} text={choice} />
                  </span>
                ))}
              </p>
            ) : null}
            {question.answer ? (
              <p className='text-ink/75'>
                {t('ai.answer')} <InlineMarkdown katex={katex} text={question.answer} />
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

type RemakeVariant = 'image' | 'layout';

function RemakeBody({ session, service, actions }: { session: Extract<PanelSession, { mode: 'remake' }>; service: BoardAiService; actions: BoardAiPanelActions }) {
  const { t, dir, locale } = useWbStrings();
  const offlineReason = useOfflineReason();
  const { state, run, cancel } = useAiRun();
  const imageSupported = Boolean(service.remakePageImage && service.capabilities?.().remakeImage);
  // The owner's default is the identical-look image path; the editable rebuild is the fallback.
  const [variant, setVariant] = useState<RemakeVariant>('image');
  const [mode, setMode] = useState<RemakeMode>('similar');
  const [quality, setQuality] = useState<'normal' | 'high'>('normal');
  // «Write the questions in my handwriting»: the new page's questions written with the handwriting engine, not Plex.
  const [handwrittenText, setHandwrittenText] = useState(false);
  const [target, setTarget] = useState('');
  const [instruction, setInstruction] = useState('');
  const [asImage, setAsImage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const online = useOnline();
  const running = state.status === 'running';
  const elapsed = useElapsed(running);
  // The server requires a target for edit_question (400 WB_AI_TARGET_REQUIRED); the instruction is optional.
  const ready = mode !== 'edit_question' || target.trim() !== '';
  const effective: RemakeVariant = variant === 'image' && !imageSupported ? 'layout' : variant;

  // Capabilities are probed lazily; re-read them a moment after opening.
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setTick((value) => value + 1), 1500);

    return () => clearTimeout(timer);
  }, []);

  const start = () => {
    setFailed(false);

    const edit = mode === 'edit_question' ? { target: target.trim(), instruction: instruction.trim() } : {};

    if (effective === 'image') {
      // The copy is made on its own draft page under the dissolve overlay; this panel closes.
      setBusy(true);
      void actions
        .startRemakeDraft({ mode, quality, textMode: 'overlay', ...(handwrittenText ? { handwrittenText } : {}), ...edit, ...readScope(locale) })
        .then((ok) => setFailed(!ok))
        .finally(() => setBusy(false));

      return;
    }

    layoutAttemptRef.current = { correction: undefined };
    setTypeFixes([]);
    runLayout(edit, undefined);
  };

  const runLayout = (edit: { target?: string; instruction?: string }, correction: string | undefined) => {
    void run(
      (signal) =>
        service.remakePage(
          { image: session.image, imageSize: session.imageSize, lines: session.lines, mode, correction, ...edit, ...readScope(locale) },
          signal,
        ),
      { expect: 'layout' },
    );
  };

  // Owner rule: each new question keeps its original's type (and an MCQ its choice count). A layout
  // that breaks it is re-asked ONCE with the exact complaint; if the second answer still breaks it,
  // the questions are forced back into their original shape and the teacher is told which.
  const layoutAttemptRef = useRef<{ correction: string | undefined }>({ correction: undefined });
  const [typeFixes, setTypeFixes] = useState<TypeViolation[]>([]);
  const [checkedLayout, setCheckedLayout] = useState<PageLayout | null>(null);

  useEffect(() => {
    const layout = state.layout;

    if (!layout || state.status !== 'done') {
      setCheckedLayout(null);

      return;
    }

    const violations = findTypeViolations(layout);

    if (violations.length === 0) {
      setCheckedLayout(layout);

      return;
    }

    if (layoutAttemptRef.current.correction === undefined) {
      const correction = typeCorrectionPrompt(violations, locale);

      layoutAttemptRef.current = { correction };
      runLayout(mode === 'edit_question' ? { target: target.trim(), instruction: instruction.trim() } : {}, correction);

      return;
    }

    setTypeFixes(violations);
    setCheckedLayout(enforceQuestionTypes(layout, violations, locale));
    // Once per finished answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.layout, state.status]);

  const insert = (action: () => Promise<boolean>) => {
    setBusy(true);
    void action()
      .then((ok) => setFailed(!ok))
      .finally(() => setBusy(false));
  };

  return (
    <div className='space-y-3'>
      <img alt={t('ai.currentPage')} className='border-ink/10 bg-paper mx-auto max-h-24 rounded-md border object-contain' src={session.previewUrl} />
      <div className='flex flex-wrap gap-1'>
        <button
          aria-pressed={effective === 'image'}
          className={chipClass(effective === 'image', !imageSupported)}
          disabled={!imageSupported || running}
          title={!imageSupported ? t('ai.soon') : undefined}
          type='button'
          onClick={() => setVariant('image')}
        >
          {t('ai.remake.exactLook')}
          {!imageSupported ? <span className='text-ink/60 ms-1 text-[10px]'>{t('ai.remake.soonTag')}</span> : null}
        </button>
        <button aria-pressed={effective === 'layout'} className={chipClass(effective === 'layout')} disabled={running} type='button' onClick={() => setVariant('layout')}>
          {t('ai.remake.editable')}
        </button>
      </div>
      <div className='flex flex-wrap gap-1'>
        {REMAKE_MODES.map((item) => (
          <button key={item.mode} className={chipClass(mode === item.mode)} disabled={running} type='button' onClick={() => setMode(item.mode)}>
            {t(item.label)}
          </button>
        ))}
      </div>
      {mode === 'edit_question' ? (
        <div className='flex gap-1.5'>
          <input
            aria-label={t('ai.remake.questionNumber')}
            className='border-2 border-[rgb(var(--st-clay-edge,205_209_224))] bg-[rgb(var(--st-surface,255_255_255))] text-ink w-16 rounded-xl px-2 py-1.5 text-center text-xs outline-none focus:border-[rgb(var(--st-accent,47_91_234))]'
            inputMode='numeric'
            placeholder={t('ai.remake.number')}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
          <input
            className={`h-8 min-w-0 flex-1 rounded-xl px-2.5 text-xs outline-none focus:border-[rgb(var(--st-accent,47_91_234))] ${EDGE} ${SURFACE}`}
            dir={dir}
            placeholder={t('ai.remake.instructionHint')}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
          />
        </div>
      ) : null}
      <div className='flex flex-wrap items-center gap-1.5'>
        {effective === 'image' ? (
          <>
            <span className='text-ink/60 text-[11px]'>{t('ai.remake.quality')}</span>
            <button aria-pressed={quality === 'normal'} className={chipClass(quality === 'normal')} disabled={running} type='button' onClick={() => setQuality('normal')}>
              {t('ai.quality.normal')}
            </button>
            <button aria-pressed={quality === 'high'} className={chipClass(quality === 'high')} disabled={running} type='button' onClick={() => setQuality('high')}>
              {t('ai.quality.high')}
            </button>
            <button
              aria-pressed={handwrittenText}
              className={chipClass(handwrittenText)}
              disabled={running}
              title={t('ai.remake.handTitle')}
              type='button'
              onClick={() => setHandwrittenText((value) => !value)}
            >
              {t('ai.remake.handQuestions')}
            </button>
          </>
        ) : (
          <button aria-pressed={asImage} className={chipClass(asImage)} type='button' onClick={() => setAsImage((value) => !value)}>
            {t('ai.remake.asImage')}
          </button>
        )}
        {running ? (
          <button className={secondaryClass} type='button' onClick={cancel}>
            <X aria-hidden className='h-3.5 w-3.5' />
            {t('ai.cancel')}
          </button>
        ) : (
          <button className={primaryClass} disabled={!online || !ready || busy} type='button' onClick={start}>
            {busy ? <Loader2 aria-hidden className='h-3.5 w-3.5 animate-spin' /> : <CopyPlus aria-hidden className='h-3.5 w-3.5' />}
            {t('ai.remake.make')}
          </button>
        )}
      </div>
      <p className='text-ink/60 text-[11px] leading-5'>
        {effective === 'image'
          ? t('ai.remake.imageNote')
          : asImage
            ? t('ai.remake.asImageNote')
            : t('ai.remake.editableNote')}{' '}
        {t('ai.remake.originalSafe')}
      </p>
      {!online ? <p className='text-xs text-[#e11d48]'>{offlineReason}</p> : null}
      {running && !state.layout ? (
        <div className='space-y-1'>
          <StatusRow line={state.statusLine ?? (effective === 'image' ? t('ai.remake.drawing') : t('ai.remake.reading'))} thinking={state.thinking} />
          <p className='text-ink/50 text-[11px]'>
            {t('ai.seconds', { n: elapsed })}
            {effective === 'image' ? t('ai.remake.slowNote') : ''}
          </p>
        </div>
      ) : null}
      {state.error ? <p className='text-xs text-[#e11d48]'>{state.error}</p> : null}
      {failed && effective === 'image' ? <p className='text-xs text-[#e11d48]'>{t('ai.remake.startFailed')}</p> : null}
      {state.layout ? (
        <>
          <LayoutPreview layout={checkedLayout ?? state.layout} />
          {typeFixes.length ? (
            <div className='bg-ink/5 rounded-xl px-2.5 py-2 text-xs leading-5'>
              <p className='text-ink font-semibold'>{t('ai.remake.typesRestored')}</p>
              <ul className='text-ink/75 list-disc ps-4'>
                {typeFixes.map((violation) => (
                  <li key={violation.n}>{describeTypeViolation(violation, locale)}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {failed ? <p className='text-xs text-[#e11d48]'>{t('ai.remake.buildFailed')}</p> : null}
          <div className='border-ink/10 flex flex-wrap gap-1.5 border-t pt-2'>
            <button
              className={primaryClass}
              disabled={busy || !checkedLayout}
              type='button'
              onClick={() => checkedLayout && insert(() => actions.insertRemadePage(checkedLayout, { asImage }))}
            >
              {busy ? <Loader2 aria-hidden className='h-3.5 w-3.5 animate-spin' /> : null}
              {t('ai.remake.create')}
            </button>
            <button className={secondaryClass} disabled={!online || running} type='button' onClick={start}>
              <RotateCcw aria-hidden className='h-3.5 w-3.5' />
              {t('ai.remake.another')}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

const IMAGE_STYLES: Array<{ value: BoardAiImageStyle; label: WbStringKey }> = [
  { value: 'illustration', label: 'ai.imgStyle.illustration' },
  { value: 'diagram', label: 'ai.imgStyle.diagram' },
  { value: 'photo', label: 'ai.imgStyle.photo' },
  { value: 'sketch', label: 'ai.imgStyle.sketch' },
  { value: 'cartoon', label: 'ai.imgStyle.cartoon' },
  { value: 'map', label: 'ai.imgStyle.map' },
];

const IMAGE_SIZES: Array<{ value: BoardAiImageSize; label: WbStringKey }> = [
  { value: 'square', label: 'ai.imgSize.square' },
  { value: 'landscape', label: 'ai.imgSize.landscape' },
  { value: 'portrait', label: 'ai.imgSize.portrait' },
  { value: 'wide', label: 'ai.imgSize.wide' },
];

const TITLES: Record<PanelSession['mode'], { title: WbStringKey; icon: React.ReactNode }> = {
  ask: { title: 'toolbar.askAi', icon: <Sparkles aria-hidden className='h-4 w-4' /> },
  chat: { title: 'ai.chat.title', icon: <MessagesSquare aria-hidden className='h-4 w-4' /> },
  generate: { title: 'toolbar.ai.generate', icon: <WandSparkles aria-hidden className='h-4 w-4' /> },
  pen: { title: 'ai.pen.title', icon: <PenLine aria-hidden className='h-4 w-4' /> },
  analyze: { title: 'toolbar.ai.analyze', icon: <ScanSearch aria-hidden className='h-4 w-4' /> },
  stepcheck: { title: 'toolbar.ai.analyze', icon: <ScanSearch aria-hidden className='h-4 w-4' /> },
  remake: { title: 'ai.title.remake', icon: <CopyPlus aria-hidden className='h-4 w-4' /> },
};

export function BoardAiPanel({ session, service, actions, style, className = '', onClose, onMove, onResize, elementRef }: BoardAiPanelProps) {
  const { t, dir } = useWbStrings();
  const heading = TITLES[session.mode];
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** «Minimise»: down to its header, so the page under it is free to write on; the body stays mounted. */
  const [collapsed, setCollapsed] = useState(false);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number; last: PanelPoint } | null>(null);
  const resizeRef = useRef<{ pointerId: number; x: number; y: number; width: number; height: number; last: PanelSize } | null>(null);
  const setPanelElement = (node: HTMLDivElement | null) => {
    panelRef.current = node;

    if (elementRef) elementRef.current = node;
  };

  // Header drag — pointer events, so a finger, the S Pen and a mouse all move it. Buttons in the
  // header (close) keep their own taps.
  const dragStart = (event: React.PointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current;

    if (!onMove || !panel || (event.pointerType === 'mouse' && event.button !== 0)) return;
    if ((event.target as Element).closest('button, a, input, select, textarea')) return;

    const box = panel.getBoundingClientRect();

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: box.left, top: box.top, last: { left: box.left, top: box.top } };
  };
  // Corner resize — the same pointer handling; width/height follow the pointer (physical bottom-right).
  const resizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current;

    if (!onResize || !panel || (event.pointerType === 'mouse' && event.button !== 0)) return;

    const box = panel.getBoundingClientRect();

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, width: box.width, height: box.height, last: { width: box.width, height: box.height } };
  };
  const resizeMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;

    if (!resize || resize.pointerId !== event.pointerId || !onResize) return;

    resize.last = { width: resize.width + event.clientX - resize.x, height: resize.height + event.clientY - resize.y };
    onResize(resize.last, false);
  };
  const resizeEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;

    if (!resize || resize.pointerId !== event.pointerId) return;

    resizeRef.current = null;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (onResize && (resize.last.width !== resize.width || resize.last.height !== resize.height)) onResize(resize.last, true);
  };
  const dragMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const panel = panelRef.current;

    if (!drag || drag.pointerId !== event.pointerId || !panel || !onMove) return;

    drag.last = { left: drag.left + event.clientX - drag.x, top: drag.top + event.clientY - drag.y };
    onMove(drag.last, { width: panel.offsetWidth, height: panel.offsetHeight }, false);
  };
  const dragEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const panel = panelRef.current;

    if (!drag || drag.pointerId !== event.pointerId) return;

    dragRef.current = null;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    // A tap on the header (no movement) is not a drag: nothing to place or remember.
    if (panel && onMove && (drag.last.left !== drag.left || drag.last.top !== drag.top)) {
      onMove(drag.last, { width: panel.offsetWidth, height: panel.offsetHeight }, true);
    }
  };

  return (
    <div
      ref={setPanelElement}
      aria-label={t(heading.title)}
      data-board-ai-panel={session.mode}
      className={`text-ink pointer-events-auto flex flex-col overflow-hidden rounded-2xl ${EDGE} bg-[rgb(var(--st-surface,255_255_255))] shadow-[0_6px_0_rgb(var(--st-clay-edge,205_209_224))] ${onResize ? '' : 'max-h-[min(86dvh,44rem)]'} ${className}`}
      dir={dir}
      role='dialog'
      // Minimised: just the header, whatever size the corner handle gave it.
      style={collapsed ? { ...style, height: 'auto' } : style}
      // Typing must never reach the board's shortcuts (Backspace deletes the selection, «e» = eraser).
      onKeyDown={(event) => {
        event.stopPropagation();

        if (event.key === 'Escape') onClose();
      }}
      onKeyUp={(event) => event.stopPropagation()}
      // The editor root cancels every contextmenu (a long-press must not cost the pen a stroke). On
      // Android Chrome a cancelled long-press also cancels the text selection, so over an answer (and
      // the composer) it stops here instead, and the selection — and «Explain more» / «Quote» — can start.
      onContextMenu={(event) => {
        if ((event.target as Element | null)?.closest?.('[data-ai-answer], input, textarea')) event.stopPropagation();
        else event.preventDefault();
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div
        className={`border-ink/10 flex items-center gap-2 border-b px-3 py-2 ${onMove ? 'cursor-grab select-none active:cursor-grabbing' : ''}`}
        style={onMove ? { touchAction: 'none' } : undefined}
        title={onMove ? t('ai.chat.drag') : undefined}
        onPointerCancel={dragEnd}
        onPointerDown={dragStart}
        onPointerMove={dragMove}
        onPointerUp={dragEnd}
      >
        {onMove ? <GripHorizontal aria-hidden className='text-ink/40 h-4 w-4 shrink-0' /> : null}
        {heading.icon}
        <p className='flex-1 text-sm font-bold'>{t(heading.title)}</p>
        {service.label ? <span className='text-ink/50 text-[10px]'>{service.label}</span> : null}
        <button
          aria-expanded={!collapsed}
          aria-label={t(collapsed ? 'ai.panel.expand' : 'ai.panel.collapse')}
          className='hover:bg-ink/5 rounded-md p-1'
          title={t(collapsed ? 'ai.panel.expand' : 'ai.panel.collapse')}
          type='button'
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? <ChevronDown aria-hidden className='h-4 w-4' /> : <ChevronUp aria-hidden className='h-4 w-4' />}
        </button>
        <button aria-label={t('ai.close')} className='hover:bg-ink/5 rounded-md p-1' type='button' onClick={onClose}>
          <X aria-hidden className='h-4 w-4' />
        </button>
      </div>
      <div data-board-ai-body className={`min-h-0 flex-1 overflow-y-auto p-3 ${collapsed ? 'hidden' : ''}`}>
        {session.mode === 'ask' ? <AskBody key={session.previewUrl} actions={actions} service={service} session={session} /> : null}
        {session.mode === 'chat' ? <ChatBody actions={actions} service={service} session={session} /> : null}
        {session.mode === 'generate' ? <GenerateBody actions={actions} service={service} /> : null}
        {session.mode === 'pen' ? <PenBody actions={actions} session={session} /> : null}
        {session.mode === 'analyze' ? <AnalyzeBody actions={actions} service={service} session={session} /> : null}
        {session.mode === 'stepcheck' && actions.checkSteps && actions.clearStepMarks ? (
          <StepCheckBody actions={{ checkSteps: actions.checkSteps, clearStepMarks: actions.clearStepMarks }} run={session.run} />
        ) : null}
        {session.mode === 'remake' ? <RemakeBody actions={actions} service={service} session={session} /> : null}
      </div>
      {onResize && !collapsed ? (
        <div
          aria-hidden
          className='text-ink/40 hover:text-ink/70 absolute bottom-0 right-0 flex h-6 w-6 cursor-nwse-resize items-end justify-end p-1'
          style={{ touchAction: 'none' }}
          title={t('ai.chat.resize')}
          onPointerCancel={resizeEnd}
          onPointerDown={resizeStart}
          onPointerMove={resizeMove}
          onPointerUp={resizeEnd}
        >
          <svg className='h-3 w-3' fill='none' stroke='currentColor' strokeLinecap='round' strokeWidth='1.5' viewBox='0 0 12 12'>
            <path d='M11 4 4 11M11 8 8 11' />
          </svg>
        </div>
      ) : null}
    </div>
  );
}
