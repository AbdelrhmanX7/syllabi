import type { InkLineForCloud } from './types';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cloudInkClassifier, InkCloudUnavailableError } from './cloudClassify';
import { inkMockRoutes } from './mock';

import { StudyApiError } from '@/lib/api/errors';
import { setStudyTransport } from '@/lib/api/http';

const line = (text: string, extra: Partial<InkLineForCloud['cues']> = {}): InkLineForCloud => ({
  text,
  lang: 'en',
  cues: { relHeight: 1, underlined: false, boxed: false, indent: 0, lineIndex: 0, ...extra },
});

function install(json: (method: string, path: string, body: unknown) => unknown): void {
  setStudyTransport({
    json: (async (method: string, path: string, body?: unknown) => json(method, path, body)) as never,
    sse: async () => undefined,
  });
}

test('classify(): batches at 20 lines and keeps order', async () => {
  const sizes: number[] = [];

  install((_m, _p, body) => {
    const lines = (body as { lines: InkLineForCloud[] }).lines;

    sizes.push(lines.length);

    return { results: lines.map((l) => ({ cls: l.text === 'x' ? 'term' : 'plain', confidence: 0.9 })) };
  });
  const lines = Array.from({ length: 45 }, (_, i) => line(i === 44 ? 'x' : 'y'));
  const out = await cloudInkClassifier.classify(lines);

  assert.deepEqual(sizes, [20, 20, 5]);
  assert.equal(out.length, 45);
  assert.equal(out[44]?.cls, 'term');
});

test('classify(): 404 / 405 / 501 become InkCloudUnavailableError, other errors pass through', async () => {
  for (const status of [404, 405, 501]) {
    install(() => {
      throw new StudyApiError(status, 'nope');
    });
    await assert.rejects(cloudInkClassifier.classify([line('a')]), InkCloudUnavailableError);
  }
  install(() => {
    throw new StudyApiError(500, 'boom');
  });
  await assert.rejects(cloudInkClassifier.classify([line('a')]), (e: unknown) => !(e instanceof InkCloudUnavailableError));
});

test('classify(): unknown classes and bad confidences are normalised; length mismatch rejects', async () => {
  install(() => ({ results: [{ cls: 'banana', confidence: 7 }] }));
  assert.deepEqual(await cloudInkClassifier.classify([line('a')]), [{ cls: 'plain', confidence: 1 }]);
  install(() => ({ results: [] }));
  await assert.rejects(cloudInkClassifier.classify([line('a')]), /malformed/);
});

test('classify(): an aborted signal stops before the next batch', async () => {
  let calls = 0;
  const controller = new AbortController();

  install((_m, _p, body) => {
    calls += 1;
    controller.abort();

    return { results: (body as { lines: unknown[] }).lines.map(() => ({ cls: 'plain', confidence: 0.5 })) };
  });
  await assert.rejects(
    cloudInkClassifier.classify(Array.from({ length: 30 }, () => line('a')), controller.signal),
    { name: 'AbortError' },
  );
  assert.equal(calls, 1);
});

test('mock route: rules answer, validates size, ignores other paths', () => {
  const res = inkMockRoutes.json('POST', '/ai/ink-classify', {
    lines: [line('Example: bees'), line('F = m × a'), line('Cell:'), line('Read the book')],
  }) as { value: { results: Array<{ cls: string }> } };

  assert.deepEqual(
    res.value.results.map((r) => r.cls),
    ['example', 'formula', 'term', 'plain'],
  );
  assert.throws(() => inkMockRoutes.json('POST', '/ai/ink-classify', { lines: [] }), StudyApiError);
  assert.equal(inkMockRoutes.json('POST', '/ai/ask', {}), undefined);
});
