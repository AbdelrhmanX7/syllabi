import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hasNoPrimaryContact, isHoverWithoutContact, isPenOrMouseLikePointer } from './hoverContact';

// The Android stylus hover stream: pointermove (pointerType 'pen', buttons 0, pressure 0) plus a compat
// mousemove with no pointerType. Both are "a pen moving without contact" and both must be recognised.
test('a hovering pen is hover-without-contact on the pointer AND the compat mouse channel', () => {
  assert.equal(isHoverWithoutContact({ pointerType: 'pen', buttons: 0 }), true);
  assert.equal(isHoverWithoutContact({ buttons: 0 }), true, 'compat MouseEvent (no pointerType)');
  assert.equal(isHoverWithoutContact({ pointerType: '', buttons: 0 }), true, 'empty pointerType');
  assert.equal(isHoverWithoutContact({ pointerType: 'mouse', buttons: 0 }), true, 'a real mouse hover');
});

// Contact is the PRIMARY bit, not `buttons === 0`: a pen hovering with its barrel button held reports
// buttons 2 and is still off the glass; a pen writing with the barrel held reports 3 and is in contact.
test('contact is judged on the primary button bit only', () => {
  assert.equal(isHoverWithoutContact({ pointerType: 'pen', buttons: 2 }), true, 'barrel held while hovering');
  assert.equal(isHoverWithoutContact({ pointerType: 'pen', buttons: 32 }), true, 'eraser-end button in the air');
  assert.equal(isHoverWithoutContact({ pointerType: 'pen', buttons: 1 }), false, 'tip down');
  assert.equal(isHoverWithoutContact({ pointerType: 'pen', buttons: 3 }), false, 'tip down + barrel held');
  assert.equal(isHoverWithoutContact({ pointerType: 'mouse', buttons: 1 }), false, 'left button down');
  assert.equal(isHoverWithoutContact({ pointerType: 'mouse', buttons: 2 }), true, 'right button only is no contact');
});

// A finger has no hover state. On the ViewSonic every head of the capacitive pen reports as 'touch' and
// legitimately holds a stroke open while resting still — a touch pointer must NEVER read as hover.
test('touch pointers are never hover, whatever their buttons say', () => {
  assert.equal(isPenOrMouseLikePointer({ pointerType: 'touch', buttons: 0 }), false);
  assert.equal(isHoverWithoutContact({ pointerType: 'touch', buttons: 0 }), false);
  assert.equal(isHoverWithoutContact({ pointerType: 'touch', buttons: 1 }), false);
});

// An unknown button state is not evidence of anything — never act on it.
test('a missing buttons field is not hover', () => {
  assert.equal(hasNoPrimaryContact({ pointerType: 'pen' }), false);
  assert.equal(isHoverWithoutContact({ pointerType: 'pen' }), false);
  assert.equal(isHoverWithoutContact({}), false);
});
