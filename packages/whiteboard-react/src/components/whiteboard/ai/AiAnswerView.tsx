import React, { useEffect, useMemo, useState } from 'react';
import { CircleCheck, CircleX, Info, TriangleAlert } from 'lucide-react';

import { choiceLetters } from './markdownBlocks';
import { layoutFromBoxes, layoutGraph } from './graphLayout';
import { splitInlineMath } from './latexText';
import { parseMermaidFlowchart } from './mermaidFlow';
import { BOARD_TEXT_FONT, loadKatex, renderKatexHtml } from './rasterize';
import { withLevels } from './conceptMap';
import { INLINE_TONE_RE, parseTone } from './tones';

import type { BoardAiBlock, BoardAiTone, ConceptMap, ConceptMapStyle } from './types';
import type { WbStringKey } from '../../../i18n/strings';
import { useWbStrings } from '../../../i18n/context';

/**
 * Renders AI blocks in the panel: RTL text, KaTeX math kept LTR, tables, MCQ cards (answer behind a
 * tap — the board is often on a projector), and diagrams / concept maps as a live SVG preview of the
 * exact layout that will be inserted.
 */

type Katex = Awaited<ReturnType<typeof loadKatex>>;

export function useKatex(): Katex {
  const [katex, setKatex] = useState<Katex>(null);

  useEffect(() => {
    let alive = true;

    void loadKatex().then((module) => {
      if (alive) setKatex(module);
    });

    return () => {
      alive = false;
    };
  }, []);

  return katex;
}

const BOLD_RE = /\*\*(.+?)\*\*/g;

/**
 * Semantic tints (tones.ts): flat soft fill + a start-edge accent in the tone's colour, the label in
 * its readable text token. Theme-aware tokens, so light and dark both read; body text stays ink.
 */
const TONE_STYLE: Record<BoardAiTone, { box: string; text: string; label: WbStringKey; Icon: typeof Info }> = {
  success: { box: 'bg-sk-green-soft border-sk-green', text: 'text-sk-green', label: 'ai.tone.success', Icon: CircleCheck },
  wrong: { box: 'bg-sk-red-soft border-sk-red', text: 'text-sk-red', label: 'ai.tone.wrong', Icon: CircleX },
  warning: { box: 'bg-sk-amber-soft border-sk-amber', text: 'text-sk-amber', label: 'ai.tone.warning', Icon: TriangleAlert },
  info: { box: 'bg-sk-blue-soft border-sk-blue', text: 'text-sk-blue', label: 'ai.tone.info', Icon: Info },
};

function TextRun({ text }: { text: string }) {
  // `:wrong[short phrase]` → a coloured span; anything else as typed (bold inside each part).
  const parts: React.ReactNode[] = [];
  let last = 0;
  const spans = new RegExp(INLINE_TONE_RE.source, 'gi');
  let match: RegExpExecArray | null;

  while ((match = spans.exec(text)) !== null) {
    const tone = parseTone(match[1]);
    const at = match.index;

    if (!tone) continue;
    if (at > last) parts.push(<BoldRun key={`t${last}`} text={text.slice(last, at)} />);
    parts.push(
      <span key={`s${at}`} className={`${TONE_STYLE[tone].text} font-semibold`}>
        <BoldRun text={match[2] ?? ''} />
      </span>,
    );
    last = at + match[0].length;
  }

  if (last === 0) return <BoldRun text={text} />;
  if (last < text.length) parts.push(<BoldRun key={`t${last}`} text={text.slice(last)} />);

  return <>{parts}</>;
}

function BoldRun({ text }: { text: string }) {
  // **bold** only — the answer's other inline markdown is rare enough to show as typed.
  const parts: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;

  BOLD_RE.lastIndex = 0;

  while ((match = BOLD_RE.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(<strong key={match.index}>{match[1]}</strong>);
    last = match.index + match[0].length;
  }

  if (last < text.length) parts.push(text.slice(last));

  return <>{parts}</>;
}

export function InlineMarkdown({ text, katex }: { text: string; katex: Katex }) {
  return (
    <>
      {splitInlineMath(text).map((part, index) => {
        if (part.kind === 'text') return <TextRun key={index} text={part.value} />;

        const html = renderKatexHtml(katex, part.value, false);

        return html ? (
          <span key={index} dangerouslySetInnerHTML={{ __html: html }} className='wb-ai-ltr inline-block align-middle' dir='ltr' />
        ) : (
          <code key={index} className='wb-ai-ltr bg-ink/5 rounded px-1 text-[0.92em]' dir='ltr'>
            {part.value}
          </code>
        );
      })}
    </>
  );
}

function MathBlock({ tex, katex }: { tex: string; katex: Katex }) {
  const html = renderKatexHtml(katex, tex, true);

  return html ? (
    <div dangerouslySetInnerHTML={{ __html: html }} className='wb-ai-ltr wb-ai-math-block my-1' dir='ltr' />
  ) : (
    <pre className='wb-ai-ltr bg-ink/5 overflow-x-auto rounded-lg p-2 text-xs' dir='ltr'>
      {tex}
    </pre>
  );
}

function QuestionCard({ block, katex, index }: { block: Extract<BoardAiBlock, { type: 'question' }>; katex: Katex; index: number }) {
  const { t } = useWbStrings();
  const [reveal, setReveal] = useState(false);
  const hasAnswer = block.answerIndex !== undefined || Boolean(block.answer) || Boolean(block.explanation);

  return (
    <div className='border-ink/15 bg-paper rounded-xl border p-3'>
      <p className='text-ink text-sm font-bold leading-6'>
        <span className='text-ink/50 me-1'>{t('ai.qPrefix', { n: index + 1 })}</span>
        <InlineMarkdown katex={katex} text={block.stem} />
      </p>
      {block.choices?.length ? (
        <ol className='mt-1.5 space-y-1'>
          {block.choices.map((choice, choiceIndex) => (
            <li
              key={choiceIndex}
              className={`rounded-lg px-2 py-1 text-sm leading-6 ${
                reveal && block.answerIndex === choiceIndex ? 'bg-citrine font-semibold' : ''
              }`}
            >
              <span className='text-ink/60 me-1'>{choiceLetters()[choiceIndex] ?? choiceIndex + 1})</span>
              <InlineMarkdown katex={katex} text={choice} />
            </li>
          ))}
        </ol>
      ) : null}
      {hasAnswer ? (
        <div className='mt-2'>
          <button
            className='text-ink/70 hover:text-ink text-xs font-semibold underline underline-offset-4'
            type='button'
            onClick={() => setReveal((value) => !value)}
          >
            {reveal ? t('ai.answer.hide') : t('ai.answer.show')}
          </button>
          {reveal ? (
            <div className='text-ink mt-1 space-y-1 text-sm leading-6'>
              {block.answer ? (
                <p>
                  <strong>{t('ai.answer')} </strong>
                  <InlineMarkdown katex={katex} text={block.answer} />
                </p>
              ) : null}
              {block.explanation ? (
                <p className='text-ink/75'>
                  <InlineMarkdown katex={katex} text={block.explanation} />
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

let measureContext: CanvasRenderingContext2D | null = null;

function measureText(text: string, fontPx: number, bold = false): number {
  if (typeof document === 'undefined') return text.length * fontPx * 0.55;

  measureContext ??= document.createElement('canvas').getContext('2d');

  if (!measureContext) return text.length * fontPx * 0.55;

  measureContext.font = `${bold ? 700 : 400} ${fontPx}px ${BOARD_TEXT_FONT}`;

  return measureContext.measureText(text).width;
}

/** The inserted layout, drawn as SVG at a fixed scale — what the teacher sees is what lands. */
export function GraphPreview({ map, style, maxHeight = 260 }: { map: ConceptMap; style?: ConceptMapStyle | null; maxHeight?: number }) {
  const { t } = useWbStrings();
  const model = useMemo(() => {
    const leveled = withLevels(map);
    const font = 14;
    const nodes = leveled.nodes.map((node) => {
      const text = node.text.replace(/\$([^$]+)\$/g, '$1');
      const width = Math.min(150, measureText(text, font, node.level === 0) + 4);
      const lines = Math.max(1, Math.ceil((measureText(text, font) + 4) / 150));
      const shape = node.shape ?? style?.shape ?? 'rounded';
      const textHeight = lines * font * 1.25;
      const [w, h] = shape === 'ellipse' ? [width * 1.42 + 12, textHeight * 1.42 + 8] : shape === 'diamond' ? [width * 1.9 + 12, textHeight * 1.9 + 8] : [width + 22, textHeight + 14];
      const palette = style?.nodeColors?.length ? style.nodeColors : ['#18204a'];

      return { ...node, text, w, h, shape, color: node.color ?? palette[(node.level ?? 0) % palette.length] ?? '#18204a' };
    });
    // Same rule as the board: a server-laid-out map keeps its boxes unless they collide.
    const given = map.serverLayout
      ? layoutFromBoxes(
          nodes.map((node) => ({ id: node.id, width: node.w, height: node.h, level: node.level, bbox: node.bbox })),
          leveled.edges,
          { width: 960, height: 640 },
        )
      : null;
    const layout =
      given ??
      layoutGraph(
        nodes.map((node) => ({ id: node.id, width: node.w, height: node.h, level: node.level })),
        leveled.edges,
        { direction: style?.direction ?? map.direction ?? 'tb', levelGap: 44, siblingGap: 18 },
      );

    return { nodes, layout, edges: leveled.edges };
  }, [map, style]);
  const { bounds } = model.layout;
  const pad = 8;
  const edgeColor = style?.edgeColor ?? '#18204a';

  return (
    <svg
      aria-label={t('ai.diagramPreview')}
      className='bg-paper w-full rounded-xl border border-black/10'
      role='img'
      style={{ maxHeight }}
      viewBox={`${bounds.left - pad} ${bounds.top - pad} ${bounds.width + pad * 2} ${bounds.height + pad * 2}`}
    >
      <defs>
        <marker id='wb-ai-arrow' markerHeight='8' markerWidth='8' orient='auto-start-reverse' refX='7' refY='4'>
          <path d='M0,0 L8,4 L0,8 z' fill={edgeColor} />
        </marker>
      </defs>
      {model.edges.map((edge, index) => {
        const a = model.layout.nodes.get(edge.from);
        const b = model.layout.nodes.get(edge.to);

        if (!a || !b) return null;

        return (
          <g key={index}>
            <line
              markerEnd={edge.arrow === 'none' ? undefined : 'url(#wb-ai-arrow)'}
              markerStart={edge.arrow === 'both' ? 'url(#wb-ai-arrow)' : undefined}
              stroke={edgeColor}
              strokeWidth={1.6}
              x1={a.x}
              x2={b.x - (b.x - a.x) * (b.width / 2 / Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)))}
              y1={a.y}
              y2={b.y - (b.y - a.y) * (b.height / 2 / Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)))}
            />
            {edge.label ? (
              <text fill={edgeColor} fontFamily={BOARD_TEXT_FONT} fontSize={11} textAnchor='middle' x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 3}>
                {edge.label}
              </text>
            ) : null}
          </g>
        );
      })}
      {model.nodes.map((node) => {
        const placed = model.layout.nodes.get(node.id);

        if (!placed) return null;

        const { x, y } = placed;

        return (
          <g key={node.id}>
            {node.shape === 'ellipse' ? (
              <ellipse cx={x} cy={y} fill='#fbfaf6' rx={node.w / 2} ry={node.h / 2} stroke={node.color} strokeWidth={1.8} />
            ) : node.shape === 'diamond' ? (
              <polygon
                fill='#fbfaf6'
                points={`${x},${y - node.h / 2} ${x + node.w / 2},${y} ${x},${y + node.h / 2} ${x - node.w / 2},${y}`}
                stroke={node.color}
                strokeWidth={1.8}
              />
            ) : node.shape === 'none' ? null : (
              <rect
                fill='#fbfaf6'
                height={node.h}
                rx={node.shape === 'rounded' ? 10 : 2}
                stroke={node.color}
                strokeWidth={1.8}
                width={node.w}
                x={x - node.w / 2}
                y={y - node.h / 2}
              />
            )}
            <text
              dominantBaseline='central'
              fill={node.color}
              fontFamily={BOARD_TEXT_FONT}
              fontSize={14}
              fontWeight={node.level === 0 ? 700 : 400}
              textAnchor='middle'
              x={x}
              y={y}
            >
              {node.text.length > 28 ? `${node.text.slice(0, 27)}…` : node.text}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** A run of blocks that share a tone, drawn as one tinted callout. */
function ToneCallout({ tone, children }: { tone: BoardAiTone; children: React.ReactNode }) {
  const { t } = useWbStrings();
  const style = TONE_STYLE[tone];

  return (
    <div className={`text-ink space-y-1.5 rounded-lg border-s-4 px-2.5 py-1.5 ${style.box}`} data-tone={tone}>
      <p className={`flex items-center gap-1 text-xs font-bold ${style.text}`}>
        <style.Icon aria-hidden className='h-3.5 w-3.5' />
        {t(style.label)}
      </p>
      {children}
    </div>
  );
}

export function AiAnswerView({ blocks }: { blocks: BoardAiBlock[] }) {
  const { dir } = useWbStrings();
  const katex = useKatex();
  let questionIndex = -1;
  // Consecutive blocks with the same tone share one callout.
  const groups: Array<{ tone?: BoardAiTone; start: number; items: BoardAiBlock[] }> = [];

  blocks.forEach((block, index) => {
    const previous = groups[groups.length - 1];

    if (previous && previous.tone && previous.tone === block.tone) previous.items.push(block);
    else groups.push({ tone: block.tone, start: index, items: [block] });
  });

  const renderBlock = (block: BoardAiBlock, index: number) => {
        switch (block.type) {
          case 'heading':
            return (
              <p key={index} className={`font-bold ${block.level && block.level >= 3 ? 'text-sm' : 'text-base'}`}>
                <InlineMarkdown katex={katex} text={block.text} />
              </p>
            );
          case 'paragraph':
            return (
              <p key={index} className='whitespace-pre-line'>
                <InlineMarkdown katex={katex} text={block.text} />
              </p>
            );
          case 'math':
            return <MathBlock key={index} katex={katex} tex={block.text} />;
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul';

            return (
              <Tag key={index} className={`space-y-0.5 ps-5 ${block.ordered ? 'list-decimal' : 'list-disc'}`}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    <InlineMarkdown katex={katex} text={item} />
                  </li>
                ))}
              </Tag>
            );
          }
          case 'table':
            return (
              <div key={index} className='overflow-x-auto'>
                <table className='border-ink/20 w-full border-collapse border text-xs'>
                  <thead>
                    <tr className='bg-ink/5'>
                      {block.header.map((cell, cellIndex) => (
                        <th key={cellIndex} className='border-ink/20 border px-2 py-1 text-start font-bold'>
                          <InlineMarkdown katex={katex} text={cell} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => (
                          <td key={cellIndex} className='border-ink/20 border px-2 py-1 align-top'>
                            <InlineMarkdown katex={katex} text={cell} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'question':
            questionIndex += 1;

            return <QuestionCard key={index} block={block} index={questionIndex} katex={katex} />;
          case 'diagram': {
            const graph = parseMermaidFlowchart(block.mermaid);

            return graph ? (
              <GraphPreview key={index} map={graph} />
            ) : (
              <pre key={index} className='wb-ai-ltr bg-ink/5 overflow-x-auto rounded-lg p-2 text-xs' dir='ltr'>
                {block.mermaid}
              </pre>
            );
          }
          case 'image':
            return block.labels?.length ? (
              // The labels the board will write, previewed where they go (the picture itself has no text).
              <div key={index} className='relative'>
                <img alt={block.alt ?? ''} className='w-full rounded-xl border border-black/10' src={block.src} />
                {block.labels.map((label, labelIndex) => (
                  <span
                    key={labelIndex}
                    className='absolute -translate-x-1/2 -translate-y-1/2 rounded bg-white/85 px-1 text-[11px] font-medium leading-tight text-[#18204a]'
                    style={{ left: `${label.anchor.x * 100}%`, top: `${label.anchor.y * 100}%`, fontFamily: BOARD_TEXT_FONT }}
                  >
                    {label.text}
                  </span>
                ))}
              </div>
            ) : (
              <img key={index} alt={block.alt ?? ''} className='w-full rounded-xl border border-black/10' src={block.src} />
            );
          default:
            return null;
        }
  };

  return (
    <div className='text-ink space-y-2 text-sm leading-7' dir={dir}>
      {groups.map((group) =>
        group.tone ? (
          <ToneCallout key={group.start} tone={group.tone}>
            {group.items.map((block, offset) => renderBlock(block, group.start + offset))}
          </ToneCallout>
        ) : (
          renderBlock(group.items[0]!, group.start)
        ),
      )}
    </div>
  );
}
