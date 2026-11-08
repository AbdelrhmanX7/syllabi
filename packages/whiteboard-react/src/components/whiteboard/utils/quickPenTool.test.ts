import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveQuickPenTool } from './quickPenTool';

describe('resolveQuickPenTool (a colour picked from the pen shortcuts)', () => {
  it('keeps any tool that draws in colour, including the pen type', () => {
    for (const tool of ['pen', 'brush', 'marker', 'script', 'highlighter', 'rect', 'circle', 'triangle', 'line', 'arrow', 'text'] as const) {
      assert.equal(resolveQuickPenTool(tool, 'pen'), tool);
    }
  });

  it('from the eraser or select tool, goes back to the last drawing tool, not the plain pen', () => {
    assert.equal(resolveQuickPenTool('eraser', 'script'), 'script');
    assert.equal(resolveQuickPenTool('select', 'highlighter'), 'highlighter');
    assert.equal(resolveQuickPenTool('pan', 'brush'), 'brush');
  });

  it('falls back to the pen only when there was no drawing tool', () => {
    assert.equal(resolveQuickPenTool('select', 'select'), 'pen');
    assert.equal(resolveQuickPenTool('eraser', null), 'pen');
  });
});
