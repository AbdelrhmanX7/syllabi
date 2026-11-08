/**
 * Hover-without-contact detection for pen and mouse pointers.
 *
 * The invariant it serves (see `commitStrokeOnHoverWithoutContact` in useWhiteboardCanvas): a pen or
 * mouse that is MOVING WITHOUT CONTACT cannot be the thing holding a freehand stroke open. Fabric v7
 * (non-pointer mode) has no such check — `_onMouseMoveInDrawingMode` extends the open path on EVERY
 * mousemove while `_isCurrentlyDrawing`, and a stylus hovering over the glass produces exactly those
 * mousemoves (Android S Pen / M-Pen, ThinkPad active pen). So once the stroke-ending touchend/mouseup
 * is lost — the OS drops it during pen/finger interleaving — the hover path is inked forever.
 *
 * Contact is the PRIMARY button bit of `buttons` (bit 1: pen tip on the glass / mouse left button).
 * It is deliberately NOT `buttons === 0`: a pen hovering with its barrel button held reports
 * `buttons === 2`, and that is still no contact. Pressure is not consulted — some digitizers report
 * pressure 0 on the first contact frame, and the contact bit is what Fabric's own mousedown keyed on.
 */

/** `buttons` bit for the primary contact: pen tip touching the digitizer, or the mouse's left button. */
export const PRIMARY_CONTACT_BUTTON_BIT = 1;

export interface HoverContactEventLike {
  /** Absent on a compat `MouseEvent` (Chromium only types `click`/`contextmenu` as PointerEvents). */
  pointerType?: string;
  buttons?: number;
}

/**
 * Pointer classes this check judges: a real pen, a real mouse, and the compat mouse events a browser
 * synthesises from either (no `pointerType`). A TOUCH pointer is never judged: a finger has no hover
 * state (its `buttons` is 0 only when it has already left), and on the touch-only panels (ViewSonic)
 * fingers and capacitive pen heads both report as 'touch' and legitimately hold a stroke open while
 * resting still.
 */
export function isPenOrMouseLikePointer(event: HoverContactEventLike): boolean {
  const { pointerType } = event;

  return pointerType === 'pen' || pointerType === 'mouse' || pointerType === undefined || pointerType === '';
}

/** True when the pen tip / mouse left button is NOT down on this event. Unknown `buttons` → false. */
export function hasNoPrimaryContact(event: HoverContactEventLike): boolean {
  const { buttons } = event;

  if (typeof buttons !== 'number') {
    return false;
  }

  return (buttons & PRIMARY_CONTACT_BUTTON_BIT) === 0;
}

/**
 * A pen/mouse(-like) pointer moving with no primary contact — the ONLY evidence a browser gives that a
 * stylus has left the glass when its lift event never arrived. Touch pointers and unknown button
 * states are never reported as hover, so acting on this can never truncate a finger's stroke.
 */
export function isHoverWithoutContact(event: HoverContactEventLike): boolean {
  return isPenOrMouseLikePointer(event) && hasNoPrimaryContact(event);
}
