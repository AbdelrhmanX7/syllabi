// Board exam paper: bank questions → a PDF with one question per page (the question typeset at the
// top, the rest of the page blank for his working), opened on the real notebook board. The same
// renders are reused at grading time, drawn under his ink so the grader sees what he circled.
import type { Question } from '@/lib/api/types';

import { renderHtmlImage } from '@repo/whiteboard-react';

import { loadKatex, renderKatexHtml } from './katex';
import { parseInline, parseMarkdown, plainPreview } from './markdown';

/** A4 portrait, in PDF points. */
export const PAGE_W = 595.28;
const PAGE_MIN_H = 841.89;
const MARGIN = 32;
/** Blank writing space under a question that is taller than the page leaves room for. */
const ANSWER_SPACE = 460;
const RENDER_CSS_WIDTH = 720;

/** Big boards are slow to import and to sweep on a tablet. */
export const BOARD_EXAM_MAX = 30;

/** matching / fill_blank are graded from structured answers only (BE) — not from ink yet. */
export const isBoardGradable = (question: Pick<Question, 'type'>) =>
  question.type !== 'matching' && question.type !== 'fill_blank';

export interface PaperPage {
  questionId: string;
  pageW: number;
  pageH: number;
  /** Where the typeset question sits on the page — PDF points, TOP-left origin. */
  box: { x: number; y: number; w: number; h: number };
  /** The typeset question (PNG data URL); null when the device could not render it (text fallback). */
  imageDataUrl: string | null;
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function toDataUrl(src: string): Promise<string | null> {
  if (src.startsWith('data:')) return src;
  try {
    const response = await fetch(src);

    if (!response.ok) return null;
    const blob = await response.blob();

    return await new Promise((resolve) => {
      const reader = new FileReader();

      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

type Katex = Awaited<ReturnType<typeof loadKatex>>;

function inlineHtml(text: string, katex: Katex): string {
  return parseInline(text)
    .map((part) => {
      switch (part.kind) {
        case 'bold':
          return `<strong>${escapeHtml(part.value)}</strong>`;
        case 'em':
          return `<em>${escapeHtml(part.value)}</em>`;
        case 'code':
          return `<code style="font-family:monospace;background:#f1f1f4;padding:0 4px;border-radius:4px">${escapeHtml(part.value)}</code>`;
        case 'math':
          return renderKatexHtml(katex, part.value, false) ?? `<code>${escapeHtml(part.value)}</code>`;
        case 'link':
          return escapeHtml(part.value);
        default:
          return escapeHtml(part.value);
      }
    })
    .join('');
}

async function markdownHtml(markdown: string, katex: Katex): Promise<string> {
  const out: string[] = [];

  for (const block of parseMarkdown(markdown)) {
    switch (block.type) {
      case 'p':
        out.push(`<p style="margin:0 0 10px">${inlineHtml(block.text, katex)}</p>`);
        break;
      case 'h':
        out.push(`<p style="margin:0 0 10px;font-weight:700">${inlineHtml(block.text, katex)}</p>`);
        break;
      case 'math':
        out.push(
          `<div style="margin:6px 0 12px">${renderKatexHtml(katex, block.tex, true) ?? `<code>${escapeHtml(block.tex)}</code>`}</div>`,
        );
        break;
      case 'code':
        out.push(
          `<pre style="margin:0 0 10px;padding:10px 12px;background:#f4f4f7;border-radius:8px;font:15px/1.45 monospace;white-space:pre-wrap">${escapeHtml(block.code)}</pre>`,
        );
        break;
      case 'img': {
        const data = await toDataUrl(block.src);

        if (data)
          out.push(
            `<img alt="" src="${data}" style="display:block;max-width:100%;max-height:420px;margin:4px 0 12px" />`,
          );
        break;
      }
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul';

        out.push(
          `<${tag} style="margin:0 0 10px;padding-left:26px">${block.items.map((item) => `<li>${inlineHtml(item, katex)}</li>`).join('')}</${tag}>`,
        );
        break;
      }
    }
  }

  return out.join('');
}

async function questionHtml(question: Question, number: number, katex: Katex): Promise<string> {
  const parts = [
    `<div style="font:600 13px/1.3 sans-serif;color:#6b6b7b;margin-bottom:8px">Question ${number} · ${escapeHtml(question.topic)}</div>`,
    await markdownHtml(question.stem, katex),
  ];

  if (question.imageUrl) {
    const data = await toDataUrl(question.imageUrl);

    if (data)
      parts.push(
        `<img alt="" src="${data}" style="display:block;max-width:100%;max-height:420px;margin:4px 0 12px" />`,
      );
  }
  if (question.type === 'mcq' && question.choices?.length) {
    parts.push(
      `<div style="margin-top:6px">${question.choices
        .map(
          (choice, index) =>
            `<div style="display:flex;gap:10px;margin:0 0 8px"><span style="font-weight:700;min-width:22px">${String.fromCharCode(65 + index)}.</span><span>${inlineHtml(choice, katex)}</span></div>`,
        )
        .join('')}</div>`,
    );
  }

  return `<div style="font:18px/1.5 sans-serif;color:#15151f;padding:14px 18px;border:1.5px solid #d9d9e3;border-radius:12px;background:#fff">${parts.join('')}</div>`;
}

/** Text-only fallback where the WebView refuses to rasterise HTML (pdf-lib's Helvetica is Latin-only). */
const latinOnly = (text: string) => text.replace(/[^\x20-\x7E\n]/g, '?');

export interface BoardPaper {
  file: File;
  pages: PaperPage[];
}

export async function buildBoardPaper(
  questions: Question[],
  title: string,
  onProgress?: (done: number, total: number) => void,
): Promise<BoardPaper> {
  const [{ PDFDocument, StandardFonts, rgb }, katex] = await Promise.all([import('pdf-lib'), loadKatex()]);
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages: PaperPage[] = [];
  const boxW = PAGE_W - MARGIN * 2;

  for (const [index, question] of questions.entries()) {
    onProgress?.(index, questions.length);
    const raster = await renderHtmlImage(await questionHtml(question, index + 1, katex), {
      widthPx: RENDER_CSS_WIDTH,
      pixelRatio: 2,
    });

    if (raster) {
      const boxH = boxW * (raster.height / raster.width);
      const pageH = Math.max(PAGE_MIN_H, MARGIN + boxH + ANSWER_SPACE);
      const page = pdf.addPage([PAGE_W, pageH]);
      const image = await pdf.embedPng(raster.dataUrl);

      page.drawImage(image, { x: MARGIN, y: pageH - MARGIN - boxH, width: boxW, height: boxH });
      pages.push({
        questionId: question.id,
        pageW: PAGE_W,
        pageH,
        box: { x: MARGIN, y: MARGIN, w: boxW, h: boxH },
        imageDataUrl: raster.dataUrl,
      });
      continue;
    }

    const page = pdf.addPage([PAGE_W, PAGE_MIN_H]);
    const lines = [
      `Question ${index + 1} · ${question.topic}`,
      ...(plainPreview(question.stem, 1200).match(/.{1,88}(\s|$)/g) ?? []),
    ];

    lines.forEach((line, row) =>
      page.drawText(latinOnly(line.trim()), {
        x: MARGIN,
        y: PAGE_MIN_H - MARGIN - 14 - row * 17,
        size: 12,
        font,
        color: rgb(0.08, 0.08, 0.12),
      }),
    );
    pages.push({
      questionId: question.id,
      pageW: PAGE_W,
      pageH: PAGE_MIN_H,
      box: { x: MARGIN, y: MARGIN, w: boxW, h: lines.length * 17 + 14 },
      imageDataUrl: null,
    });
  }
  onProgress?.(questions.length, questions.length);

  const bytes = await pdf.save();

  return { file: new File([bytes as BlobPart], `${title}.pdf`, { type: 'application/pdf' }), pages };
}
