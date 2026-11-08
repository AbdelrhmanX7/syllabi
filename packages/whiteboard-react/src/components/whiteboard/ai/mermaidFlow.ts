import type { ConceptEdgeArrow, ConceptMap, ConceptMapDirection, ConceptMapEdge, ConceptMapNode, ConceptNodeShape } from './types';

/**
 * A small reader for the mermaid FLOWCHART subset (`flowchart TD` / `graph LR` …) — the diagram kind
 * the board asks the model for. It turns the source into the same graph a concept map is, so one
 * layout and one object builder draw both, and the result lands on the board as editable shapes +
 * text + arrows instead of a flat picture (the mermaid source rides along on the objects).
 *
 * Deliberately not the mermaid library: ~3 MB for a feature that needs boxes and arrows, and its SVG
 * output needs foreignObject + webfonts to rasterise. Unsupported statements (style, classDef,
 * click, linkStyle, subgraph frames) are skipped, never fatal.
 */

export interface FlowGraph extends ConceptMap {
  direction: ConceptMapDirection;
  nodes: ConceptMapNode[];
  edges: ConceptMapEdge[];
}

const HEADER_RE = /^\s*(?:flowchart|graph)\s*(TD|TB|BT|LR|RL)?\s*;?\s*$/i;

/** Node shapes, most specific first. Each captures (id, text). */
const NODE_PATTERNS: Array<{ re: RegExp; shape: ConceptNodeShape }> = [
  // Quoted labels first (the backend writes A["…"]): a quote may hide ] ) } that end the bare forms.
  { re: /^([A-Za-z0-9_]+)\s*\(\(\s*"([^"]*)"\s*\)\)/, shape: 'ellipse' },
  { re: /^([A-Za-z0-9_]+)\s*\(\[\s*"([^"]*)"\s*\]\)/, shape: 'rounded' },
  { re: /^([A-Za-z0-9_]+)\s*\[\[\s*"([^"]*)"\s*\]\]/, shape: 'rect' },
  { re: /^([A-Za-z0-9_]+)\s*\{\{\s*"([^"]*)"\s*\}\}/, shape: 'diamond' },
  { re: /^([A-Za-z0-9_]+)\s*\[\s*"([^"]*)"\s*\]/, shape: 'rect' },
  { re: /^([A-Za-z0-9_]+)\s*\(\s*"([^"]*)"\s*\)/, shape: 'rounded' },
  { re: /^([A-Za-z0-9_]+)\s*\{\s*"([^"]*)"\s*\}/, shape: 'diamond' },
  { re: /^([A-Za-z0-9_]+)\s*\(\(\s*([\s\S]*?)\s*\)\)/, shape: 'ellipse' },
  { re: /^([A-Za-z0-9_]+)\s*\(\[\s*([\s\S]*?)\s*\]\)/, shape: 'rounded' },
  { re: /^([A-Za-z0-9_]+)\s*\[\[\s*([\s\S]*?)\s*\]\]/, shape: 'rect' },
  { re: /^([A-Za-z0-9_]+)\s*\[\(\s*([\s\S]*?)\s*\)\]/, shape: 'rounded' },
  { re: /^([A-Za-z0-9_]+)\s*\{\{\s*([\s\S]*?)\s*\}\}/, shape: 'diamond' },
  { re: /^([A-Za-z0-9_]+)\s*\[\s*([\s\S]*?)\s*\]/, shape: 'rect' },
  { re: /^([A-Za-z0-9_]+)\s*\(\s*([\s\S]*?)\s*\)/, shape: 'rounded' },
  { re: /^([A-Za-z0-9_]+)\s*\{\s*([\s\S]*?)\s*\}/, shape: 'diamond' },
  { re: /^([A-Za-z0-9_]+)\s*>\s*([\s\S]*?)\s*\]/, shape: 'rect' },
  { re: /^([A-Za-z0-9_]+)/, shape: 'rect' },
];

/** `-- text -->` / `-. text .->` / `== text ==>` (text between the two halves of the operator). */
const INLINE_EDGE_RE = /^(<)?(?:--|==|-\.)\s*([^\-=.>|\s][^>|]*?)\s*(?:-{2,}|={2,}|\.+-)(>|x|o)?/;
/** `-->`, `---`, `-.->`, `==>`, `--x`, `<-->`. */
const PLAIN_EDGE_RE = /^(<)?(?:-{2,}|={2,}|-\.+-?)(>|x|o)?/;
const PIPE_LABEL_RE = /^\s*\|\s*(?:"([^"]*)"|([^|]*))\s*\|/;

/** Reads one edge operator at the start of `text`. */
function readEdge(text: string): { arrow: ConceptEdgeArrow; label: string; length: number } | null {
  const inline = text.match(INLINE_EDGE_RE);
  const match = inline ?? text.match(PLAIN_EDGE_RE);

  if (!match) return null;

  const head = inline ? inline[3] : match[2];
  const both = Boolean(match[1]) && head === '>';
  let label = inline ? cleanLabel(inline[2] ?? '') : '';
  let length = match[0].length;
  const pipe = text.slice(length).match(PIPE_LABEL_RE);

  if (pipe) {
    label = cleanLabel(pipe[1] ?? pipe[2] ?? '') || label;
    length += pipe[0].length;
  }

  return { arrow: both ? 'both' : head === '>' ? 'end' : 'none', label, length };
}

function cleanLabel(text: string): string {
  return text
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/#quot;/g, '"')
    .trim();
}

function directionOf(token: string | undefined): ConceptMapDirection {
  switch ((token ?? 'TD').toUpperCase()) {
    case 'LR':
      return 'ltr';
    case 'RL':
      return 'rtl';
    default:
      return 'tb';
  }
}

/** Splits on newlines and on `;` that are not inside a node label. */
function splitStatements(source: string): string[] {
  const statements: string[] = [];
  let current = '';
  let depth = 0;
  let quoted = false;

  for (const char of source) {
    if (char === '"') quoted = !quoted;
    if (!quoted && '[({'.includes(char)) depth += 1;
    if (!quoted && '])}'.includes(char)) depth = Math.max(0, depth - 1);

    if ((char === '\n' || (char === ';' && depth === 0 && !quoted))) {
      if (current.trim()) statements.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) statements.push(current.trim());

  return statements;
}

export function parseMermaidFlowchart(source: string): FlowGraph | null {
  const statements = splitStatements((source ?? '').replace(/%%.*$/gm, ''));
  const nodes = new Map<string, ConceptMapNode>();
  const edges: ConceptMapEdge[] = [];
  let direction: ConceptMapDirection = 'tb';
  let sawHeader = false;

  const touchNode = (id: string, text?: string, shape?: ConceptNodeShape) => {
    const existing = nodes.get(id);

    if (existing) {
      if (text !== undefined && text !== '') existing.text = text;
      if (shape && text !== undefined) existing.shape = shape;

      return existing;
    }

    const node: ConceptMapNode = { id, text: text || id, shape: shape ?? 'rect' };

    nodes.set(id, node);

    return node;
  };

  /** Reads one node reference at the start of `rest` (possibly `A & B`); returns ids + remainder. */
  const readNodes = (rest: string): { ids: string[]; remainder: string } | null => {
    const ids: string[] = [];
    let remainder = rest.trimStart();

    while (remainder) {
      let matched = false;

      for (const { re, shape } of NODE_PATTERNS) {
        const match = remainder.match(re);

        if (match?.[1]) {
          const id = match[1];
          const hasText = match[2] !== undefined;

          touchNode(id, hasText ? cleanLabel(match[2] ?? '') : undefined, hasText ? shape : undefined);
          ids.push(id);
          remainder = remainder.slice(match[0].length).replace(/^:::[\w-]+/, '').trimStart();
          matched = true;
          break;
        }
      }

      if (!matched) break;

      if (remainder.startsWith('&')) {
        remainder = remainder.slice(1).trimStart();
        continue;
      }

      break;
    }

    return ids.length > 0 ? { ids, remainder } : null;
  };

  for (const statement of statements) {
    const header = statement.match(HEADER_RE);

    if (header) {
      direction = directionOf(header[1]);
      sawHeader = true;
      continue;
    }

    if (/^(style|classDef|class|click|linkStyle|subgraph|end|direction|accTitle|accDescr)\b/i.test(statement)) {
      const dir = statement.match(/^direction\s+(TD|TB|BT|LR|RL)/i);

      if (dir && !sawHeader) direction = directionOf(dir[1]);
      continue;
    }

    let parsed = readNodes(statement);

    if (!parsed) continue;

    let sources = parsed.ids;
    let remainder = parsed.remainder;

    while (remainder) {
      const edge = readEdge(remainder);

      if (!edge) break;

      remainder = remainder.slice(edge.length);
      parsed = readNodes(remainder);

      if (!parsed) break;

      for (const from of sources) {
        for (const to of parsed.ids) {
          const record: ConceptMapEdge = { from, to, arrow: edge.arrow };

          if (edge.label) record.label = edge.label;
          edges.push(record);
        }
      }

      sources = parsed.ids;
      remainder = parsed.remainder;
    }
  }

  if (nodes.size === 0) return null;

  return { direction, nodes: Array.from(nodes.values()), edges };
}

/** Graph → mermaid flowchart source (kept on board objects so a diagram can be re-read later). */
export function graphToMermaid(graph: Pick<ConceptMap, 'nodes' | 'edges' | 'direction'>): string {
  const direction = graph.direction === 'ltr' ? 'LR' : graph.direction === 'rtl' ? 'RL' : 'TD';
  const safeId = (id: string) => id.replace(/[^A-Za-z0-9_]/g, '_') || 'n';
  const quote = (text: string) => `"${text.replace(/"/g, '#quot;').replace(/\n/g, '<br/>')}"`;
  const lines = [`flowchart ${direction}`];

  for (const node of graph.nodes) {
    const text = quote(node.text);
    const shape = node.shape ?? 'rect';
    const body =
      shape === 'ellipse' ? `((${text}))` : shape === 'rounded' ? `(${text})` : shape === 'diamond' ? `{${text}}` : `[${text}]`;

    lines.push(`  ${safeId(node.id)}${body}`);
  }

  for (const edge of graph.edges) {
    const operator = edge.arrow === 'none' ? '---' : edge.arrow === 'both' ? '<-->' : '-->';
    const label = edge.label ? `|${edge.label.replace(/\|/g, '/')}|` : '';

    lines.push(`  ${safeId(edge.from)} ${operator}${label} ${safeId(edge.to)}`);
  }

  return lines.join('\n');
}
