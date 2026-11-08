/**
 * A REFERENCE-COUNTED body scroll lock.
 *
 * The obvious spelling of this is capture-then-restore, and it is what both the
 * Modal and the teacher print sheet used to do:
 *
 *     const previous = document.body.style.overflow;
 *     document.body.style.overflow = 'hidden';
 *     return () => { document.body.style.overflow = previous; };
 *
 * That is correct for exactly one locker at a time and silently wrong the moment two
 * overlap, because the second one captures the FIRST one's 'hidden' as its "previous"
 * and faithfully restores it on the way out. The page is then scroll-locked forever,
 * with no modal on screen and nothing in the DOM to explain it — the user just finds
 * that the mouse wheel stops working. Observed exactly that on the teacher exams table
 * after visiting the print sheet: `data-qp-print` correctly gone, `body { overflow:
 * hidden }` still there.
 *
 * Overlap is not exotic. Two locks coexist whenever a modal is open over a locked page,
 * whenever one modal opens another, and whenever a route transition briefly mounts the
 * next page before unmounting the previous one (which `PageTransition` does by design).
 *
 * Counting fixes it: only the first lock touches the style, only the last release
 * undoes it, and the value to restore is captured once — from the state before ANY
 * lock existed. `_app.tsx` in teacher/admin/web each carry a hand-rolled `unlockScroll`
 * that force-clears the style; those are treatments for this bug, and can go once
 * everything locks through here.
 */

let lockCount = 0;

/** The inline value from before the FIRST lock. `null` = nothing captured / not locked. */
let valueBeforeFirstLock: string | null = null;

/**
 * Locks body scroll and returns the matching release.
 *
 * The returned function is idempotent — calling it twice releases once. React only
 * invokes an effect cleanup once, but a caller that also releases on an event (a close
 * button, say) would otherwise drive the count negative and let a later release
 * unlock while another locker is still holding.
 *
 * SSR-safe: with no `document` it locks nothing and returns a no-op.
 */
export function lockBodyScroll(): () => void {
  if (typeof document === 'undefined') return () => {};

  if (lockCount === 0) {
    valueBeforeFirstLock = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }

  lockCount += 1;

  let isReleased = false;

  return () => {
    if (isReleased) return;
    isReleased = true;

    lockCount -= 1;

    if (lockCount > 0) return;

    // Restore what was there before anyone locked. An empty capture means there was
    // no inline overflow at all, so REMOVE the property rather than setting it to the
    // empty string — leaving `style="overflow: "` behind is not the same as leaving
    // the element alone, and it defeats any stylesheet rule that expects to win.
    if (valueBeforeFirstLock) {
      document.body.style.overflow = valueBeforeFirstLock;
    } else {
      document.body.style.removeProperty('overflow');
    }

    valueBeforeFirstLock = null;
  };
}
