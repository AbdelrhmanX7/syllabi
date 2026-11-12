/**
 * What is already on the page, read from its PIXELS — the rendered sheet the model sees. Ink
 * objects alone are not enough: a PDF's printed text, a pasted picture and typed text are content
 * too, and a note written over any of them is unreadable.
 *
 * The sheet is cut into small cells; a cell is taken when it holds pixels that differ clearly from
 * the paper colour (faint ruling does not count). A summed-area table then answers «is this box
 * empty?» in O(1), so the nearest empty spot for a note is an exhaustive, cheap search.
 *
 * Pure: pixels in, numbers out (pixel units of the rendered image).
 */

export interface PxBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Occupancy {
  /** Cell edge, px. */
  cell: number;
  cols: number;
  rows: number;
  /** 1 = the cell holds content. */
  cells: Uint8Array;
  /** Summed-area table over `cells`, (cols+1) × (rows+1). */
  sat: Uint32Array;
  /** Share of the cells that are taken, 0..1. */
  fill: number;
  /** Fine rows for telling text lines apart: `fineRows` strips of `fineH` px, same columns; 1 = content. */
  fineH: number;
  fineRows: number;
  fine: Uint8Array;
}

/** How far a pixel's brightness must sit from the paper's to count as content (0..255). */
const CONTRAST = 64;

/**
 * RGBA pixels → the occupancy grid. The paper colour is the most common brightness on the page
 * (works on a white sheet and on a dark board alike).
 */
export function buildOccupancy(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, cell = 12): Occupancy {
  const cols = Math.max(1, Math.ceil(width / cell));
  const rows = Math.max(1, Math.ceil(height / cell));
  const cells = new Uint8Array(cols * rows);
  const histogram = new Uint32Array(64);
  const total = width * height;
  // Brightness of every 4th pixel is plenty for the paper estimate.
  for (let i = 0; i < total; i += 4) {
    const o = i * 4;

    histogram[((rgba[o]! * 3 + rgba[o + 1]! * 6 + rgba[o + 2]!) / 10) >> 2]! += 1;
  }

  let paperBin = 0;

  for (let bin = 1; bin < 64; bin += 1) if (histogram[bin]! > histogram[paperBin]!) paperBin = bin;

  const paper = paperBin * 4 + 2;
  const counts = new Uint16Array(cols * rows);
  const fineH = Math.max(2, Math.round(cell / 4));
  const fineRows = Math.max(1, Math.ceil(height / fineH));
  const fine = new Uint8Array(cols * fineRows);

  for (let y = 0; y < height; y += 1) {
    const row = Math.floor(y / cell) * cols;
    const fineRow = Math.floor(y / fineH) * cols;

    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const brightness = (rgba[o]! * 3 + rgba[o + 1]! * 6 + rgba[o + 2]!) / 10;

      if (Math.abs(brightness - paper) > CONTRAST) {
        const index = row + Math.floor(x / cell);

        if (counts[index]! < 65535) counts[index]! += 1;
        fine[fineRow + Math.floor(x / cell)] = 1;
      }
    }
  }

  let taken = 0;

  // Two stray pixels are noise; three or more is a mark.
  for (let i = 0; i < counts.length; i += 1) {
    if (counts[i]! >= 3) {
      cells[i] = 1;
      taken += 1;
    }
  }

  return { cell, cols, rows, cells, sat: summedArea(cells, cols, rows), fill: taken / cells.length, fineH, fineRows, fine };
}

function summedArea(cells: Uint8Array, cols: number, rows: number): Uint32Array {
  const sat = new Uint32Array((cols + 1) * (rows + 1));

  for (let r = 0; r < rows; r += 1) {
    let run = 0;

    for (let c = 0; c < cols; c += 1) {
      run += cells[r * cols + c]!;
      sat[(r + 1) * (cols + 1) + c + 1] = sat[r * (cols + 1) + c + 1]! + run;
    }
  }

  return sat;
}

/** Taken cells inside the cell rectangle [c0, c1) × [r0, r1). */
function takenIn(grid: Occupancy, c0: number, r0: number, c1: number, r1: number): number {
  const w = grid.cols + 1;

  return grid.sat[r1 * w + c1]! - grid.sat[r0 * w + c1]! - grid.sat[r1 * w + c0]! + grid.sat[r0 * w + c0]!;
}

const overlaps = (a: PxBox, b: PxBox) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * The empty spot for a `w × h` px box nearest to where it was wanted (`x, y` = its wanted top-left),
 * with a one-cell margin around it, clear of `taken` (boxes placed earlier in the same turn) — or
 * null when nothing that large is free within `maxDistance` px. `within` keeps it inside that box
 * (the part of the page on screen).
 */
export function findFreeBox(grid: Occupancy, wanted: PxBox, taken: readonly PxBox[] = [], maxDistance = Infinity, within?: PxBox | null): PxBox | null {
  const { cell, cols, rows } = grid;
  // The box plus a margin cell on every side, in cells.
  const cw = Math.ceil(wanted.w / cell) + 2;
  const ch = Math.ceil(wanted.h / cell) + 2;

  if (cw > cols || ch > rows) return null;

  let best: PxBox | null = null;
  let bestScore = Infinity;

  for (let r = 0; r + ch <= rows; r += 1) {
    for (let c = 0; c + cw <= cols; c += 1) {
      const x = (c + 1) * cell;
      const y = (r + 1) * cell;
      const dx = x - wanted.x;
      const dy = y - wanted.y;
      const distance = Math.hypot(dx, dy);

      if (distance >= bestScore || distance > maxDistance) continue;
      if (within && (x < within.x || y < within.y || x + wanted.w > within.x + within.w || y + wanted.h > within.y + within.h)) continue;
      if (takenIn(grid, c, r, c + cw, r + ch) > 0) continue;

      const box = { x, y, w: wanted.w, h: wanted.h };
      const margin = { x: x - cell, y: y - cell, w: wanted.w + cell * 2, h: wanted.h + cell * 2 };

      if (taken.some((other) => overlaps(other, margin))) continue;

      best = box;
      bestScore = distance;
    }
  }

  return best;
}

/**
 * The page's content as regions a tutor can name: first columns (taken cells that touch, or sit one
 * cell apart sideways), then each column cut into its text LINES (the fine rows that are empty
 * between them), then neighbouring lines grouped — a new region at a visibly larger gap (a new
 * paragraph, a figure) or once a group holds its share of lines, so a dense page still fits `max`.
 * Boxes hug the content; reading order; specks under `minCells` are dropped.
 */
export function contentBlocks(grid: Occupancy, { max = 40, minCells = 4 }: { max?: number; minCells?: number } = {}): PxBox[] {
  const { cell, cols, rows, cells, fine, fineH, fineRows } = grid;
  const seen = new Uint8Array(cells.length);
  const stack: number[] = [];
  const columns: Array<{ c0: number; c1: number; r0: number; r1: number }> = [];

  for (let start = 0; start < cells.length; start += 1) {
    if (!cells[start] || seen[start]) continue;

    let c0 = cols;
    let c1 = 0;
    let r0 = rows;
    let r1 = 0;
    let size = 0;

    seen[start] = 1;
    stack.push(start);

    while (stack.length > 0) {
      const index = stack.pop()!;
      const c = index % cols;
      const r = (index - c) / cols;

      size += 1;
      c0 = Math.min(c0, c);
      c1 = Math.max(c1, c);
      r0 = Math.min(r0, r);
      r1 = Math.max(r1, r);

      for (let dr = -1; dr <= 1; dr += 1) {
        const nr = r + dr;

        if (nr < 0 || nr >= rows) continue;

        // Sideways a one-cell gap still joins (a space between words); up-down only touching cells.
        for (let dc = dr === 0 ? -2 : -1; dc <= (dr === 0 ? 2 : 1); dc += 1) {
          const nc = c + dc;

          if (nc < 0 || nc >= cols) continue;

          const next = nr * cols + nc;

          if (cells[next] && !seen[next]) {
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
    }

    if (size >= minCells) columns.push({ c0, c1, r0, r1 });
  }

  // Each column → its lines: runs of fine rows with content inside the column's width.
  interface Line {
    f0: number;
    f1: number;
    c0: number;
    c1: number;
  }
  const perColumn: Line[][] = columns.map(({ c0, c1, r0, r1 }) => {
    const lines: Line[] = [];
    const from = Math.floor((r0 * cell) / fineH);
    const to = Math.min(fineRows - 1, Math.ceil(((r1 + 1) * cell) / fineH) - 1);
    let open: Line | null = null;

    for (let f = from; f <= to; f += 1) {
      let left = -1;
      let right = -1;

      for (let c = c0; c <= c1; c += 1) {
        if (fine[f * cols + c]) {
          if (left < 0) left = c;
          right = c;
        }
      }

      if (left < 0) {
        open = null;
      } else if (open) {
        open.f1 = f;
        open.c0 = Math.min(open.c0, left);
        open.c1 = Math.max(open.c1, right);
      } else {
        open = { f0: f, f1: f, c0: left, c1: right };
        lines.push(open);
      }
    }

    return lines;
  });
  const totalLines = perColumn.reduce((sum, lines) => sum + lines.length, 0);
  // A region is a few lines at most (so the tutor can name a spot, not a whole column); more on a dense page.
  const share = Math.max(4, Math.ceil(totalLines / Math.max(1, max)));
  const out: PxBox[] = [];

  for (const lines of perColumn) {
    if (lines.length === 0) continue;

    const gaps = lines.slice(1).map((line, index) => line.f0 - lines[index]!.f1 - 1).sort((a, b) => a - b);
    const usual = gaps.length ? gaps[gaps.length >> 1]! : 0;
    let group: Line[] = [];
    const flush = () => {
      if (group.length === 0) return;

      const c0 = Math.min(...group.map((line) => line.c0));
      const c1 = Math.max(...group.map((line) => line.c1));
      const f0 = group[0]!.f0;
      const f1 = group[group.length - 1]!.f1;

      out.push({ x: c0 * cell, y: f0 * fineH, w: (c1 - c0 + 1) * cell, h: (f1 - f0 + 1) * fineH });
      group = [];
    };

    lines.forEach((line, index) => {
      const gap = index ? line.f0 - lines[index - 1]!.f1 - 1 : 0;

      if (group.length >= share || (index > 0 && gap > Math.max(usual * 1.6, usual + 2))) flush();

      group.push(line);
    });
    flush();
  }

  return out
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .slice(0, max)
    .sort((a, b) => a.y - b.y || a.x - b.x);
}
