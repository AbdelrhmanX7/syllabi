import type { KnowledgeConcept } from '@/lib/api/types';
import type { GraphPaint, NodeTone } from '@/features/conceptmaps/components/ConceptGraphSvg';
import type { BadgeTone } from '@/components/ui/primitives';
import type { StrengthLevel } from '../lib/knowledgeLayout';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Target } from 'lucide-react';

import { KNOWLEDGE_TEXT, STRENGTH_WORD, layoutKnowledge, practiseTopic, strengthLevel } from '../lib/knowledgeLayout';
import { pct } from '../lib/verdict';

import { ActionButton, Badge, LoadingRows, SectionTitle } from '@/components/ui/primitives';
import { ConceptGraphSvg } from '@/features/conceptmaps/components/ConceptGraphSvg';
import { useClassKnowledge } from '@/lib/api/hooks';

/**
 * The class knowledge map: every concept of the class (question topics with their parts, concept-map
 * terms, exam topics) drawn as a small map — red = weak, amber = getting there, green = strong,
 * dashed = not tried yet. Tap a concept for its line: how it is going, how many tries, «Practise this».
 * Laid out for the width it sits in (a side column or a full row), so it never needs zooming.
 */

export interface KnowledgeMapProps {
  classId: string;
  /** Starts practice on a topic — the same thing the topic list's button does. */
  onPractise?: (topic: string) => void;
  className?: string;
}

const NODE_TONE: Record<StrengthLevel, NodeTone> = { weak: 'missing', middle: 'warn', strong: 'ok', untried: 'idea' };
const BADGE_TONE: Record<StrengthLevel, BadgeTone> = { weak: 'danger', middle: 'warn', strong: 'ok', untried: 'neutral' };
const KEY_SWATCH: Record<StrengthLevel, string> = {
  weak: 'border-st-danger bg-st-danger/10',
  middle: 'border-st-warn bg-st-warn/10',
  strong: 'border-st-ok bg-st-ok/10',
  untried: 'border-st-muted/70 border-dashed bg-st-bg',
};
const LEVELS: StrengthLevel[] = ['weak', 'middle', 'strong', 'untried'];

/** Text widths in the page's own font at the map's text size; undefined off the browser. */
function useLabelMeasure(): ((text: string) => number) | undefined {
  const [fontsReady, setFontsReady] = useState(false);

  useEffect(() => {
    let live = true;

    void document.fonts?.ready.then(() => live && setFontsReady(true));

    return () => {
      live = false;
    };
  }, []);

  return useMemo(() => {
    if (typeof document === 'undefined') return undefined;
    const context = document.createElement('canvas').getContext('2d');

    if (!context) return undefined;
    const family = getComputedStyle(document.body).fontFamily || 'sans-serif';
    const cache = new Map<string, number>();

    return (text: string) => {
      const known = cache.get(text);

      if (known !== undefined) return known;
      context.font = `600 ${KNOWLEDGE_TEXT.fontSize}px ${family}`;
      const width = Math.ceil(context.measureText(text).width) + 1;

      cache.set(text, width);

      return width;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `fontsReady` only re-runs the measure
  }, [fontsReady]);
}

export function KnowledgeMap({ classId, onPractise, className = '' }: KnowledgeMapProps) {
  const knowledge = useClassKnowledge(classId);
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const measure = useLabelMeasure();
  const data = knowledge.data;
  const concepts = data?.concepts ?? [];

  useEffect(() => {
    const box = boxRef.current;

    if (!box) return;
    const observer = new ResizeObserver(() => setWidth(box.clientWidth));

    observer.observe(box);
    setWidth(box.clientWidth);

    return () => observer.disconnect();
  }, [concepts.length > 0]);

  useEffect(() => setPicked(null), [classId]);

  const diagram = useMemo(
    () => (data && width > 0 ? layoutKnowledge(data, width, measure) : null),
    [data, width, measure],
  );
  const byId = useMemo(() => new Map(concepts.map((c) => [c.id, c])), [concepts]);
  const paint = useMemo<GraphPaint>(() => {
    const links = new Set((data?.edges ?? []).filter((e) => e.kind === 'linked').flatMap((e) => [`${e.from}|${e.to}`, `${e.to}|${e.from}`]));

    return {
      node: (id) => NODE_TONE[strengthLevel(byId.get(id)?.strength ?? null)],
      edge: (from, to) => (links.has(`${from}|${to}`) ? 'note' : undefined),
    };
  }, [data, byId]);
  const selected = useMemo(() => new Set(picked ? [picked] : []), [picked]);
  const chosen = picked ? byId.get(picked) : undefined;

  // An older server without this page's data: say nothing rather than show an error for a section it never had.
  if (knowledge.error && !data) return null;

  return (
    <section className={className}>
      <SectionTitle count={concepts.length || undefined}>Knowledge map</SectionTitle>
      {knowledge.isLoading && !data && <LoadingRows rows={2} />}
      {data && concepts.length === 0 && (
        <p className='text-st-muted px-1 text-sm'>
          Nothing here yet — add questions or a concept map and this fills in.
        </p>
      )}
      {concepts.length > 0 && (
        <>
          <ul aria-label='Colours' className='text-st-muted mb-2 flex flex-wrap gap-x-3 gap-y-1 px-1 text-xs'>
            {LEVELS.map((level) => (
              <li key={level} className='flex items-center gap-1.5'>
                <span className={`h-3 w-3 rounded-sm border-[1.5px] ${KEY_SWATCH[level]}`} />
                {STRENGTH_WORD[level]}
              </li>
            ))}
          </ul>
          <div ref={boxRef} className='w-full'>
            {diagram && (
              <svg
                aria-label='Knowledge map'
                className='block select-none [&_[data-node]]:cursor-pointer'
                height={diagram.height}
                role='img'
                viewBox={`0 0 ${width} ${diagram.height}`}
                width={width}
                onClick={(event) => {
                  const id = (event.target as Element).closest('[data-node]')?.getAttribute('data-node') ?? null;

                  setPicked((current) => (id === current ? null : id));
                }}
              >
                <ConceptGraphSvg solid diagram={diagram} paint={paint} selected={selected} />
              </svg>
            )}
          </div>
          {chosen ? (
            <ConceptLine all={concepts} concept={chosen} onPractise={onPractise} />
          ) : (
            <p className='text-st-muted mt-1 px-1 text-xs'>Tap a concept to see how it is going.</p>
          )}
        </>
      )}
    </section>
  );
}

function ConceptLine({
  concept,
  all,
  onPractise,
}: {
  concept: KnowledgeConcept;
  all: KnowledgeConcept[];
  onPractise?: (topic: string) => void;
}) {
  const level = strengthLevel(concept.strength);
  const topic = practiseTopic(concept, all);

  return (
    <div aria-live='polite' className='border-st-line mt-1 flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-1 pb-2 pt-2'>
      <p className='text-st-fg min-w-0 flex-1 basis-40 text-sm font-semibold'>{concept.label}</p>
      <Badge tone={BADGE_TONE[level]}>
        {STRENGTH_WORD[level]}
        {concept.strength !== null && ` ${pct(concept.strength)}%`}
      </Badge>
      {concept.attempts > 0 && (
        <span className='text-st-muted text-xs tabular-nums'>
          {concept.attempts} {concept.attempts === 1 ? 'try' : 'tries'}
        </span>
      )}
      {topic && onPractise && (
        <ActionButton className='min-h-9 px-3 text-xs' onClick={() => onPractise(topic)}>
          <Target className='h-3.5 w-3.5' /> Practise this
        </ActionButton>
      )}
    </div>
  );
}
