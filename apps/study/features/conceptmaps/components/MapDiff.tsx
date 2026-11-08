import type { EdgeClass, MapGraph } from '../lib/mapDiff';
import type { GradeVerdict, ReferenceMap } from '../types';
import type { EdgeTone, GraphPaint, NodeTone } from './ConceptGraphSvg';

import { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

import {
  diffMaps,
  edgeKey,
  ghostId,
  locateWrongLink,
  overlayGraph,
  summarizeDiff,
  summarizeExtras,
} from '../lib/mapDiff';
import { formatScore, scoreTone } from '../lib/score';

import { ConceptMapViewer } from './ConceptMapViewer';

import { Badge, FilterChip } from '@/components/ui/primitives';

/**
 * His map against the AI reference: side by side (matching concepts lit in both; tap a node to find
 * it in the other) or one overlay — his map plus ghosts of what the reference has and he does not.
 * A score strip, a legend, and the grader's per-link comments (tap one to zoom onto that link).
 */
export interface MapDiffProps {
  his: MapGraph;
  reference: ReferenceMap;
  promptTerms: string[];
  verdict: GradeVerdict | null;
  /** Her score for this map — shown beside ours, as the authority. */
  herGrade?: { score: number; max: number; source?: string | null } | null;
}

const EDGE_TONE: Record<EdgeClass, EdgeTone> = {
  matched: 'ok',
  labelOff: 'warn',
  missing: 'missing',
  extra: 'extra',
  definition: 'note',
  idea: 'idea',
};

interface Selection {
  /** Overlay / his-side ids (his node, or a ghost). */
  his: string[];
  ref: string[];
  focus: { his: string[]; ref: string[]; nonce: number; pan?: boolean } | null;
}

const NONE: Selection = { his: [], ref: [], focus: null };

export function MapDiff({ his, reference, promptTerms, verdict, herGrade }: MapDiffProps) {
  const [mode, setMode] = useState<'side' | 'overlay'>('side');
  const [selection, setSelection] = useState<Selection>(NONE);
  const diff = useMemo(() => diffMaps(his, reference, promptTerms), [his, reference, promptTerms]);
  const overlay = useMemo(() => overlayGraph(diff), [diff]);
  const hisEdges = useMemo(
    () => his.edges.map((edge) => (edge.label ? { ...edge, label: edge.label } : { from: edge.from, to: edge.to })),
    [his],
  );
  const hisNodes = useMemo(() => his.nodes.map((node) => ({ id: node.id, text: node.label })), [his]);

  const paints = useMemo(() => {
    const nodeTone = new Map<string, NodeTone>();
    const ring = new Set<string>();
    const hisTone = new Map<string, EdgeTone>();
    const refTone = new Map<string, EdgeTone>();

    for (const node of diff.nodes) {
      if (node.cls === 'matched') nodeTone.set(node.id, 'ok');
      else if (node.cls === 'note') nodeTone.set(node.id, 'note');
      else if (node.cls === 'ghost') nodeTone.set(node.id, 'ghost');
      else if (node.cls === 'idea') nodeTone.set(node.id, 'idea');
      if (node.absentTerm) ring.add(node.id);
    }
    for (const edge of diff.edges) {
      hisTone.set(edgeKey(edge.from, edge.to), EDGE_TONE[edge.cls]);
      if (edge.refFrom && edge.refTo) refTone.set(edgeKey(edge.refFrom, edge.refTo), EDGE_TONE[edge.cls]);
    }
    const hisPaint: GraphPaint = {
      node: (id) => nodeTone.get(id),
      ring: (id) => ring.has(id),
      edge: (from, to) => hisTone.get(edgeKey(from, to)),
    };
    const refPaint: GraphPaint = {
      node: (id) => (diff.refToHis.has(id) || diff.covered.has(id) ? 'ok' : undefined),
      ring: (id) => ring.has(ghostId(id)),
      edge: (from, to) => refTone.get(edgeKey(from, to)),
    };

    return { hisPaint, refPaint };
  }, [diff]);

  const hisSelected = useMemo(() => new Set(selection.his), [selection.his]);
  const refSelected = useMemo(() => new Set(selection.ref), [selection.ref]);
  const hisFocus = useMemo(
    () =>
      selection.focus ? { ids: selection.focus.his, nonce: selection.focus.nonce, pan: selection.focus.pan } : null,
    [selection.focus],
  );
  const refFocus = useMemo(
    () =>
      selection.focus ? { ids: selection.focus.ref, nonce: selection.focus.nonce, pan: selection.focus.pan } : null,
    [selection.focus],
  );

  /** A tapped node, on either side: light it and its counterpart. */
  const pick = (side: 'his' | 'ref', id: string | null) => {
    if (!id) return setSelection(NONE);
    const refId = side === 'ref' ? id : (diff.hisToRef.get(id) ?? diff.nodes.find((n) => n.id === id)?.refId ?? null);
    const hisId = side === 'his' ? id : (diff.refToHis.get(id) ?? ghostId(id));

    // Bring the counterpart into view on the other side (same zoom).
    const other = side === 'his' ? { his: [], ref: refId ? [refId] : [] } : { his: [hisId], ref: [] };

    setSelection({ his: [hisId], ref: refId ? [refId] : [], focus: { ...other, nonce: Date.now(), pan: true } });
  };

  const comments = verdict?.wrongLinks ?? [];
  const focusComment = (index: number) => {
    const link = comments[index]!;
    const at = locateWrongLink(his, link);

    if (!at) return;
    const refFrom = diff.hisToRef.get(at.from);
    const refTo = diff.hisToRef.get(at.to);
    const refIds = [refFrom, refTo].filter((id): id is string => Boolean(id));

    setSelection({
      his: [at.from, at.to, edgeKey(at.from, at.to), edgeKey(at.to, at.from)],
      ref: refFrom && refTo ? [...refIds, edgeKey(refFrom, refTo), edgeKey(refTo, refFrom)] : refIds,
      focus: { his: [at.from, at.to], ref: refIds, nonce: Date.now() },
    });
  };

  const { counts } = diff;
  const extras = summarizeExtras(counts);

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <FilterChip active={mode === 'side'} onClick={() => setMode('side')}>
          Side by side
        </FilterChip>
        <FilterChip active={mode === 'overlay'} onClick={() => setMode('overlay')}>
          Overlay
        </FilterChip>
      </div>

      <div className='flex flex-col gap-1'>
        <div className='flex flex-wrap items-center gap-2'>
          <p aria-live='polite' className='text-st-fg text-sm font-medium'>
            {summarizeDiff(counts)}
          </p>
          {herGrade && (
            <Badge tone={scoreTone(herGrade.score, herGrade.max)}>
              Grade {formatScore(herGrade.score, herGrade.max)}
              {herGrade.source ? ` · ${herGrade.source}` : ''}
            </Badge>
          )}
        </div>
        {extras && <p className='text-st-muted text-xs'>{extras}</p>}
      </div>

      <ScoreBar counts={counts} />
      <Legend />

      {diff.absentTerms.length > 0 && (
        <p className='text-st-danger text-sm'>
          Prompt terms not on your map: {diff.absentTerms.join(', ')}
          <span className='text-st-muted'> — ringed in red.</span>
        </p>
      )}

      {comments.length > 0 && (
        <ul className='flex flex-col gap-1.5'>
          {comments.map((link, index) => {
            const located = locateWrongLink(his, link) !== null;

            return (
              <li key={index}>
                <button
                  className='rounded-st border-st-warn/40 bg-st-warn/5 hover:bg-st-warn/10 disabled:hover:bg-st-warn/5 flex w-full items-start gap-2 border px-3 py-2 text-left text-sm'
                  disabled={!located}
                  type='button'
                  onClick={() => focusComment(index)}
                >
                  <AlertTriangle className='text-st-warn mt-0.5 h-4 w-4 shrink-0' />
                  <span className='text-st-fg'>
                    <span className='font-medium'>
                      {link.from} → {link.label ? <em className='font-normal'>{link.label}</em> : 'no label'} →{' '}
                      {link.to}
                    </span>
                    <span className='text-st-muted'> — {link.why}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {mode === 'side' ? (
        <div className='grid grid-cols-1 gap-3 xl:grid-cols-2'>
          <section className='flex min-w-0 flex-col gap-1.5'>
            <h4 className='text-st-muted text-xs font-medium uppercase tracking-wide'>Your map</h4>
            <ConceptMapViewer
              edges={hisEdges}
              focus={hisFocus}
              nodes={hisNodes}
              paint={paints.hisPaint}
              selected={hisSelected}
              title='Your map'
              onNodeTap={(id) => pick('his', id)}
            />
          </section>
          <section className='flex min-w-0 flex-col gap-1.5'>
            <h4 className='text-st-muted text-xs font-medium uppercase tracking-wide'>AI reference</h4>
            <ConceptMapViewer
              edges={reference.edges}
              focus={refFocus}
              nodes={reference.nodes}
              paint={paints.refPaint}
              selected={refSelected}
              title='AI reference'
              onNodeTap={(id) => pick('ref', id)}
            />
          </section>
        </div>
      ) : (
        <ConceptMapViewer
          edges={overlay.edges}
          focus={hisFocus}
          nodes={overlay.nodes}
          paint={paints.hisPaint}
          selected={hisSelected}
          title='Your map + what the reference adds'
          onNodeTap={(id) => pick('his', id)}
        />
      )}
    </div>
  );
}

function ScoreBar({ counts }: { counts: ReturnType<typeof diffMaps>['counts'] }) {
  const total = Math.max(1, counts.core);
  const parts = [
    { n: counts.matched, className: 'bg-st-ok', label: 'matched' },
    { n: counts.needLabel + counts.reworded + counts.defDiffers, className: 'bg-st-warn', label: 'label off' },
    { n: counts.coreMissing, className: 'bg-st-danger/70', label: 'missing' },
  ];

  return (
    <div
      aria-label={parts.map((part) => `${part.n} ${part.label}`).join(', ')}
      className='bg-st-raised flex h-2 overflow-hidden rounded-full'
      role='img'
    >
      {parts.map((part) =>
        part.n > 0 ? (
          <div key={part.label} className={part.className} style={{ width: `${(part.n / total) * 100}%` }} />
        ) : null,
      )}
    </div>
  );
}

const LEGEND_LINKS: { label: string; stroke: string; dash?: string }[] = [
  { label: 'Matched', stroke: 'stroke-st-ok' },
  { label: 'Label off', stroke: 'stroke-st-warn' },
  { label: 'Core missing', stroke: 'stroke-st-danger', dash: '5 3' },
  { label: 'Extra (yours only)', stroke: 'stroke-st-accent' },
  { label: 'Could add', stroke: 'stroke-st-muted/60', dash: '3 4' },
  { label: 'Definition', stroke: 'stroke-st-muted', dash: '2 3' },
];

function Legend() {
  return (
    <ul className='text-st-muted flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs'>
      {LEGEND_LINKS.map((item) => (
        <li key={item.label} className='flex items-center gap-1.5'>
          <svg aria-hidden className='h-2 w-6' viewBox='0 0 24 8'>
            <line className={item.stroke} strokeDasharray={item.dash} strokeWidth={2.5} x1={1} x2={23} y1={4} y2={4} />
          </svg>
          {item.label}
        </li>
      ))}
      <li className='flex items-center gap-1.5'>
        <span className='border-st-ok bg-st-ok/10 h-3.5 w-5 rounded border-2' />
        In both
      </li>
      <li className='flex items-center gap-1.5'>
        <span className='border-st-danger/80 h-3.5 w-5 rounded border border-dashed' />
        Missing concept
      </li>
      <li className='flex items-center gap-1.5'>
        <span className='border-st-danger h-3.5 w-5 rounded-md border-2' />
        Prompt term left out
      </li>
    </ul>
  );
}
