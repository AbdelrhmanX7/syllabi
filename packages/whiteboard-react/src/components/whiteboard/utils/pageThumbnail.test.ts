import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pageInkKey, thumbnailView } from './pageThumbnail';

const PAGE = { left: 0, top: 0, width: 1000, height: 1414 };

describe('thumbnailView', () => {
  it('shows the page top at the tile aspect when nothing is written', () => {
    assert.deepEqual(thumbnailView(PAGE, []), { left: 0, top: 0, width: 1000, height: 1000 * (80 / 140) });
  });

  it('zooms to the writing, padded, at the tile aspect, inside the page', () => {
    const view = thumbnailView(PAGE, [{ left: 300, top: 600, width: 400, height: 100 }]);

    assert.ok(Math.abs(view.height / view.width - 80 / 140) < 1e-9);
    assert.ok(view.width >= 400 && view.width < 1000);
    assert.ok(view.left <= 300 && view.left + view.width >= 700);
    assert.ok(view.top <= 600 && view.top + view.height >= 700);
  });

  it('never zooms closer than 40% of the page width', () => {
    assert.equal(thumbnailView(PAGE, [{ left: 500, top: 500, width: 10, height: 10 }]).width, 400);
  });

  it('keeps a view near the page edge inside the page', () => {
    const view = thumbnailView(PAGE, [{ left: 0, top: 0, width: 50, height: 20 }]);

    assert.equal(view.left, 0);
    assert.equal(view.top, 0);
  });
});

describe('pageInkKey', () => {
  it('changes when a stroke is appended and not otherwise', () => {
    const json = JSON.stringify({ objects: Array.from({ length: 200 }, (_, i) => ({ type: 'Path', path: [i, i * 2] })) });

    assert.equal(pageInkKey(json), pageInkKey(json.slice()));
    assert.notEqual(pageInkKey(json), pageInkKey(json.replace(/]}$/, ',{"type":"Path"}]}')));
  });
});
