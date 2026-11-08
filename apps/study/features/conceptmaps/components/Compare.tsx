import type { ConceptMapRecord, ReferenceMap } from '../types';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, GitCompareArrows, ImageOff, Loader2, PenLine, Quote, Sparkles } from 'lucide-react';
import dynamic from 'next/dynamic';

import { referenceMap } from '../api';
import { useAttempts } from '../hooks';
import { buildChecklist, extrasFolded, isNoPromptTerms } from '../lib/checklist';
import { isNoteNode, parseReferenceFrame } from '../lib/frames';
import { diffMaps, parseTranscription, readingGraph } from '../lib/mapDiff';
import { withStreamRetry } from '../lib/streamRetry';
import { formatScore, mapTitle, scoreSourceLabel, scoreTone } from '../lib/score';
import { matchTerms } from '../lib/terms';
import { NotesWorkspace } from '../notes/NotesWorkspace';

import { BuiltFrom } from './BuiltFrom';
import { ConceptMapViewer } from './ConceptMapViewer';
import { DrawOnBoardButton, useDrawOnBoard } from './DrawOnBoard';
import { GetToTen, NeedsTerms, OptionalExtras } from './GetToTen';
import { MapDiff } from './MapDiff';

import { formatRelative } from '@/lib/format';
import { describeError, isRetryableStreamError } from '@/lib/api/errors';
import { ActionButton, Badge, ErrorNote, FilterChip, Surface } from '@/components/ui/primitives';

// The transcription is markdown (**terms**, lists): the bank's renderer (client-only).
const Markdown = dynamic(() => import('@/features/bank').then((mod) => mod.Markdown), { ssr: false });

/**
 * Side by side: his map (latest attempt, or the Canvas submission), the professor's wording (her
 * model answer is the reference — she grades by it, not by the textbook), and an AI reference map
 * drawn from the prompt terms. «Compare maps» diffs his map against that reference (`MapDiff`).
 */
export interface CompareProps {
  classId: string;
  map: ConceptMapRecord;
  onBack: () => void;
  onPractice: (map: ConceptMapRecord) => void;
  onToast?: (text: string, tone?: 'ok' | 'danger' | 'neutral') => void;
  /** Open on this attempt (a deep link from a notebook's «Concept map» sheet) instead of the default. */
  initialAttemptId?: string;
}

const noToast = () => undefined;

export function Compare({ classId, map, onBack, onPractice, onToast = noToast, initialAttemptId }: CompareProps) {
  const attempts = useAttempts(map.id);
  const [attemptId, setAttemptId] = useState<string | 'submission'>(initialAttemptId ?? 'submission');
  const [reference, setReference] = useState<ReferenceMap | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'panels' | 'diff'>('panels');
  const [workspace, setWorkspace] = useState(false);
  // Terms are optional; only a server that still refuses (400 NO_PROMPT_TERMS) asks for a list first.
  const [termsRefused, setTermsRefused] = useState(false);
  const needsTerms = termsRefused;
  const abortRef = useRef<AbortController | null>(null);
  // «Draw on board»: the reference in hand ink on its own notebook page (fetched first when not drawn here yet).
  const boardDraw = useDrawOnBoard(classId);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Default to the newest attempt once attempts load (a practice map has no submission).
  useEffect(() => {
    if (attemptId === 'submission' && !map.submission && attempts.data?.[0]) setAttemptId(attempts.data[0].id);
  }, [attempts.data, map.submission]);

  const attempt = attemptId === 'submission' ? null : (attempts.data?.find((item) => item.id === attemptId) ?? null);
  const image = attempt ? attempt.imageUrl : (map.submission?.imageUrl ?? null);
  const herSource = scoreSourceLabel(map);
  // His map as a graph: the grader's reading of a practice attempt, or the Canvas transcription.
  const hisGraph = useMemo(() => {
    const graph = attempt?.reading
      ? readingGraph(attempt.reading)
      : !attempt && map.submission?.transcription
        ? parseTranscription(map.submission.transcription)
        : null;

    return graph && graph.edges.length > 0 ? graph : null;
  }, [attempt, map.submission?.transcription]);
  const referenceHighlight = useMemo(() => {
    if (!reference) return undefined;
    const rows = matchTerms(
      map.promptTerms,
      reference.nodes.map((node) => ({ id: node.id, label: node.text, kind: 'concept' as const })),
    );

    return new Set(rows.flatMap((row) => (row.node ? [row.node.id] : [])));
  }, [map.promptTerms, reference]);
  // «Get to 10/10»: only what she deducts for, from the core of the map (never the AI's enrichment).
  const checklist = useMemo(() => {
    if (!hisGraph && !attempt) return null;
    const diff = hisGraph && reference ? diffMaps(hisGraph, reference, map.promptTerms) : null;

    return buildChecklist({
      his: hisGraph,
      promptTerms: map.promptTerms,
      reference,
      diff,
      verdict: attempt?.verdict ?? null,
      criteria: attempt?.criteria,
      modelAnswer: map.instructor?.modelAnswer ?? null,
    });
  }, [attempt, hisGraph, map.instructor?.modelAnswer, map.promptTerms, reference]);
  const shownGrade = attempt
    ? { score: attempt.verdict.score, max: attempt.verdict.max }
    : { score: map.score, max: map.maxScore };
  const folded = extrasFolded(shownGrade, checklist ?? []);

  useEffect(() => setTermsRefused(false), [map.id, map.promptTerms.length]);

  const generate = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();

    abortRef.current = controller;
    setGenerating(true);
    setError(null);
    setReference(null);
    setStatus('Drafting…');
    // The map is complete once the `result` frame is in; a cut after it (before `done`) loses nothing.
    let complete = false;
    const run = () =>
      referenceMap(
        {
          classId,
          mapId: map.id,
          ...(map.promptTerms.length > 0 ? { promptTerms: map.promptTerms } : {}),
        },
        (frame) => {
          if (frame.event === 'status' || frame.event === 'thinking') {
            const text = (frame.data as { text?: string } | string | null) ?? null;

            setStatus(typeof text === 'string' ? text : (text?.text ?? null));

            return;
          }
          if (frame.event === 'done') complete = true;
          const parsed = parseReferenceFrame(frame);

          // A partial graph stays on screen through a retry or a failure; a later frame replaces it.
          if (parsed) setReference(parsed);
          if (parsed && frame.event === 'result') complete = true;
        },
        controller.signal,
      );

    try {
      await withStreamRetry(run, {
        signal: controller.signal,
        finished: () => complete,
        onRetry: () => setStatus('Connection dropped — retrying…'),
      });
    } catch (err) {
      if (isNoPromptTerms(err)) setTermsRefused(true);
      else if (!controller.signal.aborted && !(complete && isRetryableStreamError(err)))
        setError(
          describeError(err, 'Could not draw a reference map', 'Lost connection while drawing the map — try again.'),
        );
    } finally {
      if (!controller.signal.aborted) {
        setGenerating(false);
        setStatus(null);
      }
    }
  }, [classId, map.id, map.promptTerms]);

  const attemptPicker = (attempts.data?.length ?? 0) > 0 && (
    <select
      aria-label='Which attempt'
      className='rounded-st border-st-line bg-st-surface text-st-fg min-h-9 border px-2 text-xs'
      value={attemptId}
      onChange={(event) => setAttemptId(event.target.value)}
    >
      {map.submission && <option value='submission'>What you handed in</option>}
      {attempts.data!.map((item) => (
        <option key={item.id} value={item.id}>
          Practice {item.createdAt ? formatRelative(item.createdAt) : ''} ·{' '}
          {formatScore(item.verdict.score, item.verdict.max)}
        </option>
      ))}
    </select>
  );

  const labelOf = (id: string) => reference?.nodes.find((node) => node.id === id)?.text ?? id;

  return (
    <div className='flex flex-col gap-3'>
      <header className='flex flex-wrap items-center gap-2'>
        <ActionButton className='min-h-10 px-3' variant='ghost' onClick={onBack}>
          <ArrowLeft className='h-4 w-4' /> Back
        </ActionButton>
        <div className='min-w-0 flex-1'>
          <h2 className='text-st-fg truncate text-base font-semibold'>{mapTitle(map)}</h2>
          <p className='text-st-muted truncate text-xs'>{map.promptTerms.join(' · ')}</p>
        </div>
        <ActionButton className='min-h-10 px-3' variant='primary' onClick={() => onPractice(map)}>
          <PenLine className='h-4 w-4' /> Practice again
        </ActionButton>
      </header>

      {needsTerms ? (
        <NeedsTerms onEnter={() => setWorkspace(true)} />
      ) : (
        checklist && <GetToTen grade={shownGrade} items={checklist} />
      )}

      <div className='flex flex-wrap gap-2'>
        <FilterChip active={view === 'panels'} onClick={() => setView('panels')}>
          Panels
        </FilterChip>
        <FilterChip active={view === 'diff'} onClick={() => setView('diff')}>
          <GitCompareArrows className='h-4 w-4' /> Compare maps
        </FilterChip>
      </div>

      {view === 'diff' ? (
        <Surface className='flex min-w-0 flex-col gap-3 p-4'>
          <div className='flex flex-wrap items-start justify-between gap-2'>
            <div className='min-w-0'>
              <h3 className='text-st-fg text-sm font-semibold'>Your map vs the AI reference</h3>
              <p className='text-st-muted mt-0.5 text-xs'>
                Extra links are not wrong — where it differs from the model answer, the model answer wins.
              </p>
            </div>
            <div className='flex items-center gap-2'>
              {attemptPicker}
              <DrawOnBoardButton
                busy={boardDraw.busy}
                disabled={needsTerms || generating}
                onClick={() => void boardDraw.draw(map, reference)}
              />
              <ActionButton
                className='min-h-9 shrink-0 px-3 text-xs'
                disabled={needsTerms}
                loading={generating}
                variant={reference ? 'secondary' : 'primary'}
                onClick={() => void generate()}
              >
                <Sparkles className='h-3.5 w-3.5' /> {reference ? 'Redraw' : 'Draw it'}
              </ActionButton>
            </div>
          </div>
          {error && <ErrorNote message={error} onRetry={() => void generate()} />}
          {boardDraw.error && <ErrorNote message={boardDraw.error} onRetry={() => void boardDraw.draw(map, reference)} />}
          {(boardDraw.status || (generating && !reference)) && (
            <p className='text-st-muted flex items-center gap-2 text-sm'>
              <Loader2 className='h-4 w-4 animate-spin' /> {boardDraw.status ?? status ?? 'Drafting…'}
            </p>
          )}
          {reference && <BuiltFrom provenance={reference.provenance} />}
          {!hisGraph ? (
            <p className='text-st-muted text-sm'>
              {attempt
                ? 'The grader did not read any links off this attempt.'
                : 'There is no transcription of this map to compare — practise it, then pick that attempt.'}
            </p>
          ) : reference ? (
            <OptionalExtras key={`${attemptId}:${folded}`} folded={folded}>
              <MapDiff
                herGrade={map.score !== null ? { score: map.score, max: map.maxScore, source: herSource } : null}
                his={hisGraph}
                promptTerms={map.promptTerms}
                reference={reference}
                verdict={attempt?.verdict ?? null}
              />
            </OptionalExtras>
          ) : (
            !generating && (
              <p className='text-st-muted text-sm'>Draw the AI reference to compare your map against it.</p>
            )
          )}
        </Surface>
      ) : (
        <div className='grid grid-cols-1 gap-4 lg:grid-cols-2'>
          <Surface className='flex min-w-0 flex-col gap-3 p-4'>
            <div className='flex items-center justify-between gap-2'>
              <h3 className='text-st-muted text-xs font-medium uppercase tracking-wide'>Yours</h3>
              {attemptPicker}
            </div>
            {image ? (
              <div className='rounded-st overflow-hidden border border-st-clay-edge bg-st-shadow'>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img alt='Your map' className='max-h-[60vh] w-full object-contain' src={image} />
              </div>
            ) : (
              <div className='rounded-st border-st-line text-st-muted flex h-40 flex-col items-center justify-center gap-2 border border-dashed text-sm'>
                <ImageOff className='h-5 w-5' />
                {attempts.isLoading ? 'Loading…' : 'No picture yet — practise this map to get one.'}
              </div>
            )}
            <div className='flex flex-wrap items-center gap-2'>
              <Badge
                tone={scoreTone(
                  attempt ? attempt.verdict.score : map.score,
                  attempt ? attempt.verdict.max : map.maxScore,
                )}
              >
                {attempt
                  ? `Predicted ${formatScore(attempt.verdict.score, attempt.verdict.max)}`
                  : `Grade ${formatScore(map.score, map.maxScore)}${herSource ? ` · ${herSource}` : ''}`}
              </Badge>
              {attempt && attempt.verdict.rawScore != null && attempt.verdict.rawScore !== attempt.verdict.score && (
                <span className='text-st-muted text-xs'>
                  rubric sum {formatScore(attempt.verdict.rawScore, attempt.verdict.max)}
                </span>
              )}
              {attempt && attempt.verdict.missingTerms.length > 0 && (
                <span className='text-st-danger text-xs'>Missing: {attempt.verdict.missingTerms.join(', ')}</span>
              )}
            </div>
            {!attempt && map.submission?.transcription && (
              <div className='text-st-fg text-sm leading-relaxed'>
                <Markdown text={map.submission.transcription} />
              </div>
            )}
            {attempt?.reading && (
              <ul className='flex flex-col gap-1 text-sm'>
                {attempt.reading.edges.map((edge, index) => {
                  const name = (id: string) => attempt.reading?.nodes.find((node) => node.id === id)?.label ?? id;

                  return (
                    <li key={index} className='text-st-fg flex flex-wrap items-center gap-1'>
                      {name(edge.from)}
                      <ArrowRight className='text-st-muted h-3.5 w-3.5' />
                      {edge.label ? (
                        <span className='text-st-muted italic'>{edge.label}</span>
                      ) : isNoteNode(attempt.reading ?? null, edge.to) ||
                        isNoteNode(attempt.reading ?? null, edge.from) ? (
                        <span className='text-st-muted text-xs'>definition</span>
                      ) : (
                        <Badge tone='warn'>no label</Badge>
                      )}
                      <ArrowRight className='text-st-muted h-3.5 w-3.5' />
                      {name(edge.to)}
                    </li>
                  );
                })}
              </ul>
            )}
          </Surface>

          <Surface className='border-st-accent/40 flex min-w-0 flex-col gap-3 p-4'>
            <div>
              <h3 className='text-st-fg flex items-center gap-1.5 text-sm font-semibold'>
                <Quote className='text-st-accent h-4 w-4' /> Model answer
              </h3>
              {map.instructor?.modelAnswer && (
                <p className='text-st-muted text-xs'>Your teacher&apos;s wording — reuse its phrases.</p>
              )}
            </div>
            {map.instructor?.comment && (
              <p className='rounded-st bg-st-warn/10 text-st-fg px-3 py-2 text-sm'>
                <span className='text-st-warn mr-1 font-medium'>Comment:</span>
                {map.instructor.comment}
              </p>
            )}
            {map.instructor?.modelAnswer ? (
              <div className='rounded-st border-st-accent/30 bg-st-accent/5 text-st-fg border px-3 py-2 text-sm leading-relaxed'>
                <Markdown text={map.instructor.modelAnswer} />
              </div>
            ) : (
              <p className='text-st-muted text-sm'>No model answer for this map — use the AI reference below.</p>
            )}
          </Surface>

          <Surface className='flex min-w-0 flex-col gap-3 p-4 lg:col-span-2'>
            <div className='flex flex-wrap items-start justify-between gap-2'>
              <div>
                <h3 className='text-st-muted text-xs font-medium uppercase tracking-wide'>AI reference</h3>
                <p className='text-st-muted mt-0.5 text-xs'>
                  A draft to check your links. Where it differs from the model answer, the model answer wins.
                </p>
              </div>
              <div className='flex flex-wrap items-center gap-2'>
                <DrawOnBoardButton
                  busy={boardDraw.busy}
                  disabled={needsTerms || generating}
                  onClick={() => void boardDraw.draw(map, reference)}
                />
                <ActionButton
                  className='min-h-9 shrink-0 px-3 text-xs'
                  disabled={needsTerms}
                  loading={generating}
                  variant={reference ? 'secondary' : 'primary'}
                  onClick={() => void generate()}
                >
                  <Sparkles className='h-3.5 w-3.5' /> {reference ? 'Redraw' : 'Draw it'}
                </ActionButton>
              </div>
            </div>
            {boardDraw.status && (
              <p className='text-st-muted flex items-center gap-2 text-sm'>
                <Loader2 className='h-4 w-4 animate-spin' /> {boardDraw.status}
              </p>
            )}
            {boardDraw.error && <ErrorNote message={boardDraw.error} onRetry={() => void boardDraw.draw(map, reference)} />}
            {needsTerms && (
              <p className='text-st-muted text-sm'>This map needs a term list first — add one to draw.</p>
            )}
            {error && <ErrorNote message={error} onRetry={() => void generate()} />}
            {generating && !reference && (
              <p className='text-st-muted flex items-center gap-2 text-sm'>
                <Loader2 className='h-4 w-4 animate-spin' /> {status ?? 'Drafting…'}
              </p>
            )}
            {reference && <BuiltFrom provenance={reference.provenance} />}
            {reference ? (
              <OptionalExtras key={`${attemptId}:${folded}`} folded={folded}>
                <ConceptMapViewer
                  edges={reference.edges}
                  highlight={referenceHighlight}
                  nodes={reference.nodes}
                  title={reference.title ?? `AI reference — ${mapTitle(map)}`}
                />
                <ul className='flex flex-col gap-1 text-sm'>
                  {reference.edges.map((edge, index) => (
                    <li key={index} className='text-st-fg flex flex-wrap items-center gap-1'>
                      {labelOf(edge.from)}
                      <ArrowRight className='text-st-muted h-3.5 w-3.5' />
                      {edge.label && <span className='text-st-muted italic'>{edge.label}</span>}
                      {edge.label && <ArrowRight className='text-st-muted h-3.5 w-3.5' />}
                      {labelOf(edge.to)}
                    </li>
                  ))}
                </ul>
              </OptionalExtras>
            ) : (
              !generating &&
              !needsTerms && (
                <p className='text-st-muted text-sm'>A clean map of these terms with every arrow labelled.</p>
              )
            )}
          </Surface>
        </div>
      )}

      {workspace && (
        <NotesWorkspace classId={classId} map={map} onClose={() => setWorkspace(false)} onToast={onToast} />
      )}
    </div>
  );
}
