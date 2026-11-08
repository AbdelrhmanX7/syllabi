/**
 * Small markdown block parser for question stems / answers / notes: fenced code, `$$…$$` display
 * math, images, ordered/unordered lists, headings and paragraphs. Inline parsing (bold, italic,
 * inline code, `$…$`) happens in the renderer. Tolerates an unclosed fence (streamed text).
 */

export type MdBlock =
  | { type: 'p'; text: string }
  | { type: 'h'; level: number; text: string }
  | { type: 'code'; lang: string; code: string }
  | { type: 'math'; tex: string }
  | { type: 'img'; src: string; alt: string }
  | { type: 'list'; ordered: boolean; items: string[] };

const FENCE_RE = /^\s*(```|~~~)\s*([\w+#-]*)\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const IMG_RE = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;
const UL_RE = /^\s*[-*+]\s+(.*)$/;
const OL_RE = /^\s*\d+[.)]\s+(.*)$/;
const DISPLAY_OPEN_RE = /^\s*\$\$(.*)$/;

export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'p', text: paragraph.join('\n') });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const fence = line.match(FENCE_RE);

    if (fence) {
      flush();
      const marker = fence[1]!;
      const code: string[] = [];

      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(marker)) {
        code.push(lines[i] ?? '');
        i += 1;
      }
      blocks.push({ type: 'code', lang: fence[2] ?? '', code: code.join('\n') });
      continue;
    }

    const display = line.match(DISPLAY_OPEN_RE);

    if (display) {
      flush();
      const rest = display[1] ?? '';
      const closeInline = rest.indexOf('$$');

      if (closeInline >= 0) {
        blocks.push({ type: 'math', tex: rest.slice(0, closeInline).trim() });
        continue;
      }
      const tex: string[] = rest ? [rest] : [];

      i += 1;
      while (i < lines.length && !(lines[i] ?? '').includes('$$')) {
        tex.push(lines[i] ?? '');
        i += 1;
      }
      if (i < lines.length) {
        const tail = lines[i] ?? '';

        tex.push(tail.slice(0, tail.indexOf('$$')));
      }
      blocks.push({ type: 'math', tex: tex.join('\n').trim() });
      continue;
    }

    const img = line.match(IMG_RE);

    if (img) {
      flush();
      blocks.push({ type: 'img', alt: img[1] ?? '', src: img[2] ?? '' });
      continue;
    }

    const heading = line.match(HEADING_RE);

    if (heading) {
      flush();
      blocks.push({ type: 'h', level: heading[1]!.length, text: heading[2] ?? '' });
      continue;
    }

    const ul = line.match(UL_RE);
    const ol = ul ? null : line.match(OL_RE);

    if (ul || ol) {
      flush();
      const ordered = Boolean(ol);
      const items: string[] = [(ul ?? ol)![1] ?? ''];

      while (i + 1 < lines.length) {
        const next = lines[i + 1] ?? '';
        const nextMatch = ordered ? next.match(OL_RE) : next.match(UL_RE);

        if (nextMatch) {
          items.push(nextMatch[1] ?? '');
          i += 1;
        } else if (/^\s{2,}\S/.test(next) && items.length) {
          items[items.length - 1] += `\n${next.trim()}`;
          i += 1;
        } else break;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    if (line.trim() === '') {
      flush();
      continue;
    }
    paragraph.push(line);
  }
  flush();

  return blocks;
}

export type InlinePart =
  | { kind: 'text'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'em'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'math'; value: string }
  | { kind: 'link'; value: string; href: string };

// Inline `$…$` follows pandoc: no space just inside the dollars and no digit right after the closing
// one, so prices («permits are $4, citations $40») stay text. `_em_` only at word edges (file_names).
const INLINE_RE =
  /(\$\$[\s\S]+?\$\$|\\\([\s\S]+?\\\)|(?<!\\)\$(?=[^\s$])(?:[^$\n]*?[^\s$])?\$(?!\d))|(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(\*[^*\n]+?\*|(?<!\w)_[^_\n]+?_(?!\w))|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;

/** Splits inline markdown into text / bold / em / code / math runs. */
export function parseInline(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let last = 0;
  let match: RegExpExecArray | null;

  INLINE_RE.lastIndex = 0;

  while ((match = INLINE_RE.exec(text)) !== null) {
    if (match.index > last) parts.push({ kind: 'text', value: text.slice(last, match.index) });
    const [whole, math, code, bold, em, linkText, href] = match;

    if (math !== undefined) {
      const inner = math.startsWith('$$')
        ? math.slice(2, -2)
        : math.startsWith('\\(')
          ? math.slice(2, -2)
          : math.slice(1, -1);

      parts.push({ kind: 'math', value: inner.trim() });
    } else if (code !== undefined) parts.push({ kind: 'code', value: code.slice(1, -1) });
    else if (bold !== undefined) parts.push({ kind: 'bold', value: bold.slice(2, -2) });
    else if (em !== undefined) parts.push({ kind: 'em', value: em.slice(1, -1) });
    else if (linkText !== undefined && href !== undefined) parts.push({ kind: 'link', value: linkText, href });
    else parts.push({ kind: 'text', value: whole });
    last = match.index + whole.length;
  }
  if (last < text.length) parts.push({ kind: 'text', value: text.slice(last) });

  return parts;
}

/** Plain text preview (first ~N chars) for list cards. */
export function plainPreview(markdown: string, max = 140): string {
  const text = parseMarkdown(markdown)
    .map((block) => {
      if (block.type === 'code') return block.code.split('\n')[0] ?? '';
      if (block.type === 'math') return block.tex;
      if (block.type === 'img') return block.alt;
      if (block.type === 'list') return block.items.join(' · ');

      return block.text;
    })
    .join(' ')
    .replace(/\*\*|`|\$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
