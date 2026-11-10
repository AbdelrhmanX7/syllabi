#!/usr/bin/env node
/**
 * Heavy test PDFs for the board's PDF path, made from nothing (no libraries, no real course material):
 *
 *   node tools/perf-trace/fixtures/make-pdf.mjs            # writes textbook.pdf + scanned.pdf next to this file
 *
 * - textbook.pdf: 40 Letter pages, two columns of dense small text, a plotted curve (2,000-point path),
 *   a grid, filled shapes and a small photo-like image per page — the vector/text-heavy case.
 * - textbook-200.pdf: the same, 200 pages (a whole course reader) — import time scales with pages.
 * - scanned.pdf: 30 pages, each one 1700×2200 greyscale image (a phone scan of handwritten notes) —
 *   the big-raster case.
 * Both are gitignored outputs; regenerate any time (the content is deterministic).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Deterministic noise so every run writes the same bytes. */
function rng(seed) {
  let s = seed >>> 0;

  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const WORDS =
  'the of and a to in is that for it as was with be by on not he this are or his from at which but have an they you were her she there would their we him been has when who will more no if out so said what up its about into than them can only other new some could time these two may then do first any my now such like our over man me even most made after also did many before must through back years where much your way well down should because each just those people how too little state good very make world still own see men work long get here between both life being under never day same another know while last might us great old year off come since against go came right used take three'.split(
    ' ',
  );

function sentence(next, n) {
  return Array.from({ length: n }, () => WORDS[Math.floor(next() * WORDS.length)]).join(' ');
}

const esc = (text) => text.replace(/[\\()]/g, (c) => `\\${c}`);

/** A minimal PDF writer: numbered objects, a page tree, an xref table. */
function writePdf(file, pages) {
  const objects = []; // index = object number - 1
  const add = (body) => (objects.push(body), objects.length);
  const fontRegular = add(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>'));
  const fontBold = add(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'));
  const pagesId = objects.length + 1;

  add(null); // page tree, filled in below
  const kids = [];

  for (const page of pages) {
    const images = page.images.map(({ width, height, gray, data }) =>
      add(
        Buffer.concat([
          Buffer.from(
            `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /${gray ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`,
          ),
          data,
          Buffer.from('\nendstream'),
        ]),
      ),
    );
    const content = zlib.deflateSync(Buffer.from(page.content));
    const contentId = add(
      Buffer.concat([
        Buffer.from(`<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`),
        content,
        Buffer.from('\nendstream'),
      ]),
    );
    const xobjects = images.map((id, i) => `/Im${i} ${id} 0 R`).join(' ');

    kids.push(
      add(
        Buffer.from(
          `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> /XObject << ${xobjects} >> >> >>`,
        ),
      ),
    );
  }
  objects[pagesId - 1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  const catalog = add(Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`));

  const chunks = [Buffer.from('%PDF-1.5\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets = [];
  let offset = chunks[0].length;

  objects.forEach((body, i) => {
    const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);

    offsets.push(offset);
    offset += obj.length;
    chunks.push(obj);
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');

  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  fs.writeFileSync(file, Buffer.concat(chunks));

  return fs.statSync(file).size;
}

function textbookPage(index) {
  const next = rng(1000 + index);
  const ops = [];

  ops.push(`BT /F2 16 Tf 54 740 Td (${esc(`Chapter ${Math.floor(index / 5) + 1}.${(index % 5) + 1}  ${sentence(next, 4)}`)}) Tj ET`);
  // Two columns of dense 8pt text.
  for (const x of [54, 318]) {
    ops.push(`BT /F1 8 Tf 9.6 TL ${x} 712 Td`);
    for (let line = 0; line < 38; line += 1) ops.push(`(${esc(sentence(next, 9))}) '`);
    ops.push('ET');
  }
  // A figure: grid + a 2,000-point curve + filled bars.
  ops.push('q 0.85 G 0.4 w');
  for (let gx = 0; gx <= 20; gx += 1) ops.push(`${54 + gx * 25} 60 m ${54 + gx * 25} 300 l S`);
  for (let gy = 0; gy <= 12; gy += 1) ops.push(`54 ${60 + gy * 20} m 554 ${60 + gy * 20} l S`);
  ops.push('Q q 0.1 0.3 0.8 RG 1.2 w');
  for (let p = 0; p < 2000; p += 1) {
    const x = 54 + (p / 2000) * 500;
    const y = 180 + Math.sin(p / (40 + index)) * 80 * Math.cos(p / 300) + (next() - 0.5) * 6;

    ops.push(`${x.toFixed(2)} ${y.toFixed(2)} ${p ? 'l' : 'm'}`);
  }
  ops.push('S Q');
  for (let bar = 0; bar < 30; bar += 1) {
    ops.push(`q ${(0.3 + next() * 0.6).toFixed(2)} 0.5 ${(0.2 + next() * 0.6).toFixed(2)} rg ${60 + bar * 16} 62 10 ${(next() * 90).toFixed(1)} re f Q`);
  }
  // A small photo-like image in the corner.
  ops.push('q 120 0 0 90 434 650 cm /Im0 Do Q');
  const width = 240;
  const height = 180;
  const raw = Buffer.alloc((width * 3 + 1) * height);

  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const o = y * (width * 3 + 1) + 1 + x * 3;

      raw[o] = (x + index * 9) & 255;
      raw[o + 1] = (y * 2) & 255;
      raw[o + 2] = (next() * 255) | 0;
    }
  }

  // Raw scanlines with a leading filter byte need /DecodeParms; keep it simple with plain bytes.
  const plain = Buffer.alloc(width * 3 * height);

  for (let y = 0; y < height; y += 1) raw.copy(plain, y * width * 3, y * (width * 3 + 1) + 1, (y + 1) * (width * 3 + 1));

  return { content: ops.join('\n'), images: [{ width, height, gray: false, data: zlib.deflateSync(plain) }] };
}

function scannedPage(index) {
  const next = rng(5000 + index);
  const width = 1700;
  const height = 2200;
  const px = Buffer.alloc(width * height, 236);

  // Paper grain + ruled lines + handwriting-like dark scribbles.
  for (let i = 0; i < px.length; i += 1) px[i] = next() < 0.06 ? 214 : 236;
  for (let y = 180; y < height; y += 64) px.fill(170, y * width, y * width + width);
  for (let stroke = 0; stroke < 900; stroke += 1) {
    let x = 120 + next() * 1460;
    let y = 160 + Math.floor(next() * 31) * 64 + next() * 40;

    for (let step = 0; step < 60; step += 1) {
      x += (next() - 0.3) * 4;
      y += (next() - 0.5) * 4;
      for (let dy = -1; dy <= 1; dy += 1)
        for (let dx = -1; dx <= 1; dx += 1) {
          const xi = Math.round(x + dx);
          const yi = Math.round(y + dy);

          if (xi >= 0 && xi < width && yi >= 0 && yi < height) px[yi * width + xi] = 40;
        }
    }
  }

  return { content: 'q 612 0 0 792 0 0 cm /Im0 Do Q', images: [{ width, height, gray: true, data: zlib.deflateSync(px, { level: 6 }) }] };
}

const textbook = writePdf(path.join(HERE, 'textbook.pdf'), Array.from({ length: 40 }, (_, i) => textbookPage(i)));
const big = writePdf(path.join(HERE, 'textbook-200.pdf'), Array.from({ length: 200 }, (_, i) => textbookPage(i)));
const scanned = writePdf(path.join(HERE, 'scanned.pdf'), Array.from({ length: 30 }, (_, i) => scannedPage(i)));

console.log(`textbook.pdf ${(textbook / 1e6).toFixed(1)} MB · textbook-200.pdf ${(big / 1e6).toFixed(1)} MB · scanned.pdf ${(scanned / 1e6).toFixed(1)} MB`);
