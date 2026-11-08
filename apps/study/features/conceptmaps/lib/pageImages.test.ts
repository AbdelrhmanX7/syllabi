import type { KeyValueStore } from '../notes/links';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  b64LengthForBytes,
  collectPageImages,
  docHasImages,
  lectureContextFor,
  MAX_MAP_IMAGES,
  mergeImageTerms,
  PHONE_MARKS_KEY,
  planImageDownscale,
  readPhoneMarks,
  referenceWireBody,
  rememberPhoneImage,
  withImageSources,
} from './pageImages';

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();

  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
}

/** A data URL whose base64 payload is exactly what a file of `bytes` reads as. */
const dataUrl = (bytes: number, fill = 'A', mime = 'image/jpeg') =>
  `data:${mime};base64,${fill.repeat(b64LengthForBytes(bytes))}`;

const scene = (...objects: unknown[]) => JSON.stringify({ version: '6', objects });
const image = (src: string, width = 1200, height = 900, extra: Record<string, unknown> = {}) => ({
  type: 'Image',
  src,
  width,
  height,
  ...extra,
});

test('b64LengthForBytes matches FileReader base64 length (padding included)', () => {
  assert.equal(b64LengthForBytes(3), 4);
  assert.equal(b64LengthForBytes(4), 8);
  assert.equal(b64LengthForBytes(5), 8);
  assert.equal(b64LengthForBytes(300_000), 400_000);
});

test('collectPageImages: phone photos first (newest first), then page pictures in page order', () => {
  const phoneOld = dataUrl(1000, 'B');
  const phoneNew = dataUrl(2000, 'C');
  const page1 = dataUrl(1500, 'D', 'image/png');
  const remote = 'https://cdn.example/slide.png';
  const doc = {
    pages: [
      { canvasJSON: scene({ type: 'Path', path: [] }, image(page1), image(phoneOld)) },
      { canvasJSON: scene({ type: 'Group', objects: [image(remote)] }, image(phoneNew)) },
    ],
  };
  const marks = [
    { bytes: 1000, inboxItemId: 'inb-1', at: 10 },
    { bytes: 2000, inboxItemId: 'inb-2', at: 20 },
  ];
  const out = collectPageImages(doc, marks);

  assert.deepEqual(
    out.map((row) => [row.origin, row.inboxItemId ?? null, row.src.slice(0, 30)]),
    [
      ['phone', 'inb-2', phoneNew.slice(0, 30)],
      ['phone', 'inb-1', phoneOld.slice(0, 30)],
      ['page', null, page1.slice(0, 30)],
      ['page', null, remote.slice(0, 30)],
    ],
  );
});

test('collectPageImages: no marks → every picture is a page picture; hidden, tiny, duplicate and broken ones dropped', () => {
  const big = dataUrl(900);
  const doc = {
    pages: [
      {
        canvasJSON: scene(
          image(big),
          image(big),
          image(dataUrl(50, 'E'), 32, 32),
          image(dataUrl(70, 'F'), 800, 600, { visible: false }),
        ),
      },
      { canvasJSON: '{not json' },
      { canvasJSON: null },
      {},
    ],
  };
  const out = collectPageImages(doc);

  assert.equal(out.length, 1);
  assert.equal(out[0]!.origin, 'page');
  assert.deepEqual(collectPageImages(null), []);
  assert.deepEqual(collectPageImages({ pages: [{ canvasJSON: scene({ type: 'Textbox', text: 'hi' }) }] }), []);
});

test('collectPageImages caps the list (phone photos keep their place ahead of the cut)', () => {
  const pictures = Array.from({ length: 6 }, (_, index) =>
    image(dataUrl(1000 + index * 3, String.fromCharCode(71 + index))),
  );
  const phone = image(dataUrl(5000, 'Z'));
  const out = collectPageImages({ pages: [{ canvasJSON: scene(...pictures, phone) }] }, [{ bytes: 5000, at: 1 }]);

  assert.equal(out.length, MAX_MAP_IMAGES);
  assert.equal(out[0]!.origin, 'phone');
});

test('phone marks: remembered per page, deduped by size, stale pages dropped, junk tolerated', () => {
  const store = memoryStore();
  const day = 24 * 60 * 60 * 1000;

  rememberPhoneImage(store, 'pg-old', { bytes: 10 }, 0);
  rememberPhoneImage(store, 'pg1', { bytes: 500, inboxItemId: 'a' }, 100 * day);
  rememberPhoneImage(store, 'pg1', { bytes: 500, inboxItemId: 'b' }, 100 * day + 1);
  rememberPhoneImage(store, 'pg1', { bytes: 0 }, 100 * day + 2);

  assert.deepEqual(readPhoneMarks(store, 'pg1'), [{ bytes: 500, inboxItemId: 'b', at: 100 * day + 1 }]);
  assert.deepEqual(readPhoneMarks(store, 'pg-old'), []);
  assert.deepEqual(readPhoneMarks(null, 'pg1'), []);

  store.setItem(PHONE_MARKS_KEY, '"broken"');
  assert.deepEqual(readPhoneMarks(store, 'pg1'), []);
});

test('planImageDownscale: long edge over 1600 → scaled to 1600, aspect kept; otherwise untouched', () => {
  assert.deepEqual(planImageDownscale({ width: 4032, height: 3024 }), { width: 1600, height: 1200, resize: true });
  assert.deepEqual(planImageDownscale({ width: 1080, height: 2400 }), { width: 720, height: 1600, resize: true });
  assert.deepEqual(planImageDownscale({ width: 1600, height: 900 }), { width: 1600, height: 900, resize: false });
  assert.deepEqual(planImageDownscale({ width: 800, height: 600 }), { width: 800, height: 600, resize: false });
  // Unknown size (old scene without width/height): nothing to plan on — the browser re-encode decides.
  assert.deepEqual(planImageDownscale({ width: 0, height: 0 }), { width: 0, height: 0, resize: false });
  assert.deepEqual(planImageDownscale({ width: 3000, height: 1 }, 1000), { width: 1000, height: 1, resize: true });
});

test('mergeImageTerms: first wording wins across pictures, case/space-insensitive, capped', () => {
  assert.deepEqual(
    mergeImageTerms([
      ['Fault', 'Epicenter', ' focus '],
      ['FAULT', 'Seismic  wave', 'Focus'],
    ]),
    ['Fault', 'Epicenter', 'focus', 'Seismic wave'],
  );
  assert.equal(mergeImageTerms([Array.from({ length: 30 }, (_, i) => `term ${i}`)]).length, 15);
  assert.deepEqual(mergeImageTerms([['', '  ']]), []);
});

test('lectureContextFor: the lecture note map wins, then a linked map; the lecture scope from the record', () => {
  assert.deepEqual(
    lectureContextFor('pg1', { week: 6, lecture: 12, mapId: 'm-note', key: 'L12', date: '2026-10-07' }, ['m-linked']),
    { pageId: 'pg1', mapId: 'm-note', week: 6, lecture: { number: 12, key: 'L12', date: '2026-10-07' } },
  );
  assert.deepEqual(lectureContextFor('pg1', { week: 6, lecture: null, mapId: null }, ['m-linked', 'm-older']), {
    pageId: 'pg1',
    mapId: 'm-linked',
    week: 6,
    lecture: null,
  });
  // A number alone still names the lecture (the key the backend files notes under).
  assert.deepEqual(lectureContextFor('pg1', { lecture: 3 }).lecture, { number: 3, key: 'L3', date: null });
  assert.deepEqual(lectureContextFor('pg2', null), { pageId: 'pg2', mapId: null, week: null, lecture: null });
  // Junk from an old device record is not a lecture.
  assert.deepEqual(lectureContextFor('pg2', { week: 2.5, lecture: Number.NaN, mapId: '  ' }), {
    pageId: 'pg2',
    mapId: null,
    week: null,
    lecture: null,
  });
});

test('withImageSources: one «Photo» source per picture ahead of the backend sources, never doubled', () => {
  const images = collectPageImages(
    { pages: [{ canvasJSON: scene(image(dataUrl(700, 'P')), image(dataUrl(800, 'Q'))) }] },
    [{ bytes: 700, at: 1 }],
  );
  const merged = withImageSources(
    { model: 'gpt-6.1-sol', sources: [{ kind: 'notes', title: 'Your notes — L12' }] },
    images,
  );

  assert.deepEqual(merged.sources, [
    { kind: 'image', title: 'Photo from your phone' },
    { kind: 'image', title: 'Picture on this page' },
    { kind: 'notes', title: 'Your notes — L12' },
  ]);
  assert.equal(merged.model, 'gpt-6.1-sol');
  // The backend already listed both pictures (it read them): nothing added.
  assert.deepEqual(withImageSources(merged, images).sources.length, 3);
  assert.deepEqual(withImageSources(null, []), { model: null, sources: [] });
});

test('referenceWireBody: pictures stay off the live wire until the backend reads them; mock gets everything', () => {
  const body = {
    classId: 'c1',
    promptTerms: ['Fault'],
    mapId: 'm1',
    pageId: 'pg1',
    lecture: { number: 12, key: 'L12', date: null, week: 6 },
    images: [{ jpegB64: 'AAAA', width: 10, height: 10, origin: 'phone' as const }],
  };
  const { images: _images, ...live } = body;

  assert.deepEqual(referenceWireBody(body, true, false), live);
  assert.equal(referenceWireBody(body, false, false), body);
  assert.equal(referenceWireBody(body, true, true), body);
  const plain = { classId: 'c1', promptTerms: ['Fault'] };

  assert.equal(referenceWireBody(plain, true, false), plain);
});

test('collectPageImages keeps the board crop (the region the board shows), none when uncropped', () => {
  const src = dataUrl(3000, 'K');
  const [cropped] = collectPageImages({
    pages: [{ canvasJSON: scene(image(src, 500, 300, { cropX: 120, cropY: 40 })) }],
  });
  const [whole] = collectPageImages({ pages: [{ canvasJSON: scene(image(src, 500, 300, { cropX: 0, cropY: 0 })) }] });

  assert.deepEqual(cropped!.crop, { x: 120, y: 40 });
  assert.equal(cropped!.width, 500);
  assert.equal(whole!.crop, undefined);
});

test('docHasImages: a string test on the raw scene — pictures yes, ink / text / broken no', () => {
  assert.equal(
    docHasImages({ pages: [{ canvasJSON: scene({ type: 'Path' }) }, { canvasJSON: scene(image(dataUrl(900))) }] }),
    true,
  );
  assert.equal(docHasImages({ pages: [{ canvasJSON: '{"objects":[{"type": "image","src":"x"}]}' }] }), true);
  assert.equal(docHasImages({ pages: [{ canvasJSON: scene({ type: 'Textbox', text: 'image' }) }, {}] }), false);
  assert.equal(docHasImages(null), false);
});
