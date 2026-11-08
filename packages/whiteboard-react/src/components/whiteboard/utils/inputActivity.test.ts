import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { JSDOM } from 'jsdom';

/**
 * Background work must yield to the pen in BOTH directions: it may not start while the teacher is
 * writing (`waitForInputIdle`), and it must be droppable the instant they start again
 * (`createInputActivityAbortSignal`). Only the first half existed; a warm render issued during a
 * pause ran to completion straight through the next stroke.
 */
before(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const globals = globalThis as unknown as { document?: unknown; window?: unknown };

  globals.window = dom.window;
  globals.document = dom.window.document;
});

/** Fire a real capture-phase input event, the way a pen/touch sample arrives. */
function dispatchInput(type = 'pointerdown'): void {
  window.dispatchEvent(new window.Event(type));
}

test('the abort signal fires on the next pointer event', async () => {
  const { createInputActivityAbortSignal } = await import('./inputActivity');
  const input = createInputActivityAbortSignal();

  assert.equal(input.signal.aborted, false, 'nothing is aborted before input');

  dispatchInput();

  assert.equal(input.signal.aborted, true, 'a stroke starting mid-warm must abort the in-flight fetch');

  input.dispose();
});

test('touch and wheel count as input too — the board is not mouse-only', async () => {
  const { createInputActivityAbortSignal } = await import('./inputActivity');

  for (const type of ['pointermove', 'touchstart', 'wheel']) {
    const input = createInputActivityAbortSignal();

    dispatchInput(type);
    assert.equal(input.signal.aborted, true, `${type} must abort background work`);
    input.dispose();
  }
});

test('dispose removes the listener, so a finished job cannot leak one per warmed page', async () => {
  const { createInputActivityAbortSignal, onInputActivity } = await import('./inputActivity');
  const input = createInputActivityAbortSignal();

  input.dispose();

  let fired = 0;
  const unsubscribe = onInputActivity(() => {
    fired += 1;
  });

  dispatchInput();

  assert.equal(input.signal.aborted, false, 'a disposed signal must no longer react to input');
  assert.equal(fired, 1, 'a live listener still fires');

  unsubscribe();
  dispatchInput();
  assert.equal(fired, 1, 'an unsubscribed listener must not fire');
});

test('a listener that unsubscribes itself mid-dispatch does not break the others', async () => {
  const { onInputActivity } = await import('./inputActivity');
  const seen: string[] = [];
  let unsubscribeSelf: (() => void) | undefined;

  unsubscribeSelf = onInputActivity(() => {
    seen.push('self-removing');
    unsubscribeSelf?.();
  });

  const unsubscribeOther = onInputActivity(() => {
    seen.push('other');
  });

  dispatchInput();

  assert.deepEqual(seen, ['self-removing', 'other'], 'both listeners run although the first removed itself');

  unsubscribeOther();
});

test('waitForInputIdle still gates the START of background work', async () => {
  const { waitForInputIdle, millisecondsSinceLastInput } = await import('./inputActivity');

  dispatchInput();
  assert.ok(millisecondsSinceLastInput() < 50, 'input was just now');

  // Cancelled waits resolve immediately — that is how an effect cleanup unblocks a parked chain.
  await waitForInputIdle(60_000, () => true);
});

test('a pointer that is still down counts as "interacting" even when it has stopped moving', async () => {
  const { isPointerDown, waitForInputIdle } = await import('./inputActivity');

  // Earlier tests press without ever lifting (they only care that the press aborts); a blur is how
  // the tracker forgets contacts whose pointerup never came, so start from a clean glass.
  dispatchInput('blur');
  assert.equal(isPointerDown(), false, 'nothing is down before a contact');

  dispatchInput('pointerdown');
  assert.equal(isPointerDown(), true, 'a contact that has not lifted is still down');

  // A pen resting on the glass: no samples for longer than the idle window, but it never lifted.
  let resolved = false;

  void waitForInputIdle(20, () => false, 5).then(() => {
    resolved = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(resolved, false, 'background work must not start under a pen that is still down');

  dispatchInput('pointerup');
  assert.equal(isPointerDown(), false, 'lifting the contact ends the interaction');

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(resolved, true, 'once lifted and idle, the wait resolves');
});

test('pointercancel and window blur release a contact whose pointerup was never delivered', async () => {
  const { isPointerDown } = await import('./inputActivity');

  dispatchInput('pointerdown');
  assert.equal(isPointerDown(), true);
  dispatchInput('pointercancel');
  assert.equal(isPointerDown(), false, 'a cancelled contact is not down');

  dispatchInput('pointerdown');
  assert.equal(isPointerDown(), true);
  dispatchInput('blur');
  assert.equal(isPointerDown(), false, 'losing the window drops every contact — the up event is not coming');
});

test('a contact whose up never arrives stops blocking idle once it has been silent past the ceiling', async () => {
  const { CONTACT_SILENCE_CEILING_MS, isPointerDown, waitForInputIdle } = await import('./inputActivity');

  dispatchInput('blur');
  dispatchInput('pointerdown');
  assert.equal(isPointerDown(), true, 'a fresh contact is down');

  // WebView2 can drop a pointer stream with neither pointerup nor pointercancel nor blur. Without a
  // ceiling that contact would pin `isPointerDown()` forever: no warm ever again, and autosave's
  // idle wait would inherit the same wedge.
  const realNow = Date.now;

  try {
    const frozen = realNow();

    Date.now = () => frozen + CONTACT_SILENCE_CEILING_MS + 1;

    assert.equal(isPointerDown(), false, 'a contact silent past the ceiling is treated as lifted');

    let resolved = false;

    void waitForInputIdle(20, () => false, 5).then(() => {
      resolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(resolved, true, 'idle work resumes');
  } finally {
    Date.now = realNow;
  }

  assert.equal(isPointerDown(), false, 'the wedged contact was cleared, not merely ignored');
});

test('a contact reported from outside the DOM (the Android S Pen bridge) holds idle work like a pointer', async () => {
  const { isPointerDown, millisecondsSinceLastInput, noteExternalContact } = await import('./inputActivity');

  dispatchInput('blur');
  assert.equal(isPointerDown(), false);

  // Samsung's WebView delivers NO pointer events for a stylus put down with its button held; the page
  // only hears the shell's `wb-native-pen` contact. Before this, the whole erase stroke read as idle.
  noteExternalContact('down');
  assert.equal(isPointerDown(), true, 'the native contact is down');
  assert.ok(millisecondsSinceLastInput() < 50, 'and counts as input');

  noteExternalContact('move');
  assert.equal(isPointerDown(), true);

  noteExternalContact('up');
  assert.equal(isPointerDown(), false, 'its up releases it');

  noteExternalContact('move');
  assert.equal(isPointerDown(), true, 'a move without a seen down still re-asserts the contact');
  dispatchInput('blur');
  assert.equal(isPointerDown(), false, 'blur drops it like any other contact');
});
