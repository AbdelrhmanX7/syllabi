import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { remakeSnapshotLayers } from './remakeSnapshot';

describe('remake snapshot selection (owner: no handwriting to the AI)', () => {
  it('a PDF / image page sends its background only — ink, shapes and AI objects stay home', () => {
    assert.equal(remakeSnapshotLayers({ hasPicture: true, lockedImages: 0 }), 'background');
  });

  it('pinned pictures count as background content', () => {
    assert.equal(remakeSnapshotLayers({ hasPicture: false, lockedImages: 2 }), 'background');
  });

  it('a blank / grid page keeps its ink: the questions ARE the teacher’s writing', () => {
    assert.equal(remakeSnapshotLayers({ hasPicture: false, lockedImages: 0 }), 'all');
  });

  it('unknown page (no bridge info) falls back to everything, as before', () => {
    assert.equal(remakeSnapshotLayers(null), 'all');
    assert.equal(remakeSnapshotLayers(undefined), 'all');
  });
});
