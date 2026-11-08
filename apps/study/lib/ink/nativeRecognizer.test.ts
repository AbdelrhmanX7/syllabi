import type { StudyInkNativeBridge } from './nativeRecognizer';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createNativeInkRecognizer,
  flattenStrokes,
  getInkModelStatus,
  InkRecognizerError,
  NATIVE_INK_EVENT,
  nativeInkRecognizer,
  toCandidates,
} from './nativeRecognizer';

type Reply = (detail: Record<string, unknown>) => void;

/** A fake activity: records calls and lets the test answer them as `study-ink-native` events. */
function fakeBridge(handlers: {
  recognize?: (id: string, json: string, reply: Reply) => void;
  modelStatus?: (id: string, json: string, reply: Reply) => void;
  ensureModels?: (id: string, json: string, reply: Reply) => void;
  accept?: boolean;
}) {
  const target = new EventTarget();
  const calls: { method: string; id: string; json: string }[] = [];
  const replyFor =
    (id: string): Reply =>
    (detail) =>
      setTimeout(
        () => target.dispatchEvent(new CustomEvent(NATIVE_INK_EVENT, { detail: { requestId: id, ...detail } })),
        0,
      );
  const bridge: StudyInkNativeBridge = {
    isAvailable: () => true,
    ensureModels(id, json) {
      calls.push({ method: 'ensureModels', id, json });
      handlers.ensureModels?.(id, json, replyFor(id));

      return handlers.accept ?? true;
    },
    modelStatus(id, json) {
      calls.push({ method: 'modelStatus', id, json });
      handlers.modelStatus?.(id, json, replyFor(id));

      return handlers.accept ?? true;
    },
    recognize(id, json) {
      calls.push({ method: 'recognize', id, json });
      handlers.recognize?.(id, json, replyFor(id));

      return handlers.accept ?? true;
    },
  };

  return { target, calls, bridge };
}

const STROKES = [
  [
    { x: 10, y: 10, t: 1000 },
    { x: 12.345, y: 11, t: 1016.4 },
  ],
  [{ x: 20, y: 10, t: 1100 }],
];

test('unavailable without the bridge, and recognize rejects with code "unavailable"', async () => {
  const recognizer = createNativeInkRecognizer({ getBridge: () => undefined, target: new EventTarget() });

  assert.equal(recognizer.id, 'mlkit');
  assert.equal(await recognizer.available(), false);
  await assert.rejects(recognizer.recognize({ strokes: STROKES, langs: ['en'] }), (error: unknown) => {
    return error instanceof InkRecognizerError && error.code === 'unavailable';
  });
});

test('available() is false when the bridge throws', async () => {
  const recognizer = createNativeInkRecognizer({
    getBridge: () =>
      ({
        isAvailable: () => {
          throw new Error('boom');
        },
      }) as unknown as StudyInkNativeBridge,
  });

  assert.equal(await recognizer.available(), false);
});

test('flattens strokes to [x,y,t] with times relative to the first point', () => {
  assert.deepEqual(flattenStrokes(STROKES), [
    [10, 10, 0, 12.35, 11, 16],
    [20, 10, 100],
  ]);
  assert.deepEqual(flattenStrokes([[], []]), []);
});

test('toCandidates keeps each model list in order, tags lang, drops blanks, follows the request order', () => {
  const out = toCandidates(
    [
      { lang: 'x-other', candidates: [{ text: 'later' }] },
      { lang: 'en', candidates: [{ text: 'hello' }, { text: ' ' }, { text: 'hallo', score: 0.4 }] },
    ],
    ['en'],
  );

  assert.deepEqual(out, [
    { text: 'hello', lang: 'en' },
    { text: 'hallo', score: 0.4, lang: 'en' },
    { text: 'later', lang: 'x-other' },
  ]);
});

test('recognize sends one English request with preContext and writingArea, and returns the reply', async () => {
  const { target, calls, bridge } = fakeBridge({
    recognize: (_id, _json, reply) =>
      reply({
        type: 'result',
        results: [{ lang: 'en', candidates: [{ text: 'force' }, { text: 'farce' }] }],
        errors: {},
      }),
  });
  const recognizer = createNativeInkRecognizer({ getBridge: () => bridge, target });
  const candidates = await recognizer.recognize({
    strokes: STROKES,
    // Any other language is narrowed away: Syllabi recognises English only.
    langs: ['ar', 'en'],
    preContext: 'x'.repeat(30) + 'Newton',
    writingArea: { width: 300, height: 60 },
  });

  assert.equal(calls.length, 1);
  const sent = JSON.parse(calls[0].json);

  assert.deepEqual(sent.langs, ['en']);
  assert.equal(sent.preContext.length, 20);
  assert.ok(sent.preContext.endsWith('Newton'));
  assert.deepEqual(sent.writingArea, { width: 300, height: 60 });
  assert.equal(sent.strokes.length, 2);
  assert.deepEqual(
    candidates.map((c) => [c.text, c.lang]),
    [
      ['force', 'en'],
      ['farce', 'en'],
    ],
  );
});

test('ignores events for other request ids', async () => {
  const { target, bridge } = fakeBridge({
    recognize: (_id, _json, reply) => {
      setTimeout(
        () =>
          target.dispatchEvent(new CustomEvent(NATIVE_INK_EVENT, { detail: { requestId: 'other', type: 'error' } })),
        0,
      );
      reply({ type: 'result', results: [{ lang: 'en', candidates: [{ text: 'ok' }] }] });
    },
  });
  const recognizer = createNativeInkRecognizer({ getBridge: () => bridge, target });

  assert.deepEqual(
    (await recognizer.recognize({ strokes: STROKES, langs: ['en'] })).map((c) => c.text),
    ['ok'],
  );
});

test('a native error rejects with its code', async () => {
  const { target, bridge } = fakeBridge({
    recognize: (_id, _json, reply) => reply({ type: 'error', code: 'model-missing', message: 'download first' }),
  });
  const recognizer = createNativeInkRecognizer({ getBridge: () => bridge, target });

  await assert.rejects(recognizer.recognize({ strokes: STROKES, langs: ['en'] }), (error: unknown) => {
    return error instanceof InkRecognizerError && error.code === 'model-missing';
  });
});

test('times out when the native side never answers, and removes its listener', async () => {
  const { target, bridge } = fakeBridge({});
  let listeners = 0;
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);

  target.addEventListener = (...args: Parameters<EventTarget['addEventListener']>) => {
    listeners += 1;
    add(...args);
  };
  target.removeEventListener = (...args: Parameters<EventTarget['removeEventListener']>) => {
    listeners -= 1;
    remove(...args);
  };
  const recognizer = createNativeInkRecognizer({ getBridge: () => bridge, target, recognizeTimeoutMs: 20 });

  await assert.rejects(recognizer.recognize({ strokes: STROKES, langs: ['en'] }), (error: unknown) => {
    return error instanceof InkRecognizerError && error.code === 'timeout';
  });
  assert.equal(listeners, 0);
});

test('abort rejects with AbortError; a pre-aborted signal never reaches the bridge', async () => {
  const { target, calls, bridge } = fakeBridge({});
  const recognizer = createNativeInkRecognizer({ getBridge: () => bridge, target, recognizeTimeoutMs: 5_000 });
  const controller = new AbortController();
  const pending = recognizer.recognize({ strokes: STROKES, langs: ['en'] }, controller.signal);

  controller.abort();

  await assert.rejects(pending, (error: unknown) => (error as Error).name === 'AbortError');
  await assert.rejects(
    recognizer.recognize({ strokes: STROKES, langs: ['en'] }, controller.signal),
    (error: unknown) => (error as Error).name === 'AbortError',
  );
  assert.equal(calls.length, 1);
});

test('a bridge that refuses the call rejects at once', async () => {
  const { target, bridge } = fakeBridge({ accept: false });
  const recognizer = createNativeInkRecognizer({ getBridge: () => bridge, target });

  await assert.rejects(recognizer.recognize({ strokes: STROKES, langs: ['en'] }), (error: unknown) => {
    return error instanceof InkRecognizerError && error.code === 'rejected';
  });
});

test('empty ink resolves to no candidates without calling native', async () => {
  const { target, calls, bridge } = fakeBridge({});
  const recognizer = createNativeInkRecognizer({ getBridge: () => bridge, target });

  assert.deepEqual(await recognizer.recognize({ strokes: [[]], langs: ['en'] }), []);
  assert.equal(calls.length, 0);
});

test('prepare downloads the English model, reports progress, and is shared until it fails', async () => {
  let attempt = 0;
  const { target, calls, bridge } = fakeBridge({
    ensureModels: (_id, json, reply) => {
      assert.deepEqual(JSON.parse(json), ['en']);
      attempt += 1;
      if (attempt === 1) {
        reply({ type: 'error', code: 'download-failed', message: 'offline' });

        return;
      }
      reply({ type: 'progress', fraction: 0.5 });
      reply({ type: 'progress', lang: 'en', done: 1, total: 1, fraction: 1 });
      reply({ type: 'result', models: { en: true } });
    },
  });
  const recognizer = createNativeInkRecognizer({ getBridge: () => bridge, target });

  await assert.rejects(
    recognizer.prepare!(),
    (error: unknown) => (error as InkRecognizerError).code === 'download-failed',
  );
  const progress: number[] = [];
  const first = recognizer.prepare!((f) => progress.push(f));
  const second = recognizer.prepare!();

  await Promise.all([first, second]);
  assert.deepEqual(progress, [0.5, 1, 1]);
  assert.equal(calls.filter((c) => c.method === 'ensureModels').length, 2);
});

test('modelStatus maps the device answer, and shows a pending download as downloading', async () => {
  let release: Reply | undefined;
  const { target, bridge } = fakeBridge({
    modelStatus: (_id, json, reply) => {
      assert.deepEqual(JSON.parse(json), ['en']);
      reply({ type: 'result', models: { en: false } });
    },
    ensureModels: (_id, _json, reply) => {
      reply({ type: 'progress', fraction: 0.5 });
      release = reply;
    },
  });
  const recognizer = createNativeInkRecognizer({ getBridge: () => bridge, target });

  assert.deepEqual(await recognizer.modelStatus(), { en: 'missing' });
  const download = recognizer.prepare();

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(await recognizer.modelStatus(), { en: 'downloading' });
  release!({ type: 'result', models: { en: true } });
  await download;
});

test('the app-wide instance is null and status is missing without the bridge', async () => {
  assert.equal(nativeInkRecognizer, null);
  assert.deepEqual(await getInkModelStatus(), { en: 'missing' });
});
