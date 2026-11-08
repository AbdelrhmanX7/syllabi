import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectCoalescedSamples } from './coalesced-samples';

const ev = (n: number) =>
  ({
    getCoalescedEvents: () => Array.from({ length: n }, (_, i) => ({ index: i })),
  }) as never;

test('returns null for an undefined event', () => {
  assert.equal(selectCoalescedSamples(undefined), null);
});

test('returns null for a null event', () => {
  assert.equal(selectCoalescedSamples(null as never), null);
});

test('returns null when getCoalescedEvents is missing', () => {
  assert.equal(selectCoalescedSamples({} as never), null);
});

test('returns null when getCoalescedEvents throws', () => {
  assert.equal(
    selectCoalescedSamples({
      getCoalescedEvents: () => {
        throw new Error('x');
      },
    } as never),
    null,
  );
});

test('returns null for zero samples', () => {
  assert.equal(selectCoalescedSamples(ev(0)), null);
});

test('returns null for a single sample', () => {
  assert.equal(selectCoalescedSamples(ev(1)), null);
});

test('returns the array for three samples', () => {
  const result = selectCoalescedSamples(ev(3));

  assert.ok(Array.isArray(result));
  assert.equal(result!.length, 3);
});

// A full-render brush is no longer excluded — it batches the samples and repaints once. The old gate is
// why the calligraphy and marker nibs never saw a single sub-frame sample.
test('does not gate on the brush render mode', () => {
  assert.equal(selectCoalescedSamples(ev(4))!.length, 4);
});

// --- splitPenFrame: samples of a pen that is leaving the glass are never appended ---------------------

import { classifyPenSample, splitPenFrame } from './coalesced-samples';

const pen = (pressure: number, buttons = 1) => ({ pointerType: 'pen', pressure, buttons });

test('all samples in contact → every index appendable, and the contact remembers it has seen pressure', () => {
  const state = { pressureSeen: false };

  assert.deepEqual(splitPenFrame([pen(0.4), pen(0.5), pen(0.3)], state), { contactIndices: [0, 1, 2], verdict: 'contact' });
  assert.equal(state.pressureSeen, true);
});

test('a sample whose contact bit is clear is the LIFT: nothing after it is appendable, whatever its pressure', () => {
  assert.deepEqual(splitPenFrame([pen(0.4), pen(0.4, 0), pen(0.4)], { pressureSeen: false }), {
    contactIndices: [0],
    verdict: 'lift',
  });
  // A barrel button still held while the tip is up (buttons 2) is no contact either.
  assert.deepEqual(splitPenFrame([pen(0.4, 3), pen(0.2, 2)], { pressureSeen: false }), { contactIndices: [0], verdict: 'lift' });
});

// The lift tail: Android keeps reporting the pen for a frame or two after it leaves — pressure 0, tip
// switch not yet open. Those positions are SKIPPED, but they never close the stroke: losing the rest of
// a letter to a flaky pressure reading is worse than a 3px tail.
test('a pen sample at pressure 0 after pressure was seen is skipped, not a lift', () => {
  const state = { pressureSeen: false };

  assert.deepEqual(splitPenFrame([pen(0.5), pen(0.2), pen(0), pen(0)], state), { contactIndices: [0, 1], verdict: 'skip' });
  assert.equal(classifyPenSample(pen(0), state), 'skip');
});

test('a skipped sample in the middle of a frame does not hide the in-contact ones after it', () => {
  assert.deepEqual(splitPenFrame([pen(0.5), pen(0), pen(0.4)], { pressureSeen: false }), {
    contactIndices: [0, 2],
    verdict: 'contact',
  });
});

test('pressure 0 is NOT skipped until this contact has reported pressure at all', () => {
  // A digitizer that reports 0 on its first frame while the tip is still landing (or a flat 0 for its
  // whole life) must keep every sample.
  const state = { pressureSeen: false };

  assert.deepEqual(splitPenFrame([pen(0), pen(0), pen(0)], state), { contactIndices: [0, 1, 2], verdict: 'contact' });
  assert.equal(state.pressureSeen, false);
  // ...but the moment pressure appears, a later 0 is skipped.
  assert.deepEqual(splitPenFrame([pen(0), pen(0.3), pen(0)], state), { contactIndices: [0, 1], verdict: 'skip' });
});

test('pressure is only read for pen samples; a touch or mouse sample at pressure 0 stays in contact', () => {
  assert.equal(classifyPenSample({ pointerType: 'touch', pressure: 0, buttons: 1 }, { pressureSeen: true }), 'contact');
  assert.equal(classifyPenSample({ pointerType: 'mouse', pressure: 0, buttons: 1 }, { pressureSeen: true }), 'contact');
});

test('samples with no buttons or pressure field are in contact (nothing to judge)', () => {
  assert.deepEqual(splitPenFrame([{ pointerType: 'pen' }, {}], { pressureSeen: true }), { contactIndices: [0, 1], verdict: 'contact' });
});
