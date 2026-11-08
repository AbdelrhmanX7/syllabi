// A small QR Code encoder (byte mode, versions 1–40, all four ECC levels) for the drop-URL code in
// Settings. Follows ISO/IEC 18004 the way Project Nayuki's reference encoder lays it out; checked
// module-for-module against the `qrcode` package in `qr.test.ts`.

export type QrEcc = 'L' | 'M' | 'Q' | 'H';

const ECC_FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Index = version (0 unused).
const ECC_CODEWORDS_PER_BLOCK: Record<QrEcc, number[]> = {
  L: [
    -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  M: [
    -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  ],
  Q: [
    -1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  H: [
    -1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
};

const NUM_ECC_BLOCKS: Record<QrEcc, number[]> = {
  L: [
    -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19,
    19, 20, 21, 22, 24, 25,
  ],
  M: [
    -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31,
    33, 35, 37, 38, 40, 43, 45, 47, 49,
  ],
  Q: [
    -1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43,
    45, 48, 51, 53, 56, 59, 62, 65, 68,
  ],
  H: [
    -1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48,
    51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
  ],
};

const bit = (value: number, index: number) => ((value >>> index) & 1) !== 0;

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];

  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);

  return result;
}

function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;

  if (version >= 2) {
    const count = Math.floor(version / 7) + 2;

    result -= (25 * count - 10) * count - 55;
    if (version >= 7) result -= 36;
  }

  return result;
}

function dataCodewords(version: number, ecc: QrEcc): number {
  return Math.floor(rawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[ecc][version] * NUM_ECC_BLOCKS[ecc][version];
}

/* ------------------------------------------------------------------ Reed–Solomon over GF(256) */

function gfMul(x: number, y: number): number {
  let z = 0;

  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }

  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result: number[] = new Array(degree).fill(0);

  result[degree - 1] = 1;
  let root = 1;

  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }

  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result: number[] = divisor.map(() => 0);

  for (const byte of data) {
    const factor = byte ^ (result.shift() as number);

    result.push(0);
    divisor.forEach((coef, index) => {
      result[index] ^= gfMul(coef, factor);
    });
  }

  return result;
}

/* ------------------------------------------------------------------ encoding */

function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function pickVersion(byteCount: number, ecc: QrEcc, minVersion: number): number {
  for (let version = Math.max(1, minVersion); version <= 40; version++) {
    const countBits = version <= 9 ? 8 : 16;
    const needed = 4 + countBits + byteCount * 8;

    if (needed <= dataCodewords(version, ecc) * 8) return version;
  }

  throw new Error('Text too long for a QR code');
}

function dataWithEcc(bytes: number[], version: number, ecc: QrEcc): number[] {
  const capacity = dataCodewords(version, ecc) * 8;
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  bytes.forEach((byte) => push(byte, 8));
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);

  const data: number[] = [];

  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));

  const numBlocks = NUM_ECC_BLOCKS[ecc][version];
  const eccLen = ECC_CODEWORDS_PER_BLOCK[ecc][version];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numShort = numBlocks - (rawCodewords % numBlocks);
  const shortLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];

  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));

    k += dat.length;
    const block = [...dat];
    const eccBytes = rsRemainder(dat, divisor);

    if (i < numShort) block.push(0);
    blocks.push(block.concat(eccBytes));
  }

  const result: number[] = [];

  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) result.push(block[i]);
    });
  }

  return result;
}

/* ------------------------------------------------------------------ the matrix */

class Grid {
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];

  constructor(readonly size: number) {
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }

  setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }
}

function drawFunctionPatterns(grid: Grid, version: number): void {
  const { size } = grid;

  for (let i = 0; i < size; i++) {
    grid.setFunction(6, i, i % 2 === 0);
    grid.setFunction(i, 6, i % 2 === 0);
  }

  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;

        if (x >= 0 && x < size && y >= 0 && y < size) grid.setFunction(x, y, dist !== 2 && dist !== 4);
      }
    }
  };

  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);

  const positions = alignmentPositions(version);
  const last = positions.length - 1;

  positions.forEach((px, i) => {
    positions.forEach((py, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) grid.setFunction(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    });
  });

  drawFormatBits(grid, 'L', 0); // reserve; redrawn with the real mask
  if (version >= 7) {
    let rem = version;

    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;

    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);

      grid.setFunction(a, b, bit(bits, i));
      grid.setFunction(b, a, bit(bits, i));
    }
  }
}

function drawFormatBits(grid: Grid, ecc: QrEcc, mask: number): void {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;

  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const { size } = grid;

  for (let i = 0; i <= 5; i++) grid.setFunction(8, i, bit(bits, i));
  grid.setFunction(8, 7, bit(bits, 6));
  grid.setFunction(8, 8, bit(bits, 7));
  grid.setFunction(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) grid.setFunction(14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i++) grid.setFunction(size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) grid.setFunction(8, size - 15 + i, bit(bits, i));
  grid.setFunction(8, size - 8, true);
}

function drawCodewords(grid: Grid, data: number[]): void {
  const { size } = grid;
  let i = 0;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;

        if (!grid.isFunction[y][x] && i < data.length * 8) {
          grid.modules[y][x] = bit(data[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(grid: Grid, mask: number): void {
  for (let y = 0; y < grid.size; y++) {
    for (let x = 0; x < grid.size; x++) {
      if (!grid.isFunction[y][x] && MASKS[mask](x, y)) grid.modules[y][x] = !grid.modules[y][x];
    }
  }
}

/** ISO 18004 §8.8.2 penalty (N1–N4). Lower is easier to scan. */
export function penaltyScore(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;
  const lines: boolean[][] = [];

  for (let y = 0; y < size; y++) lines.push(modules[y]);
  for (let x = 0; x < size; x++) lines.push(modules.map((row) => row[x]));

  const finderLike = [true, false, true, true, true, false, true];

  for (const line of lines) {
    let run = 1;

    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    for (let i = 0; i + 7 <= size; i++) {
      if (!finderLike.every((value, k) => line[i + k] === value)) continue;
      const lightBefore = i >= 4 && line.slice(i - 4, i).every((value) => !value);
      const lightAfter = i + 11 <= size && line.slice(i + 7, i + 11).every((value) => !value);

      if (lightBefore || lightAfter) score += 40;
    }
  }

  let dark = 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) dark++;
      if (
        x + 1 < size &&
        y + 1 < size &&
        modules[y][x] === modules[y][x + 1] &&
        modules[y][x] === modules[y + 1][x] &&
        modules[y][x] === modules[y + 1][x + 1]
      ) {
        score += 3;
      }
    }
  }

  const total = size * size;

  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;

  return score;
}

export interface QrCode {
  version: number;
  mask: number;
  size: number;
  /** `modules[y][x]` — true = dark. */
  modules: boolean[][];
}

export interface QrOptions {
  ecc?: QrEcc;
  /** Fixed mask 0–7; by default the lowest-penalty one. */
  mask?: number;
  minVersion?: number;
}

/** Encode `text` (UTF-8, byte mode) into a QR matrix. */
export function encodeQr(text: string, { ecc = 'M', mask, minVersion = 1 }: QrOptions = {}): QrCode {
  const bytes = utf8Bytes(text);
  const version = pickVersion(bytes.length, ecc, minVersion);
  const codewords = dataWithEcc(bytes, version, ecc);
  const build = (m: number) => {
    const grid = new Grid(version * 4 + 17);

    drawFunctionPatterns(grid, version);
    drawCodewords(grid, codewords);
    applyMask(grid, m);
    drawFormatBits(grid, ecc, m);

    return grid;
  };

  let best = mask ?? 0;

  if (mask === undefined) {
    let bestScore = Infinity;

    for (let m = 0; m < 8; m++) {
      const score = penaltyScore(build(m).modules);

      if (score < bestScore) {
        bestScore = score;
        best = m;
      }
    }
  }
  const grid = build(best);

  return { version, mask: best, size: grid.size, modules: grid.modules };
}

/** One SVG path (`M x y h1 v1 h-1 z` per dark module) offset by a quiet zone of `margin` modules. */
export function qrSvgPath(code: QrCode, margin = 4): string {
  const parts: string[] = [];

  code.modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${x + margin} ${y + margin}h1v1h-1z`);
    });
  });

  return parts.join('');
}
