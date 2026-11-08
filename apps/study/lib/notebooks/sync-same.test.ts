import assert from 'node:assert/strict';
import test from 'node:test';

import { sameDocument } from './sync';

test('same ink with different save times is the same document', () => {
  const a = { id: 'p', updatedAt: 1, pages: [{ id: 'a', canvasJSON: { objects: [{ type: 'path', d: 'M0 0' }] }, updatedAt: 5 }] };
  const b = { pages: [{ updatedAt: 9, canvasJSON: { objects: [{ d: 'M0 0', type: 'path' }] }, id: 'a' }], updatedAt: 2, id: 'p' };
  assert.equal(sameDocument(a, b), true);
});

test('different ink is a different document', () => {
  const a = { pages: [{ canvasJSON: { objects: [{ d: 'M0 0' }] } }] };
  const b = { pages: [{ canvasJSON: { objects: [{ d: 'M0 1' }] } }] };
  assert.equal(sameDocument(a, b), false);
});
