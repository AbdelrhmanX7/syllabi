import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildImportAccept,
  HEIC_IMPORT_REJECTION,
  imageMimeTypeForFileName,
  isImportableImageFileName,
  isPdfFileName,
  isUndecodableImageFileName,
  MIXED_IMPORT_REJECTION,
  partitionImportFiles,
  routeImportSelection,
} from '../src/import-file-kinds';

const nameOf = (name: string) => name;

test('the formats the board can draw are recognised whatever the case of the extension', () => {
  for (const name of ['a.png', 'b.JPG', 'c.jpeg', 'd.WebP', 'e.gif', 'f.BMP']) {
    assert.equal(isImportableImageFileName(name), true, name);
  }

  assert.equal(isPdfFileName('lesson.PDF'), true);
  assert.equal(isImportableImageFileName('clip.mp4'), false);
  assert.equal(isImportableImageFileName('noextension'), false);
});

test('HEIC is an image but NOT an importable one — WebView2 cannot decode it', () => {
  assert.equal(isImportableImageFileName('IMG_0042.heic'), false);
  assert.equal(isUndecodableImageFileName('IMG_0042.heic'), true);
  assert.equal(isUndecodableImageFileName('IMG_0042.HEIF'), true);
});

test('the MIME type is derived from the name, since a natively picked file carries none', () => {
  assert.equal(imageMimeTypeForFileName('a.jpg'), 'image/jpeg');
  assert.equal(imageMimeTypeForFileName('a.JPEG'), 'image/jpeg');
  assert.equal(imageMimeTypeForFileName('a.png'), 'image/png');
  assert.equal(imageMimeTypeForFileName('a.webp'), 'image/webp');
  assert.equal(imageMimeTypeForFileName('a.gif'), 'image/gif');
  assert.equal(imageMimeTypeForFileName('a.bmp'), 'image/bmp');
  assert.equal(imageMimeTypeForFileName('a.heic'), 'application/octet-stream');
});

test('a selection is split by what each file can become, keeping the picked order', () => {
  const partition = partitionImportFiles(
    ['two.jpg', 'book.pdf', 'one.png', 'deck.pptx', 'phone.heic', 'clip.mov'],
    nameOf,
  );

  assert.deepEqual(partition.images, ['two.jpg', 'one.png']);
  assert.deepEqual(partition.pdfs, ['book.pdf']);
  assert.deepEqual(partition.office, ['deck.pptx']);
  assert.deepEqual(partition.undecodableImages, ['phone.heic']);
  assert.deepEqual(partition.other, ['clip.mov']);
});

test('an all-image selection routes to the image path, every file in order', () => {
  const route = routeImportSelection(['b.jpg', 'a.png', 'c.bmp'], nameOf);

  assert.equal(route.kind, 'images');
  assert.deepEqual(route.kind === 'images' ? route.files : [], ['b.jpg', 'a.png', 'c.bmp']);
});

test('an all-PDF selection routes to the PDF path, which takes one file (the page picker is per-file)', () => {
  const route = routeImportSelection(['first.pdf', 'second.pdf'], nameOf);

  assert.equal(route.kind, 'pdf');
  assert.equal(route.kind === 'pdf' ? route.file : '', 'first.pdf');
});

test('a MIXED selection is refused with one message rather than half-imported', () => {
  const route = routeImportSelection(['book.pdf', 'photo.jpg'], nameOf);

  assert.equal(route.kind, 'rejected');
  assert.equal(route.kind === 'rejected' ? route.message : '', MIXED_IMPORT_REJECTION);
  // The refusal must tell the user what to do instead.
  assert.match(MIXED_IMPORT_REJECTION, /separately/);
});

test('a HEIC-only selection names HEIC specifically, since the teacher can fix it on the phone', () => {
  const route = routeImportSelection(['IMG_1.heic', 'IMG_2.heic'], nameOf);

  assert.equal(route.kind, 'rejected');
  assert.equal(route.kind === 'rejected' ? route.message : '', HEIC_IMPORT_REJECTION);
});

test('PowerPoint only counts as a document where the host can convert it', () => {
  const withConverter = routeImportSelection(['deck.pptx'], nameOf, { office: true });

  assert.equal(withConverter.kind, 'pdf');

  const withoutConverter = routeImportSelection(['deck.pptx'], nameOf);

  assert.equal(withoutConverter.kind, 'rejected');
});

test('a PowerPoint mixed with photos is refused, not silently reduced to the photos', () => {
  const route = routeImportSelection(['deck.pptx', 'photo.jpg'], nameOf, { office: true });

  assert.equal(route.kind, 'rejected');
  assert.equal(route.kind === 'rejected' ? route.message : '', MIXED_IMPORT_REJECTION);
});

test('the picker accept string follows what the host can take', () => {
  assert.equal(buildImportAccept({ images: false, office: false }), '.pdf');
  assert.match(buildImportAccept({ images: true, office: true }), /\.pptx/);
  assert.match(buildImportAccept({ images: true, office: false }), /image\/webp/);
});
