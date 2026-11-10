import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { describeMockPage, patchPageMeta, withMetaDefaults } from '../api/mock/page-meta';
import type { Page } from '../api/types';

import { isAutoNoteTitle } from './note-title';
import {
  boardHasContent,
  cardTags,
  normalizeTag,
  normalizeTags,
  noteRowLine,
  tagsInUse,
  wantsAutoDescribe,
  withTag,
} from './page-meta';

const page = (over: Partial<Page> = {}): Page => ({
  id: 'pg1',
  classId: null,
  itemId: null,
  lectureId: null,
  title: 'Note · Nov 10',
  kind: 'note',
  updatedAt: '2026-11-10T00:00:00.000Z',
  version: 3,
  thumbUrl: null,
  ...over,
});

describe('notebook details helpers', () => {
  test('tags are cleaned like the server does', () => {
    assert.equal(normalizeTag('  #Physics  '), 'physics');
    assert.deepEqual(normalizeTags(['A', 'a', '', 'b', 'c', 'd', 'e', 'f', 'g']), ['a', 'b', 'c', 'd', 'e', 'f']);
  });

  test('row line: tags before the time', () => {
    assert.equal(noteRowLine(['math', 'limits'], '2h ago'), 'math · limits · 2h ago');
    assert.equal(noteRowLine([], '2h ago', 'MATH 101'), 'MATH 101 · 2h ago');
  });

  test('"Note · Nov 10" is a generated name', () => {
    assert.ok(isAutoNoteTitle('Note · Nov 10'));
  });

  test('auto describe: owner, content, never described or 5 versions on', () => {
    assert.equal(wantsAutoDescribe({ version: 3, metaAiVersion: null }, true), true);
    assert.equal(wantsAutoDescribe({ version: 3, metaAiVersion: null }, false), false);
    assert.equal(wantsAutoDescribe({ version: 7, metaAiVersion: 3 }, true), false);
    assert.equal(wantsAutoDescribe({ version: 8, metaAiVersion: 3 }, true), true);
    assert.equal(wantsAutoDescribe({ version: 3, metaAiVersion: null, shared: { role: 'editor', ownerName: 'x' } }, true), false);
    // An older backend sends no metaAiVersion: never ask.
    assert.equal(wantsAutoDescribe({ version: 30 }, true), false);
  });

  test('board content check', () => {
    assert.equal(boardHasContent([{ canvasJSON: '{"objects":[]}' }]), false);
    assert.equal(boardHasContent([{ canvasJSON: '{"objects":[{"type":"path"}]}' }]), true);
    assert.equal(boardHasContent([{ canvasJSON: '', pdfAssetId: 'a1' }]), true);
  });
});

describe('demo mode describe', () => {
  test('fills every field of a fresh notebook, deterministically', () => {
    const a = describeMockPage(page({ title: 'Calculus — Week 2 · Mon Oct 5' }), {}, 'MATH 101');
    const b = describeMockPage(page({ title: 'Calculus — Week 2 · Mon Oct 5' }), {}, 'MATH 101');

    assert.equal(a.title, b.title);
    assert.deepEqual(a.tags, ['math', 'calculus', 'math 101']);
    assert.equal(a.cover?.kind, 'color');
    assert.equal(a.metaAiVersion, 3);
  });

  test('never overwrites what the owner edited; Let AI pick hands it back', () => {
    const p = patchPageMeta(page(), { description: 'mine', tags: ['own'] });
    const out = describeMockPage(p, { force: true }, null);

    assert.equal(out.description, 'mine');
    assert.deepEqual(out.tags, ['own']);
    assert.equal(out.metaEdited?.description, true);

    const back = patchPageMeta(p, { aiPick: ['tags'] });
    const again = describeMockPage(back, { force: true }, null);

    assert.notDeepEqual(again.tags, ['own']);
    assert.equal(again.description, 'mine');
  });

  test('a typed title is the owner’s; removing the cover keeps it off until asked', () => {
    const p = page({ title: 'My exam notes' });
    const out = describeMockPage(p, {}, null);

    assert.equal(out.title, 'My exam notes');
    patchPageMeta(p, { cover: null });
    assert.equal(describeMockPage(p, { force: true }, null).cover, null);
    assert.equal(describeMockPage(p, { only: 'cover' }, null).cover?.kind, 'color');
  });

  test('defaults for pages saved before the fields existed', () => {
    const p = withMetaDefaults(page());

    assert.equal(p.mathTools, 'auto');
    assert.equal(p.metaAiVersion, null);
  });
});

describe('notes grid tags', () => {
  test('tagsInUse: most used first, ties alphabetical, no repeats from one notebook', () => {
    const pages = [{ tags: ['math', 'exam'] }, { tags: ['bio', 'exam', 'exam'] }, { tags: ['bio', 'exam'] }, {}];

    assert.deepEqual(tagsInUse(pages), ['exam', 'bio', 'math']);
  });

  test('withTag keeps notebooks with the tag; null keeps all', () => {
    const pages = [{ id: 'a', tags: ['math'] }, { id: 'b', tags: [] }, { id: 'c' }];

    assert.deepEqual(withTag(pages, 'math').map((p) => p.id), ['a']);
    assert.equal(withTag(pages, null).length, 3);
  });

  test('cardTags: three tags then a count', () => {
    assert.deepEqual(cardTags(['a', 'b', 'c', 'd', 'e']), { shown: ['a', 'b', 'c'], more: 2 });
    assert.deepEqual(cardTags(undefined), { shown: [], more: 0 });
  });
});
