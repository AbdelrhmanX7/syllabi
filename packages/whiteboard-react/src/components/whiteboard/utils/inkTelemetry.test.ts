import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatInkTelemetry, INK_DETAIL_MAX, inkTelemetry } from './inkTelemetry';
import { perfMark, setPerfSpanRecorder } from './perfSpan';

test('formatInkTelemetry(): compact pipe detail, trailing blanks trimmed', () => {
  assert.deepEqual(
    formatInkTelemetry({ op: 'classify', engine: 'mlkit', lang: 'en', cls: 'term', conf: 0.8, ms: 42.4, src: 'rules' }),
    { label: 'ink-classify', ms: 42, detail: 'mlkit|en|term|0.80|42ms|rules' },
  );
  assert.equal(formatInkTelemetry({ op: 'correction', from: 'plain', to: 'term', ms: 0 }).detail, '||plain>term||0ms');
  assert.equal(formatInkTelemetry({ op: 'recognize', engine: 'a|b c', chars: 12, ms: 3 }).detail, 'a_b_c||||3ms||c12');
});

test('inkTelemetry(): sub-4 ms and 0 ms events reach the recorder; plain perfMark still floors', () => {
  const got: Array<[string, number, string | undefined]> = [];

  setPerfSpanRecorder((label, ms, detail) => got.push([label, ms, detail]));
  inkTelemetry({ op: 'recolor', ms: 0.4, cls: 'term' });
  perfMark('ink-classify', 1, 'x');
  perfMark('other', 1, 'x');
  setPerfSpanRecorder(null);
  assert.equal(got.length, 2);
  assert.equal(got[0]?.[0], 'ink-recolor');
  assert.equal(got[1]?.[0], 'ink-classify');
});

test('inkTelemetry(): no recorder is a no-op', () => {
  setPerfSpanRecorder(null);
  inkTelemetry({ op: 'recognize', ms: 5 });
});

test('formatInkTelemetry(): extras keep every base field, escape «|» in text, cap the detail', () => {
  const { detail } = formatInkTelemetry({
    op: 'recognize',
    engine: 'mlkit',
    lang: 'en',
    ms: 12,
    extra: [
      ['t', 'a|b  c'],
      ['bb', '40x20'],
      ['n', 3],
      ['skip', ''],
    ],
  });

  assert.equal(detail, 'mlkit|en|||12ms|||t=a¦b c|bb=40x20|n=3');
  const long = formatInkTelemetry({ op: 'classify', extra: [['line', 'x'.repeat(500)], ['t', 'y'.repeat(500)], ['u', 'z'.repeat(500)], ['v', 'w'.repeat(500)]] });

  assert.ok(long.detail.length <= INK_DETAIL_MAX);
});
