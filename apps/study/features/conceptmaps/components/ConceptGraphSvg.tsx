import type { Diagram } from '../lib/diagram';

import { branchesOf, edgeBranch } from '@repo/whiteboard-react/concept-layout';
import { useId, useMemo } from 'react';

/**
 * The drawing of a laid-out concept graph (`layoutDiagram`): edges first, their label chips on the
 * line, then the boxes. Roots get the accent fill; `highlight` (the prompt terms) an accent border.
 * `paint` overrides per node / link for the map diff (matched, ghost, missing…); `selected` rings
 * nodes and thickens links. Pure SVG content — `ConceptMapViewer` owns the viewBox, zoom and pan.
 */
export type NodeTone = 'ok' | 'warn' | 'missing' | 'note' | 'ghost' | 'idea';
export type EdgeTone = 'ok' | 'warn' | 'missing' | 'extra' | 'note' | 'idea';

export interface GraphPaint {
  node?: (id: string) => NodeTone | undefined;
  /** Prompt term he left out: a red ring around the box. */
  ring?: (id: string) => boolean;
  edge?: (from: string, to: string) => EdgeTone | undefined;
}

export interface ConceptGraphSvgProps {
  diagram: Diagram;
  highlight?: Set<string>;
  paint?: GraphPaint;
  /** Node ids and `edgeKey(from, to)` keys drawn as selected. */
  selected?: Set<string>;
  /** Paint the page colour under every box, so a line that runs behind a tinted box does not show through it. */
  solid?: boolean;
}

const EDGE_STROKE: Record<EdgeTone | 'default', string> = {
  default: 'stroke-st-muted',
  ok: 'stroke-st-ok',
  warn: 'stroke-st-warn',
  missing: 'stroke-st-danger',
  extra: 'stroke-st-accent',
  note: 'stroke-st-muted/60',
  idea: 'stroke-st-muted/45',
};
const EDGE_FILL: Record<EdgeTone | 'default', string> = {
  default: 'fill-st-muted',
  ok: 'fill-st-ok',
  warn: 'fill-st-warn',
  missing: 'fill-st-danger',
  extra: 'fill-st-accent',
  note: 'fill-st-muted/60',
  idea: 'fill-st-muted/45',
};
const LABEL_TEXT: Record<EdgeTone | 'default', string> = {
  default: 'fill-st-muted',
  ok: 'fill-st-ok',
  warn: 'fill-st-warn',
  missing: 'fill-st-danger',
  extra: 'fill-st-accent',
  note: 'fill-st-muted',
  idea: 'fill-st-muted/80',
};
const NODE_BOX: Record<NodeTone, string> = {
  ok: 'fill-st-ok/10 stroke-st-ok',
  warn: 'fill-st-warn/10 stroke-st-warn',
  missing: 'fill-st-danger/10 stroke-st-danger',
  note: 'fill-st-bg stroke-st-line',
  ghost: 'fill-st-bg stroke-st-danger/80',
  idea: 'fill-st-bg stroke-st-line',
};

const key = (from: string, to: string) => `${from}→${to}`;

const BRANCH_HUES = 6;
/** The ink variable (globals.css) of a branch: -1 = the root / title ink; `muted` = a link phrase's. */
const inkVar = (branch: number, muted = false) =>
  `var(--cm-${branch < 0 ? 'root' : `b${branch % BRANCH_HUES}`}${muted ? '-m' : ''})`;

export function ConceptGraphSvg({ diagram, highlight, paint, selected, solid }: ConceptGraphSvgProps) {
  const prefix = `cm-${useId().replace(/:/g, '')}`;
  const opt = diagram.options;
  const tones = Object.keys(EDGE_FILL) as (EdgeTone | 'default')[];
  const edgeTone = (from: string, to: string) => paint?.edge?.(from, to) ?? 'default';
  // Ink by meaning on a plain map (the diff keeps its own tones): a hue per top-level branch.
  const branchOf = useMemo(() => branchesOf({ nodes: diagram.nodes, edges: diagram.edges }), [diagram]);
  const inked = (from: string, to: string) => !paint && edgeTone(from, to) === 'default';
  const hue = (branch: number) => (branch < 0 ? -1 : branch % BRANCH_HUES);
  const inkOf = (from: string, to: string) => hue(edgeBranch(branchOf, from, to));

  return (
    <>
      <defs>
        {tones.map((tone) => (
          <marker
            key={tone}
            id={`${prefix}-${tone}`}
            markerHeight='10'
            markerUnits='userSpaceOnUse'
            markerWidth='10'
            orient='auto'
            refX='9'
            refY='5'
          >
            <path className={EDGE_FILL[tone]} d='M0,0 L10,5 L0,10 z' />
          </marker>
        ))}
        {!paint &&
          Array.from({ length: BRANCH_HUES + 1 }, (_, i) => i - 1).map((branch) => (
            <marker
              key={branch}
              id={`${prefix}-b${branch}`}
              markerHeight='10'
              markerUnits='userSpaceOnUse'
              markerWidth='10'
              orient='auto'
              refX='9'
              refY='5'
            >
              <path d='M0,0 L10,5 L0,10 z' fill={inkVar(branch)} />
            </marker>
          ))}
      </defs>
      <g fill='none'>
        {diagram.edges.map((edge, index) => {
          const tone = edgeTone(edge.from, edge.to);
          const on = selected?.has(key(edge.from, edge.to));
          const branch = inkOf(edge.from, edge.to);
          const colored = inked(edge.from, edge.to);

          return (
            <path
              key={`${edge.from}-${edge.to}-${index}`}
              className={colored ? undefined : EDGE_STROKE[tone]}
              d={edge.path}
              markerEnd={`url(#${prefix}-${colored ? `b${branch}` : tone})`}
              style={colored ? { stroke: inkVar(branch) } : undefined}
              strokeDasharray={
                tone === 'missing' ? '7 5' : tone === 'idea' ? '4 5' : tone === 'note' ? '2 4' : undefined
              }
              strokeLinecap='round'
              strokeWidth={on ? 3.5 : tone === 'default' || tone === 'note' || tone === 'idea' ? 1.5 : 2}
            />
          );
        })}
      </g>
      {diagram.edges.map((edge, index) => {
        if (!edge.labelBox) return null;
        const tone = edgeTone(edge.from, edge.to);
        const on = selected?.has(key(edge.from, edge.to));

        return (
          <g key={`label-${index}`}>
            <rect
              className={on ? 'fill-st-raised stroke-st-fg' : 'fill-st-bg'}
              height={edge.labelBox.h}
              rx={6}
              strokeWidth={on ? 1.5 : 0}
              width={edge.labelBox.w}
              x={edge.labelBox.x}
              y={edge.labelBox.y}
            />
            <text
              className={inked(edge.from, edge.to) ? undefined : LABEL_TEXT[tone]}
              fontSize={opt.labelFontSize}
              fontStyle='italic'
              style={inked(edge.from, edge.to) ? { fill: inkVar(inkOf(edge.from, edge.to), true) } : undefined}
              textAnchor='middle'
            >
              {edge.labelLines.map((line, i) => (
                <tspan
                  key={i}
                  x={edge.labelBox!.x + edge.labelBox!.w / 2}
                  y={
                    edge.labelBox!.y +
                    edge.labelBox!.h / 2 +
                    (i - (edge.labelLines.length - 1) / 2) * opt.labelLineHeight +
                    opt.labelFontSize * 0.35
                  }
                >
                  {line}
                </tspan>
              ))}
            </text>
          </g>
        );
      })}
      {diagram.nodes.map((node) => {
        const tone = paint?.node?.(node.id);
        const hot = highlight?.has(node.id);
        const on = selected?.has(node.id);
        const inkedBox = !tone && !paint && !hot;
        const box = tone
          ? NODE_BOX[tone]
          : inkedBox
            ? 'fill-st-raised'
            : hot
              ? 'fill-st-raised stroke-st-accent/70'
              : 'fill-st-raised stroke-st-line';
        const faint = tone === 'ghost' || tone === 'note' || tone === 'idea';

        return (
          <g key={node.id} data-node={node.id}>
            {on && (
              <rect
                className='stroke-st-fg fill-none'
                height={node.h + 10}
                rx={14}
                strokeWidth={2.5}
                width={node.w + 10}
                x={node.x - 5}
                y={node.y - 5}
              />
            )}
            {paint?.ring?.(node.id) && (
              <rect
                className='stroke-st-danger fill-none'
                height={node.h + (on ? 18 : 8)}
                rx={on ? 18 : 13}
                strokeWidth={2}
                width={node.w + (on ? 18 : 8)}
                x={node.x - (on ? 9 : 4)}
                y={node.y - (on ? 9 : 4)}
              />
            )}
            {solid && <rect className='fill-st-bg' height={node.h} rx={10} width={node.w} x={node.x} y={node.y} />}
            <rect
              className={box}
              height={node.h}
              rx={10}
              strokeDasharray={tone === 'ghost' || tone === 'idea' ? '6 4' : tone === 'note' ? '3 3' : undefined}
              strokeWidth={(node.root && !paint) || (tone && !faint) ? 2 : 1.5}
              style={inkedBox ? { stroke: inkVar(hue(branchOf(node.id))) } : undefined}
              width={node.w}
              x={node.x}
              y={node.y}
            />
            <text
              className={faint ? 'fill-st-muted' : 'fill-st-fg'}
              fontSize={opt.fontSize}
              fontStyle={tone === 'note' ? 'italic' : undefined}
              fontWeight={faint ? 400 : (node.root && !paint) || hot || tone ? 600 : 500}
              textAnchor='middle'
            >
              {node.lines.map((line, i) => (
                <tspan
                  key={i}
                  x={node.x + node.w / 2}
                  y={node.y + node.h / 2 + (i - (node.lines.length - 1) / 2) * opt.lineHeight + opt.fontSize * 0.35}
                >
                  {line}
                </tspan>
              ))}
            </text>
          </g>
        );
      })}
    </>
  );
}
