// Board exam → one answer image per question for `POST /questions/:id/attempt`: each board page's
// ink overlay drawn over the typeset question (placed where the PDF page sits), on white. Pages he
// added himself (no PDF page) are continuation sheets of the question before them.
import type { PaperPage } from './boardPaper';
import type { MergeOverlaysResult } from '@repo/whiteboard-react';

/** Long edge of a submitted answer — legible handwriting, a few hundred KB of PNG. */
const ANSWER_MAX_PX = 1600;

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();

    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not read a board page'));
    image.src = src;
  });

/** Any pen mark at all (transparent overlay pixels are page, not ink). */
function hasInk(image: HTMLImageElement): boolean {
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 400 / Math.max(image.width, image.height));

  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  if (!ctx) return true;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

  for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 24) return true;

  return false;
}

async function composePage(
  overlay: HTMLImageElement,
  entry: MergeOverlaysResult['pages'][number]['entry'],
  paper: PaperPage | null,
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');

  canvas.width = overlay.width;
  canvas.height = overlay.height;
  const ctx = canvas.getContext('2d');

  if (!ctx) throw new Error('This device cannot prepare the answers');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (entry.pdf && paper?.imageDataUrl) {
    const scale = overlay.width / entry.widthPt;
    const rect = {
      x: entry.pdf.x * scale,
      y: (entry.heightPt - entry.pdf.y - entry.pdf.height) * scale,
      w: entry.pdf.width * scale,
      h: entry.pdf.height * scale,
    };
    const sx = rect.w / paper.pageW;
    const sy = rect.h / paper.pageH;
    const question = await loadImage(paper.imageDataUrl);

    ctx.drawImage(question, rect.x + paper.box.x * sx, rect.y + paper.box.y * sy, paper.box.w * sx, paper.box.h * sy);
  }
  ctx.drawImage(overlay, 0, 0);

  return canvas;
}

function stack(canvases: HTMLCanvasElement[]): string {
  const width = Math.max(...canvases.map((canvas) => canvas.width));
  const height = canvases.reduce((sum, canvas) => sum + canvas.height, 0);
  const scale = Math.min(1, ANSWER_MAX_PX / Math.max(width, height));
  const out = document.createElement('canvas');

  out.width = Math.max(1, Math.round(width * scale));
  out.height = Math.max(1, Math.round(height * scale));
  const ctx = out.getContext('2d');

  if (!ctx) throw new Error('This device cannot prepare the answers');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  let y = 0;

  for (const canvas of canvases) {
    ctx.drawImage(canvas, 0, y, canvas.width * scale, canvas.height * scale);
    y += canvas.height * scale;
  }

  return out.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}

export interface BoardAnswer {
  questionId: string;
  /** null = nothing written for this question. */
  inkPngB64: string | null;
}

/** One answer per paper question, in paper order. */
export async function boardAnswers(overlays: MergeOverlaysResult, paper: PaperPage[]): Promise<BoardAnswer[]> {
  const groups = new Map<string, { canvases: HTMLCanvasElement[]; inked: boolean }>();
  let current: PaperPage | null = null;

  for (const { entry, overlayDataUrl } of overlays.pages) {
    const own = entry.pdf && entry.pdfPageIndex !== undefined ? (paper[entry.pdfPageIndex] ?? null) : null;

    if (own) current = own;
    if (!current) continue;

    const overlay = await loadImage(overlayDataUrl);
    const group = groups.get(current.questionId) ?? { canvases: [], inked: false };
    const inked = hasInk(overlay);

    // A blank continuation sheet adds nothing but height.
    if (own || inked) group.canvases.push(await composePage(overlay, entry, own));
    group.inked ||= inked;
    groups.set(current.questionId, group);
  }

  return paper.map(({ questionId }) => {
    const group = groups.get(questionId);

    return { questionId, inkPngB64: group?.inked ? stack(group.canvases) : null };
  });
}
