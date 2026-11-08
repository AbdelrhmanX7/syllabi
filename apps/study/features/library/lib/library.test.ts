import type { LibraryDoc } from '@/lib/api/types';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { filterDocs, groupByWeek, prepareNoteMarkdown } from './library';

const doc = (id: string, kind: LibraryDoc['kind'], week: number | null, title = id): LibraryDoc => ({
  id,
  title,
  kind,
  week,
  path: `w/${id}`,
  updatedAt: null,
});

test('groupByWeek: weeks ascending, week-less last, notes → pdfs → images', () => {
  const groups = groupByWeek([
    doc('book', 'pdf', null),
    doc('w2pdf', 'pdf', 2),
    doc('w1img', 'image', 1),
    doc('w1note', 'note', 1),
    doc('w1pdf', 'pdf', 1),
  ]);

  assert.deepEqual(
    groups.map((group) => [group.week, group.docs.map((item) => item.id)]),
    [
      [1, ['w1note', 'w1pdf', 'w1img']],
      [2, ['w2pdf']],
      [null, ['book']],
    ],
  );
});

test('filterDocs by kind and by title/path text', () => {
  const docs = [doc('a', 'note', 1, 'Plate tectonics'), doc('b', 'pdf', 1, 'Minerals')];

  assert.deepEqual(
    filterDocs(docs, 'pdf', '').map((item) => item.id),
    ['b'],
  );
  assert.deepEqual(
    filterDocs(docs, 'all', 'TECTON').map((item) => item.id),
    ['a'],
  );
});

test('prepareNoteMarkdown unwraps <signed urls> and puts each image on its own line', () => {
  const md = 'See the tray ![kit](<https://b2/x.jpg?sig=a b>) here and [the pdf](<https://b2/y.pdf>).';

  assert.equal(
    prepareNoteMarkdown(md),
    'See the tray\n\n![kit](https://b2/x.jpg?sig=a%20b)\n\nhere and [the pdf](https://b2/y.pdf).',
  );
  assert.equal(prepareNoteMarkdown('# Title\n\nplain'), '# Title\n\nplain');
  assert.equal(prepareNoteMarkdown('Letter\n\n* * *\n\nHello\n\n---\n- item'), 'Letter\n\nHello\n\n- item');
});
