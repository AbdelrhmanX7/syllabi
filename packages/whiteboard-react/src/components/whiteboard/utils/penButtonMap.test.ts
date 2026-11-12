import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addPenButtonBinding,
  boardAiCommandForPenAction,
  PEN_BUTTON_ACTIONS,
  PEN_BUTTON_HOVER_ACTIONS,
  PEN_BUTTON_LONG_HOVER_ACTIONS,
  createPenButtonDispatcher,
  detectPenSignalEdges,
  EMPTY_PEN_BUTTON_MAP,
  findBindingForSignature,
  mergePenButtonCapture,
  normalizePenButtonMap,
  PEN_BUTTON_MAP_STORAGE_KEY,
  readPenButtonMap,
  removePenButtonBinding,
  updatePenButtonBinding,
  withDefaultStylusBinding,
  writePenButtonMap,
  type PenButtonMap,
} from './penButtonMap';

function memoryStorage() {
  const data = new Map<string, string>();

  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

test('pointer: the tip-contact bit is never a button; barrel bits rise and fall', () => {
  assert.deepEqual(detectPenSignalEdges({ source: 'pointer', pointerType: 'pen', buttons: 1, prevButtons: 0 }), []);
  assert.deepEqual(detectPenSignalEdges({ source: 'pointer', pointerType: 'pen', buttons: 3, prevButtons: 1 }), [
    { signature: 'pointer:pen:bit:2', phase: 'press', hasRelease: true },
  ]);
  assert.deepEqual(detectPenSignalEdges({ source: 'pointer', pointerType: 'pen', buttons: 0, prevButtons: 34 }), [
    { signature: 'pointer:pen:bit:2', phase: 'release', hasRelease: true },
    { signature: 'pointer:pen:bit:32', phase: 'release', hasRelease: true },
  ]);
  assert.deepEqual(detectPenSignalEdges({ source: 'pointer', pointerType: 'pen', buttons: 2, prevButtons: 2 }), []);
});

test('native: stylus button bits and the eraser end become edges; primary is ignored', () => {
  assert.deepEqual(
    detectPenSignalEdges({
      source: 'native',
      kind: 'motion',
      buttonState: 32 | 1,
      prevButtonState: 0,
      toolType: 2,
      prevToolType: 2,
    }),
    [{ signature: 'native:button:32', phase: 'press', hasRelease: true }],
  );
  assert.deepEqual(
    detectPenSignalEdges({
      source: 'native',
      kind: 'motion',
      buttonState: 0,
      prevButtonState: 0,
      toolType: 4,
      prevToolType: 2,
    }),
    [{ signature: 'native:tool:eraser', phase: 'press', hasRelease: true }],
  );
  assert.deepEqual(detectPenSignalEdges({ source: 'native', kind: 'key', type: 'down', keyCode: 308, repeat: 1 }), []);
  assert.deepEqual(detectPenSignalEdges({ source: 'native', kind: 'key', type: 'up', keyCode: 308, repeat: 0 }), [
    { signature: 'native:key:308', phase: 'release', hasRelease: true },
  ]);
});

test('key / contextmenu / mouse signatures', () => {
  assert.deepEqual(
    detectPenSignalEdges({ source: 'key', type: 'keydown', key: 'F13', code: 'F13', keyCode: 124, repeat: false }),
    [{ signature: 'key:F13', phase: 'press', hasRelease: true }],
  );
  assert.deepEqual(
    detectPenSignalEdges({ source: 'key', type: 'keydown', key: 'a', code: 'KeyA', keyCode: 65, repeat: true }),
    [],
  );
  // A long-press, never a button (Samsung device log).
  assert.deepEqual(detectPenSignalEdges({ source: 'contextmenu', pointerType: 'pen' }), []);
  assert.deepEqual(detectPenSignalEdges({ source: 'mouse', type: 'mousedown', button: 0 }), []);
  assert.deepEqual(detectPenSignalEdges({ source: 'mouse', type: 'mouseup', button: 2 }), [
    { signature: 'mouse:button:2', phase: 'release', hasRelease: true },
  ]);
});

test('capture groups one press burst and splits a later press', () => {
  const map = addPenButtonBinding(EMPTY_PEN_BUTTON_MAP, {
    id: 'a',
    label: 'A',
    action: 'undo',
    signatures: ['key:F13'],
    createdAt: 1,
  });
  let capture = mergePenButtonCapture(
    null,
    map,
    [{ signature: 'pointer:pen:bit:2', phase: 'press', hasRelease: true }],
    1000,
  );

  capture = mergePenButtonCapture(
    capture,
    map,
    [
      { signature: 'native:button:32', phase: 'press', hasRelease: true },
      { signature: 'key:F13', phase: 'press', hasRelease: true },
    ],
    1100,
  );
  assert.deepEqual(capture?.signatures, ['pointer:pen:bit:2', 'native:button:32']);
  assert.deepEqual(capture?.knownBindingIds, ['a']);

  // Releases change nothing.
  assert.equal(
    mergePenButtonCapture(capture, map, [{ signature: 'x', phase: 'release', hasRelease: true }], 1200),
    capture,
  );

  const later = mergePenButtonCapture(capture, map, [{ signature: 'key:F14', phase: 'press', hasRelease: true }], 2000);

  assert.deepEqual(later?.signatures, ['key:F14']);
  assert.equal(later?.firstAt, 2000);
});

test('bindings: re-learning steals signatures; normalise drops junk; storage round-trips', () => {
  let map: PenButtonMap = addPenButtonBinding(EMPTY_PEN_BUTTON_MAP, {
    id: 'one',
    label: 'Button 1',
    action: 'erase-hold',
    signatures: ['pointer:pen:bit:2', 'native:button:32'],
    createdAt: 1,
  });

  map = addPenButtonBinding(map, {
    id: 'two',
    label: 'Button 2',
    action: 'color-toggle',
    signatures: ['native:button:32'],
    createdAt: 2,
  });
  assert.deepEqual(findBindingForSignature(map, 'pointer:pen:bit:2')?.id, 'one');
  assert.deepEqual(findBindingForSignature(map, 'native:button:32')?.id, 'two');

  map = updatePenButtonBinding(map, 'two', { action: 'undo', label: '  Undo  ' });
  assert.equal(map.bindings[1].action, 'undo');
  assert.equal(map.bindings[1].label, 'Undo');

  const storage = memoryStorage();

  writePenButtonMap(storage, map);
  assert.deepEqual(readPenButtonMap(storage), map);

  writePenButtonMap(storage, removePenButtonBinding(removePenButtonBinding(map, 'one'), 'two'));
  assert.equal(storage.data.has(PEN_BUTTON_MAP_STORAGE_KEY), false);

  storage.setItem(PEN_BUTTON_MAP_STORAGE_KEY, '{nope');
  assert.deepEqual(readPenButtonMap(storage), EMPTY_PEN_BUTTON_MAP);

  assert.deepEqual(
    normalizePenButtonMap({
      bindings: [
        { id: 'x', label: 'x', action: 'fly', signatures: ['a'] },
        { id: 'y', label: '', action: 'none', signatures: [] },
        { id: 'z', action: 'none', signatures: ['b', 'b'] },
      ],
    }).bindings.map((binding) => [binding.id, binding.label, binding.signatures]),
    [['z', 'Pen button', ['b']]],
  );
});

test('dispatcher: hold press/release, twin signals absorbed, one-shot deduped', () => {
  const map = addPenButtonBinding(EMPTY_PEN_BUTTON_MAP, {
    id: 'erase',
    label: 'Eraser',
    action: 'erase-hold',
    signatures: ['pointer:pen:bit:2', 'native:button:32', 'oneshot:test'],
    createdAt: 1,
  });
  const dispatcher = createPenButtonDispatcher();
  const kinds = (events: ReturnType<typeof dispatcher.handle>) => events.map((event) => event.kind);

  assert.deepEqual(
    kinds(dispatcher.handle(map, [{ signature: 'native:button:32', phase: 'press', hasRelease: true }], 0)),
    ['press'],
  );
  // DOM twin + one-shot signal of the same press: absorbed.
  assert.deepEqual(
    kinds(dispatcher.handle(map, [{ signature: 'pointer:pen:bit:2', phase: 'press', hasRelease: true }], 5)),
    [],
  );
  assert.deepEqual(
    kinds(dispatcher.handle(map, [{ signature: 'oneshot:test', phase: 'press', hasRelease: false }], 6)),
    [],
  );
  // Release only once every held twin is up.
  assert.deepEqual(
    kinds(dispatcher.handle(map, [{ signature: 'native:button:32', phase: 'release', hasRelease: true }], 50)),
    [],
  );
  assert.deepEqual(
    kinds(dispatcher.handle(map, [{ signature: 'pointer:pen:bit:2', phase: 'release', hasRelease: true }], 60)),
    ['release'],
  );
  // A one-shot signal that trails the release is the same press.
  assert.deepEqual(
    kinds(dispatcher.handle(map, [{ signature: 'oneshot:test', phase: 'press', hasRelease: false }], 100)),
    [],
  );
  // Much later, the one-shot alone is a one-shot press.
  const later = dispatcher.handle(map, [{ signature: 'oneshot:test', phase: 'press', hasRelease: false }], 1000);

  assert.deepEqual(kinds(later), ['press']);
  assert.equal(later[0].momentary, false);
  assert.equal(dispatcher.hasHeld(), false);

  // Unbound signatures do nothing.
  assert.deepEqual(dispatcher.handle(map, [{ signature: 'key:F1', phase: 'press', hasRelease: true }], 2000), []);
});

test('dispatcher: a twin that trails a quick click (first signature already released) is the same press, not a second click', () => {
  const map = addPenButtonBinding(EMPTY_PEN_BUTTON_MAP, {
    id: 'menu',
    label: 'Pen button',
    action: 'erase-hold',
    hoverAction: 'pen-shortcuts',
    signatures: ['native:button:32', 'key:F13'],
    createdAt: 1,
  });
  const dispatcher = createPenButtonDispatcher();
  const edge = (signature: string, phase: 'press' | 'release') => ({ signature, phase, hasRelease: true });
  const kinds = (events: ReturnType<typeof dispatcher.handle>) => events.map((event) => event.kind);

  // The physical click: native press + release, 80 ms apart.
  assert.deepEqual(kinds(dispatcher.handle(map, [edge('native:button:32', 'press')], 0)), ['press']);
  assert.deepEqual(kinds(dispatcher.handle(map, [edge('native:button:32', 'release')], 80)), ['release']);
  // The system raises the key for that same click AFTER the release: absorbed, both edges.
  assert.deepEqual(kinds(dispatcher.handle(map, [edge('key:F13', 'press')], 300)), []);
  assert.deepEqual(kinds(dispatcher.handle(map, [edge('key:F13', 'release')], 380)), []);
  assert.equal(dispatcher.hasHeld(), false);

  // The SAME signature pressed again inside the window is a real second click.
  assert.deepEqual(kinds(dispatcher.handle(map, [edge('native:button:32', 'press')], 390)), ['press']);
  assert.deepEqual(kinds(dispatcher.handle(map, [edge('native:button:32', 'release')], 450)), ['release']);
  // …and its own late key twin is absorbed again.
  assert.deepEqual(kinds(dispatcher.handle(map, [edge('key:F13', 'press')], 700)), []);
  assert.deepEqual(kinds(dispatcher.handle(map, [edge('key:F13', 'release')], 760)), []);

  // Past the window the other signature is a click of its own.
  assert.deepEqual(kinds(dispatcher.handle(map, [edge('key:F13', 'press')], 2000)), ['press']);
  assert.deepEqual(kinds(dispatcher.handle(map, [edge('key:F13', 'release')], 2060)), ['release']);

  // A twin absorbed WHILE held counts toward that press too — so a signature that already took part in
  // the press and shows up AGAIN is a new click (the dispatcher never swallows a repeat of a known path).
  assert.deepEqual(kinds(dispatcher.handle(map, [edge('native:button:32', 'press')], 3000)), ['press']);
  assert.deepEqual(kinds(dispatcher.handle(map, [edge('key:F13', 'press')], 3010)), []);
  assert.deepEqual(kinds(dispatcher.handle(map, [edge('key:F13', 'release')], 3050)), []);
  assert.deepEqual(kinds(dispatcher.handle(map, [edge('native:button:32', 'release')], 3090)), ['release']);
  assert.deepEqual(kinds(dispatcher.handle(map, [edge('key:F13', 'press')], 3200)), ['press']);
  assert.deepEqual(kinds(dispatcher.handle(map, [edge('key:F13', 'release')], 3260)), ['release']);
});

test('dispatcher: a lost release is recovered by a re-press or by reconcilePointer', () => {
  const map = addPenButtonBinding(EMPTY_PEN_BUTTON_MAP, {
    id: 'c',
    label: 'Colour',
    action: 'color-toggle',
    signatures: ['pointer:pen:bit:2'],
    createdAt: 1,
  });
  const dispatcher = createPenButtonDispatcher();
  const press = { signature: 'pointer:pen:bit:2', phase: 'press' as const, hasRelease: true };

  dispatcher.handle(map, [press], 0);
  assert.deepEqual(
    dispatcher.handle(map, [press], 1000).map((event) => event.kind),
    ['release', 'press'],
  );
  assert.deepEqual(dispatcher.reconcilePointer(map, 'pen', 2, 1100), []);
  assert.deepEqual(
    dispatcher.reconcilePointer(map, 'pen', 0, 1200).map((event) => event.kind),
    ['release'],
  );
  assert.equal(dispatcher.hasHeld(), false);
});

test('migration: a saved contextmenu signature (a long-press, not the button) is dropped on read', () => {
  const map = normalizePenButtonMap({
    bindings: [
      { id: 'a', label: 'Button', action: 'erase-hold', signatures: ['native:button:32', 'contextmenu:pen'] },
      { id: 'b', label: 'Old', action: 'undo', signatures: ['contextmenu:pen'] },
    ],
  });

  assert.deepEqual(
    map.bindings.map((binding) => [binding.id, binding.signatures]),
    [['a', ['native:button:32']]],
  );
});

test('the Samsung S Pen log: native BUTTON_STYLUS_PRIMARY edges while touching and hovering', () => {
  // ACTION_BUTTON_PRESS / RELEASE on the glass, HOVER_MOVE with buttonState 32 in the air.
  const press = { source: 'native' as const, kind: 'motion' as const, toolType: 2, prevToolType: 2 };

  assert.deepEqual(detectPenSignalEdges({ ...press, buttonState: 32, prevButtonState: 0 }), [
    { signature: 'native:button:32', phase: 'press', hasRelease: true },
  ]);
  assert.deepEqual(detectPenSignalEdges({ ...press, buttonState: 0, prevButtonState: 32 }), [
    { signature: 'native:button:32', phase: 'release', hasRelease: true },
  ]);
  // The fake hover "contact" the WebView emits alongside (pen buttons 1, pressure 0) is no button edge.
  assert.deepEqual(detectPenSignalEdges({ source: 'pointer', pointerType: 'pen', buttons: 1, prevButtons: 0 }), []);
});

test('the S Pen works without learning: a built-in binding for native BUTTON_STYLUS_PRIMARY, unless one is learned', () => {
  const built = withDefaultStylusBinding(EMPTY_PEN_BUTTON_MAP);
  const binding = findBindingForSignature(built, 'native:button:32');

  assert.ok(binding);
  assert.equal(binding.hoverAction, 'pen-shortcuts');
  assert.equal(binding.longHoverAction, 'buddy-talk', 'a long hold in the air talks to the buddy by default');
  assert.equal(binding.action, 'erase-hold');

  const learned = addPenButtonBinding(EMPTY_PEN_BUTTON_MAP, {
    id: 'mine',
    label: 'My button',
    action: 'undo',
    signatures: ['native:button:32'],
    createdAt: 1,
  });

  assert.equal(withDefaultStylusBinding(learned), learned, 'a learned S Pen binding must win');
});

test('a binding saved before the hover actions existed reads back with the defaults', () => {
  const [binding] = normalizePenButtonMap({
    bindings: [{ id: 'old', label: 'Old', action: 'erase-hold', signatures: ['native:button:32'] }],
  }).bindings;

  assert.equal(binding.hoverAction, 'pen-shortcuts');
  assert.equal(binding.longHoverAction, 'buddy-talk');
  assert.equal(
    updatePenButtonBinding({ version: 3, bindings: [binding] }, 'old', { longHoverAction: 'eraser-toggle' }).bindings[0]
      .longHoverAction,
    'eraser-toggle',
  );
});

test('native edges carry the contact state to the dispatcher', () => {
  const edges = detectPenSignalEdges({
    source: 'native',
    kind: 'motion',
    buttonState: 32,
    prevButtonState: 0,
    toolType: 2,
    prevToolType: 2,
    contact: true,
  });

  assert.deepEqual(edges, [{ signature: 'native:button:32', phase: 'press', hasRelease: true, contact: true }]);

  const events = createPenButtonDispatcher().handle(withDefaultStylusBinding(EMPTY_PEN_BUTTON_MAP), edges, 0);

  assert.equal(events[0].contact, true);
});

test('migration: a version-1 map still holding the old default long press (colour swap) becomes «Nothing»', () => {
  const legacy = normalizePenButtonMap({
    version: 1,
    bindings: [
      {
        id: 'a',
        label: 'A',
        action: 'erase-hold',
        hoverAction: 'pen-shortcuts',
        longHoverAction: 'color-toggle',
        signatures: ['native:button:32'],
      },
      { id: 'b', label: 'B', action: 'erase-hold', longHoverAction: 'undo', signatures: ['key:F13'] },
    ],
  });

  assert.equal(legacy.version, 3);
  assert.deepEqual(
    legacy.bindings.map((binding) => binding.longHoverAction),
    ['buddy-talk', 'undo'],
  );

  // A colour swap chosen on a current map is the teacher's choice and stays.
  const chosen = updatePenButtonBinding(legacy, 'a', { longHoverAction: 'color-toggle' });

  assert.equal(chosen.bindings[0].longHoverAction, 'color-toggle');

  const storage = memoryStorage();

  writePenButtonMap(storage, chosen);
  assert.equal(readPenButtonMap(storage).bindings[0].longHoverAction, 'color-toggle');
});

test('«Ask AI (select)» is offered on both in-air slots only, maps to ai-lasso-once, and is never a default', () => {
  assert.ok(PEN_BUTTON_HOVER_ACTIONS.some((entry) => entry.action === 'ai-lasso'));
  assert.ok(PEN_BUTTON_LONG_HOVER_ACTIONS.some((entry) => entry.action === 'ai-lasso'));
  assert.equal(
    PEN_BUTTON_ACTIONS.some((entry) => entry.action === 'ai-lasso'),
    false,
    'not while touching',
  );

  assert.equal(boardAiCommandForPenAction('ai-lasso'), 'ai-lasso-once');
  assert.equal(boardAiCommandForPenAction('pen-shortcuts'), null);
  assert.equal(boardAiCommandForPenAction('none'), null);

  const builtIn = findBindingForSignature(withDefaultStylusBinding(EMPTY_PEN_BUTTON_MAP), 'native:button:32');

  assert.notEqual(builtIn?.hoverAction, 'ai-lasso');
  assert.notEqual(builtIn?.longHoverAction, 'ai-lasso');

  const [binding] = normalizePenButtonMap({
    version: 2,
    bindings: [
      {
        id: 'ai',
        label: 'AI',
        action: 'ai-lasso',
        hoverAction: 'ai-lasso',
        longHoverAction: 'ai-lasso',
        signatures: ['native:button:64'],
      },
    ],
  }).bindings;

  // The touching slot cannot hold it (the whole binding would be invalid), so pair it with a valid one.
  assert.equal(binding, undefined, 'ai-lasso is not a valid while-touching action');

  const [kept] = normalizePenButtonMap({
    version: 2,
    bindings: [
      {
        id: 'ai',
        label: 'AI',
        action: 'erase-hold',
        hoverAction: 'ai-lasso',
        longHoverAction: 'ai-lasso',
        signatures: ['native:button:64'],
      },
    ],
  }).bindings;

  assert.equal(kept.hoverAction, 'ai-lasso');
  assert.equal(kept.longHoverAction, 'ai-lasso');
});

test('the buddy hold: v2 maps move their default «Nothing» over, v3 keeps an explicit «Nothing», the touching slot refuses it', () => {
  const entry = { id: 'b', label: 'B', action: 'erase-hold', hoverAction: 'pen-shortcuts', longHoverAction: 'none', signatures: ['native:button:32'] };

  assert.equal(normalizePenButtonMap({ version: 2, bindings: [entry] }).bindings[0]?.longHoverAction, 'buddy-talk');
  assert.equal(normalizePenButtonMap({ version: 3, bindings: [entry] }).bindings[0]?.longHoverAction, 'none');
  assert.equal(normalizePenButtonMap({ version: 3, bindings: [{ ...entry, longHoverAction: 'eraser-toggle' }] }).bindings[0]?.longHoverAction, 'eraser-toggle');
  assert.equal(normalizePenButtonMap({ version: 3, bindings: [{ ...entry, hoverAction: 'buddy-talk' }] }).bindings[0]?.hoverAction, 'pen-shortcuts');
  assert.equal(normalizePenButtonMap({ version: 3, bindings: [{ ...entry, action: 'buddy-talk' }] }).bindings.length, 0);
});
