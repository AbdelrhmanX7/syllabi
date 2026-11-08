import type { BoardAiBlock, BoardAiTone } from './types';

import { CALLOUT_HEAD_RE, CALLOUT_LINE_RE, parseTone, stripInlineTones, TONE_FENCE_CLOSE_RE, TONE_FENCE_OPEN_RE } from './tones';

/**
 * Markdown answer → board blocks.
 *
 * The guest chat answers in Markdown (headings, lists, GFM tables, `$…$` / `$$…$$` LaTeX, fenced
 * ```mermaid``` diagrams). The teacher endpoints send blocks directly; this turns the guest's text
 * into the same shape so ONE renderer and ONE inserter serve both. It runs on every streamed chunk,
 * so it must tolerate a half-written answer: an unclosed `$$` or fence simply becomes the block it
 * is turning into.
 *
 * Inline markdown (`**bold**`, `$x$`) is LEFT in block text — the panel renders it, the board
 * inserter flattens it (`stripInlineMarkdown` + `latexToText`).
 */

const FENCE_RE = /^\s*(```|~~~)\s*([\w-]*)\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const UNORDERED_RE = /^\s*[-*+•]\s+(.*)$/;
const ORDERED_RE = /^\s*([0-9]+)[.)\-]\s+(.*)$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** «Q1:» / «Question 2)» / «**Q3.**» / «1.» — the start of a numbered question. */
const QUESTION_START_RE = /^\s*(?:\*\*)?\s*(?:(?:Question|Q)\s*[0-9]+\s*[:.)\-]?|[0-9]+\s*[-.)])\s*(?:\*\*)?\s*(.*)$/i;
/** A choice line: «a) …», «(b) …», «c- …», «A. …», optionally bulleted. */
const CHOICE_RE = /^\s*(?:[-*+•]\s+)?(?:\*\*)?\(?([a-fA-F])\s*(?:\)|-|\.|:)(?:\*\*)?\s+(.+)$/;
const ANSWER_RE = /^\s*(?:[-*+•]\s+)?(?:\*\*)?\s*(?:(?:correct\s+)?answer)\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.+?)\s*(?:\*\*)?\s*$/i;
const EXPLANATION_RE = /^\s*(?:[-*+•]\s+)?(?:\*\*)?\s*(?:explanation|reason|why)\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.+?)\s*$/i;

const CHOICE_ORDER = ['a', 'b', 'c', 'd', 'e', 'f'];

/** Index of a choice letter (a/A → 0, b/B → 1 …), or -1. */
export function choiceLetterIndex(letter: string): number {
  return CHOICE_ORDER.indexOf(letter.trim().toLowerCase());
}

/** The answer line «Answer: b» / «Answer: (b) 20» / the choice's own text → index, or undefined. */
export function resolveAnswerIndex(answer: string, choices: string[]): number | undefined {
  const cleaned = answer.replace(/\*\*/g, '').trim();
  const letterMatch = cleaned.match(/^\(?([a-fA-F])\s*(?:\)|-|\.|:|$|\s)/);

  if (letterMatch?.[1]) {
    const index = choiceLetterIndex(letterMatch[1]);

    if (index >= 0 && index < choices.length) return index;
  }

  const plain = stripInlineMarkdown(cleaned);
  const byText = choices.findIndex((choice) => stripInlineMarkdown(choice).trim() === plain);

  return byText >= 0 ? byText : undefined;
}

/** Splits one table row into trimmed cells (outer pipes optional, `\|` escapes kept as `|`). */
export function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];

    if (char === '\\' && trimmed[index + 1] === '|') {
      current += '|';
      index += 1;
    } else if (char === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  cells.push(current.trim());

  return cells;
}

/** `**a**` → `a`, `*a*` → `a`, `` `a` `` → `a`, `[t](u)` → `t`. Math is left alone. */
export function stripInlineMarkdown(text: string): string {
  return stripInlineTones(text)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|[^*$\\])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
}

const isBlank = (line: string | undefined) => line === undefined || line.trim() === '';

interface QuestionParse {
  block: Extract<BoardAiBlock, { type: 'question' }>;
  consumed: number;
}

/**
 * Tries to read an MCQ / written question starting at `start`. A question needs a stem line that
 * looks numbered AND either ≥ 2 choice lines or an explicit answer line — otherwise a numbered list
 * of steps would be mistaken for a quiz.
 */
function tryParseQuestion(lines: string[], start: number): QuestionParse | null {
  const first = lines[start] ?? '';
  const stemMatch = first.match(QUESTION_START_RE);

  if (!stemMatch) return null;

  // «1. Something» is also a plain ordered list item; the guard below (choices / answer) decides.
  const stemParts: string[] = [];
  const firstStem = stemMatch[1]?.trim() ?? '';

  if (firstStem) stemParts.push(firstStem);

  const choices: string[] = [];
  let answerRaw: string | undefined;
  let explanation: string | undefined;
  let index = start + 1;
  let sawBlankAfterChoices = false;

  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? '';

    if (isBlank(line)) {
      if (choices.length > 0 || answerRaw !== undefined) sawBlankAfterChoices = true;
      continue;
    }

    const answer = line.match(ANSWER_RE);

    if (answer) {
      answerRaw = answer[1]?.trim();
      continue;
    }

    const why = line.match(EXPLANATION_RE);

    if (why && (choices.length > 0 || answerRaw !== undefined)) {
      explanation = why[1]?.trim();
      continue;
    }

    const choice = line.match(CHOICE_RE);

    if (choice && !sawBlankAfterChoices) {
      choices.push((choice[2] ?? '').trim());
      continue;
    }

    // A new question, heading, table or fence ends this one.
    if (QUESTION_START_RE.test(line) && (choices.length > 0 || answerRaw !== undefined)) break;
    if (HEADING_RE.test(line) || TABLE_ROW_RE.test(line) || FENCE_RE.test(line) || HR_RE.test(line)) break;

    if (choices.length === 0 && answerRaw === undefined && !sawBlankAfterChoices) {
      // A stem is a line or three. Another numbered/bulleted line before any choice means this is a
      // list of steps (a solution), not a quiz — leave it to the list parser.
      if (UNORDERED_RE.test(line) || ORDERED_RE.test(line) || QUESTION_START_RE.test(line) || stemParts.length >= 4) {
        return null;
      }

      stemParts.push(line.trim());
      continue;
    }

    if (explanation !== undefined) {
      explanation = `${explanation}\n${line.trim()}`;
      continue;
    }

    break;
  }

  // Trailing blank lines belong to nobody.
  while (index > start + 1 && isBlank(lines[index - 1])) index -= 1;

  if (choices.length < 2 && answerRaw === undefined) return null;
  if (stemParts.length === 0) return null;

  // A bare «3.» start with only an answer line is the last step of a numbered solution followed by
  // its result — only an explicit «Question/Q» marker makes a choice-less question.
  if (choices.length < 2 && !/^\s*(?:\*\*)?\s*(?:Question|Q)\s*[0-9:.)\-]/i.test(first)) return null;

  const block: Extract<BoardAiBlock, { type: 'question' }> = {
    type: 'question',
    stem: stemParts.join('\n'),
  };

  if (choices.length >= 2) {
    block.choices = choices;

    if (answerRaw !== undefined) {
      const answerIndex = resolveAnswerIndex(answerRaw, choices);

      if (answerIndex !== undefined) block.answerIndex = answerIndex;
      else block.answer = answerRaw;
    }
  } else if (answerRaw !== undefined) {
    block.answer = answerRaw;
  }

  if (explanation) block.explanation = explanation;

  return { block, consumed: index - start };
}

/** The callout's blocks, each marked with its tone (a nested callout keeps its own). */
const withTone = (blocks: BoardAiBlock[], tone: BoardAiTone): BoardAiBlock[] => blocks.map((block) => (block.tone ? block : { ...block, tone }));

/** Parses a (possibly still streaming) markdown answer into blocks. Never throws. */
export function markdownToBlocks(markdown: string): BoardAiBlock[] {
  const blocks: BoardAiBlock[] = [];
  const lines = (markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    const text = paragraph.join('\n').trim();

    if (text) blocks.push({ type: 'paragraph', text });
    paragraph = [];
  };
  const flushList = () => {
    if (list && list.items.length > 0) blocks.push({ type: 'list', ordered: list.ordered, items: list.items });
    list = null;
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
  };

  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();

    // --- fenced block ---------------------------------------------------------------------------
    const fence = line.match(FENCE_RE);

    if (fence) {
      flushAll();

      const marker = fence[1] ?? '```';
      const lang = (fence[2] ?? '').toLowerCase();
      const body: string[] = [];

      index += 1;

      while (index < lines.length && !(lines[index] ?? '').trim().startsWith(marker)) {
        body.push(lines[index] ?? '');
        index += 1;
      }

      index += 1; // closing fence (or past the end while streaming)

      const content = body.join('\n').trim();

      if (!content) continue;

      if (lang === 'mermaid' || /^(graph|flowchart)\s+(TD|TB|BT|LR|RL)\b/i.test(content)) {
        blocks.push({ type: 'diagram', mermaid: content });
      } else if (lang === 'latex' || lang === 'tex' || lang === 'math') {
        blocks.push({ type: 'math', text: content });
      } else if (lang !== 'json') {
        blocks.push({ type: 'paragraph', text: content });
      }

      continue;
    }

    // --- semantic callout (`> [!wrong]` or `:::wrong … :::`, see tones.ts) -----------------------
    const calloutHead = line.match(CALLOUT_HEAD_RE);
    const toneFence = calloutHead ? null : line.match(TONE_FENCE_OPEN_RE);
    const tone = parseTone(calloutHead?.[1] ?? toneFence?.[1]);

    if (tone) {
      flushAll();

      const body: string[] = calloutHead?.[2]?.trim() ? [calloutHead[2]] : [];

      index += 1;

      if (calloutHead) {
        // The `>` lines that follow, up to a blank line, a non-quote line or the next callout.
        while (index < lines.length && !CALLOUT_HEAD_RE.test(lines[index] ?? '')) {
          const quoted = (lines[index] ?? '').match(CALLOUT_LINE_RE);

          if (!quoted) break;
          body.push(quoted[1] ?? '');
          index += 1;
        }
      } else {
        // Up to the closing `:::` (or the end, while streaming).
        while (index < lines.length && !TONE_FENCE_CLOSE_RE.test(lines[index] ?? '')) {
          body.push(lines[index] ?? '');
          index += 1;
        }

        index += 1;
      }

      blocks.push(...withTone(markdownToBlocks(body.join('\n')), tone));
      continue;
    }

    // --- display math -----------------------------------------------------------------------------
    if (trimmed.startsWith('$$') || trimmed.startsWith('\\[')) {
      flushAll();

      const open = trimmed.startsWith('$$') ? '$$' : '\\[';
      const close = open === '$$' ? '$$' : '\\]';
      const rest = trimmed.slice(2);
      const closeAt = rest.indexOf(close);

      if (closeAt >= 0) {
        const tex = rest.slice(0, closeAt).trim();
        const after = rest.slice(closeAt + 2).trim();

        if (tex) blocks.push({ type: 'math', text: tex });
        if (after) paragraph.push(after);
        index += 1;
        continue;
      }

      const body: string[] = rest.trim() ? [rest] : [];

      index += 1;

      while (index < lines.length) {
        const candidate = lines[index] ?? '';
        const at = candidate.indexOf(close);

        if (at >= 0) {
          const head = candidate.slice(0, at);

          if (head.trim()) body.push(head);
          index += 1;
          break;
        }

        body.push(candidate);
        index += 1;
      }

      const tex = body.join('\n').trim();

      if (tex) blocks.push({ type: 'math', text: tex });
      continue;
    }

    // --- blank / rule -----------------------------------------------------------------------------
    if (!trimmed) {
      flushParagraph();
      // A blank line inside a list is allowed (loose list); the next non-list line closes it.
      index += 1;
      continue;
    }

    if (HR_RE.test(line) && !TABLE_SEPARATOR_RE.test(line.includes('|') ? line : '')) {
      flushAll();
      index += 1;
      continue;
    }

    // --- heading -----------------------------------------------------------------------------------
    const heading = line.match(HEADING_RE);

    if (heading) {
      flushAll();
      blocks.push({ type: 'heading', level: heading[1]?.length ?? 2, text: (heading[2] ?? '').trim() });
      index += 1;
      continue;
    }

    // --- table ---------------------------------------------------------------------------------------
    if (TABLE_ROW_RE.test(line) && TABLE_SEPARATOR_RE.test(lines[index + 1] ?? '')) {
      flushAll();

      const header = splitTableRow(line);
      const rows: string[][] = [];

      index += 2;

      while (index < lines.length && TABLE_ROW_RE.test(lines[index] ?? '')) {
        const cells = splitTableRow(lines[index] ?? '');

        // Pad/trim to the header width so the renderer never meets a ragged row.
        rows.push(header.map((_, column) => cells[column] ?? ''));
        index += 1;
      }

      blocks.push({ type: 'table', header, rows });
      continue;
    }

    // --- question (MCQ / written) ----------------------------------------------------------------
    const question = tryParseQuestion(lines, index);

    if (question) {
      flushAll();
      blocks.push(question.block);
      index += question.consumed;
      continue;
    }

    // --- lists --------------------------------------------------------------------------------------
    const unordered = line.match(UNORDERED_RE);
    const ordered = unordered ? null : line.match(ORDERED_RE);

    if (unordered || ordered) {
      flushParagraph();

      const isOrdered = Boolean(ordered);

      if (!list || list.ordered !== isOrdered) {
        flushList();
        list = { ordered: isOrdered, items: [] };
      }

      list.items.push(((unordered ? unordered[1] : ordered?.[2]) ?? '').trim());
      index += 1;
      continue;
    }

    // An indented continuation of the last list item.
    if (list && /^\s{2,}\S/.test(line) && paragraph.length === 0) {
      const items: string[] = list.items;

      items[items.length - 1] = `${items[items.length - 1] ?? ''} ${trimmed}`.trim();
      index += 1;
      continue;
    }

    flushList();
    paragraph.push(trimmed);
    index += 1;
  }

  flushAll();

  return blocks;
}

/** Blocks → markdown again (copy-to-clipboard, and the text a teacher endpoint `result` lacks). */
export function blocksToMarkdown(blocks: BoardAiBlock[], { withAnswers = true }: { withAnswers?: boolean; lang?: ContentLang } = {}): string {
  const labels = CONTENT_LABELS;
  const letters = choiceLetters();
  const out: string[] = [];

  blocks.forEach((block, blockIndex) => {
    switch (block.type) {
      case 'heading':
        out.push(`${'#'.repeat(Math.min(6, Math.max(1, block.level ?? 2)))} ${block.text}`);
        break;
      case 'paragraph':
        out.push(block.text);
        break;
      case 'math':
        out.push(`$$\n${block.text}\n$$`);
        break;
      case 'list':
        out.push(block.items.map((item, i) => (block.ordered ? `${i + 1}. ${item}` : `- ${item}`)).join('\n'));
        break;
      case 'table':
        out.push(
          [
            `| ${block.header.join(' | ')} |`,
            `| ${block.header.map(() => '---').join(' | ')} |`,
            ...block.rows.map((row) => `| ${row.join(' | ')} |`),
          ].join('\n'),
        );
        break;
      case 'question': {
        const lines = [`**${labels.question}${blockIndex + 1}:** ${block.stem}`];

        block.choices?.forEach((choice, i) => lines.push(`${letters[i] ?? i + 1}) ${choice}`));

        if (withAnswers) {
          if (block.answerIndex !== undefined && block.choices?.[block.answerIndex] !== undefined) {
            lines.push(`${labels.answer}: ${letters[block.answerIndex]}) ${block.choices[block.answerIndex]}`);
          } else if (block.answer) {
            lines.push(`${labels.answer}: ${block.answer}`);
          }

          if (block.explanation) lines.push(`${labels.explanation}: ${block.explanation}`);
        }

        out.push(lines.join('\n'));
        break;
      }
      case 'diagram':
        out.push(`\`\`\`mermaid\n${block.mermaid}\n\`\`\``);
        break;
      case 'image':
        out.push(`![${block.alt ?? ''}](${block.src.startsWith('data:') ? 'image' : block.src})`);
        break;
      default:
        break;
    }
  });

  return out.join('\n\n');
}

export const LATIN_CHOICE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

/** Board content is always labelled in English; the `lang` option is kept for callers that pass it. */
export type ContentLang = 'en';

/** Labels the board writes around AI content. */
export const CONTENT_LABELS: { answer: string; correct: string; explanation: string; question: string; trueFalse: [string, string] } = {
  answer: 'Answer',
  correct: 'Correct',
  explanation: 'Explanation',
  question: 'Q',
  trueFalse: ['True', 'False'],
};

export const choiceLetters = (_lang?: ContentLang | string): string[] => LATIN_CHOICE_LETTERS;

/**
 * The first fenced ```json block (or, failing that, the outermost `{…}`) of an answer, parsed.
 * Models wrap JSON in prose and sometimes leave trailing commas — both are tolerated.
 */
/**
 * Models write LaTeX inside JSON strings without doubling the backslash: `"\times"` parses as a TAB
 * followed by `imes`, `"\frac"` as a form feed. A lone backslash followed by two or more letters is
 * a TeX command, never a JSON escape (those are one letter, or `\u` + 4 hex) — double it before
 * parsing. Correctly doubled `\\` pairs are copied untouched.
 */
export function escapeLatexInJson(source: string): string {
  let out = '';

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (char !== '\\') {
      out += char;
      continue;
    }

    // A run of backslashes. Models write a TeX command with 1, 2 or 4 of them (they were told to
    // escape, and some escape twice); in front of a command or a TeX symbol, ANY run means one TeX
    // backslash, i.e. exactly two in the JSON source.
    let run = 1;

    while (source[index + run] === '\\') run += 1;

    const after = source.slice(index + run, index + run + 6);
    const isUnicode = run % 2 === 1 && /^u[0-9a-fA-F]{4}/.test(after);
    const isCommand = /^[a-zA-Z]{2}/.test(after) && !isUnicode;
    const isTexSymbol = /^[{}(),;:!%$&#_ \[\]|]/.test(after);

    if (isCommand || isTexSymbol) {
      out += '\\\\';
    } else {
      out += source.slice(index, index + run);
    }

    index += run - 1;
  }

  return out;
}

export function extractJsonObject(text: string): unknown {
  if (!text) return null;

  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)(?:```|$)/i);

  if (fenced?.[1]) candidates.push(fenced[1]);

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');

  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  for (const candidate of candidates) {
    const escaped = escapeLatexInJson(candidate);

    for (const attempt of [escaped, escaped.replace(/,\s*([}\]])/g, '$1'), candidate]) {
      try {
        return JSON.parse(attempt.trim());
      } catch {
        /* next */
      }
    }
  }

  return null;
}
