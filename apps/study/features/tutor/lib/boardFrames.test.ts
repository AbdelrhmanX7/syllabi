import assert from 'node:assert/strict';
import { test } from 'node:test';

import { conceptStyleWire, toBoardAiEvent } from './boardFrames';

test('text-ish frames become text events; meta and sources are dropped', () => {
  assert.deepEqual(toBoardAiEvent({ event: 'delta', data: { text: 'a' } }, 'blocks'), { type: 'text', data: 'a' });
  assert.deepEqual(toBoardAiEvent({ event: 'text', data: 'b' }, 'blocks'), { type: 'text', data: 'b' });
  assert.deepEqual(toBoardAiEvent({ event: 'status', data: 'reading' }, 'blocks'), { type: 'status', data: 'reading' });
  assert.equal(toBoardAiEvent({ event: 'meta', data: { conversationId: 'c' } }, 'blocks'), null);
  assert.equal(toBoardAiEvent({ event: 'sources', data: { sources: [] } }, 'blocks'), null);
  assert.deepEqual(toBoardAiEvent({ event: 'done', data: null }, 'blocks'), { type: 'done' });
});

test('result frames are typed by the asking method', () => {
  const blocks = [{ type: 'paragraph', text: 'p' }];

  assert.deepEqual(toBoardAiEvent({ event: 'result', data: { blocks } }, 'blocks'), {
    type: 'result',
    data: { blocks },
  });
  assert.equal(toBoardAiEvent({ event: 'result', data: { nope: 1 } }, 'blocks'), null);
  assert.equal(toBoardAiEvent({ event: 'result', data: { pageType: 'solution' } }, 'analysis')?.type, 'analysis');
  const generated = toBoardAiEvent({ event: 'result', data: { graph: {} } }, 'conceptGenerate');

  assert.equal(generated?.type, 'concept_map');
  assert.equal((generated as { data: { serverLayout?: boolean } }).data.serverLayout, true);
  assert.equal(toBoardAiEvent({ event: 'result', data: { graph: {} } }, 'concept')?.type, 'concept_map');
  assert.equal(toBoardAiEvent({ event: 'result', data: { blocks: [] } }, 'layout')?.type, 'layout');
});

test('error frames carry a message, string or object', () => {
  assert.deepEqual(toBoardAiEvent({ event: 'error', data: 'x' }, 'blocks'), { type: 'error', data: 'x' });
  assert.deepEqual(toBoardAiEvent({ event: 'error', data: { message: 'y', code: 'Z' } }, 'blocks'), {
    type: 'error',
    data: 'y',
  });
  assert.match((toBoardAiEvent({ event: 'error', data: {} }, 'blocks') as { data: string }).data, /could not/);
});

test('conceptStyleWire', () => {
  assert.equal(conceptStyleWire(undefined), undefined);
  assert.equal(conceptStyleWire({ shape: 'diamond' }), undefined);
  assert.deepEqual(conceptStyleWire({ direction: 'tb', shape: 'rounded', nodeColors: ['#000'] }), {
    direction: 'TB',
    shape: 'rounded',
    palette: ['#000'],
  });
});

test('termsMap: a result frame (bare or wrapped) and a terms_map frame → terms_map', () => {
  const map = { direction: 'TB', nodes: [{ id: 'n1', text: 'A', clusterIds: ['c1'], level: 0 }], edges: [], extra: [] };

  assert.deepEqual(toBoardAiEvent({ event: 'result', data: map }, 'termsMap'), { type: 'terms_map', data: map });
  assert.deepEqual(toBoardAiEvent({ event: 'result', data: { termsMap: map } }, 'termsMap'), { type: 'terms_map', data: map });
  assert.deepEqual(toBoardAiEvent({ event: 'terms_map', data: map }, 'blocks'), { type: 'terms_map', data: map });
});
