/**
 * Inline-style filtering for teacher-authored rich text (exam stems, options,
 * question-bank items).
 *
 * Stems are pasted from Word, Google Docs and older editors, which emit inline
 * CSS on almost every element. The renderers used to convert that CSS verbatim
 * into a React `style` object, so a single pasted `white-space: nowrap` made a
 * question stem refuse to wrap: on a phone it ran off the edge of the screen and
 * dragged the whole page's width with it, leaving the card, the options and the
 * number strip squeezed into a column at the far side and the page scrolling
 * sideways. The student could not read the question they were being timed and
 * graded on.
 *
 * The rule this encodes: **pasted CSS may decorate text, never lay out the
 * page.** Colour, weight, style and alignment survive because teachers use them
 * deliberately. Anything that can size, position or un-wrap a box is dropped —
 * a stem has no business setting those, and every value we have seen for them
 * came from a paste rather than a choice.
 */

/**
 * Properties dropped outright: they position or detach a box, and none of them
 * has a legitimate use inside a question stem.
 */
const NEVER_ALLOWED = new Set(['position', 'float', 'clear', 'zIndex', 'transform', 'inset', 'top', 'right', 'bottom', 'left']);

/**
 * Size properties — kept only when the value cannot exceed the container.
 * `50%` and `auto` are safe by construction; `900px` is the bug.
 */
const SIZE_PROPERTIES = new Set(['width', 'minWidth', 'maxWidth', 'height', 'minHeight', 'maxHeight']);

/** Absolute units cannot shrink to fit a phone. Relative ones can. */
const ABSOLUTE_UNIT = /\d\s*(px|pt|pc|cm|mm|in|q)\b/i;

/** The `white-space` values that stop text wrapping. `pre-wrap`/`pre-line` still wrap. */
const NON_WRAPPING = new Set(['nowrap', 'pre']);

/**
 * True when a single declaration is safe to keep.
 *
 * `property` is camelCase (React style-object form), `value` is the raw CSS value.
 */
export const isSafeInlineStyle = (property: string, value: string): boolean => {
  if (NEVER_ALLOWED.has(property)) return false;

  if (property === 'whiteSpace') return !NON_WRAPPING.has(value.trim().toLowerCase());

  // `overflow: hidden` on a pasted wrapper clips content we need to show.
  if (property === 'overflow' || property === 'overflowX' || property === 'overflowY') return false;

  if (SIZE_PROPERTIES.has(property)) return !ABSOLUTE_UNIT.test(value);

  return true;
};

/**
 * Parses an inline `style` attribute into a React style object, dropping the
 * declarations that could break the page layout.
 *
 * Returns `undefined` rather than an empty object so callers can spread the
 * result without emitting `style={{}}` on every element.
 */
export const sanitizeInlineStyle = (styleText: string | null | undefined): Record<string, string> | undefined => {
  if (!styleText) return undefined;

  const styleObject: Record<string, string> = {};

  styleText.split(';').forEach((rule) => {
    const separatorIndex = rule.indexOf(':');

    if (separatorIndex === -1) return;

    const cssProperty = rule.slice(0, separatorIndex).trim();
    // Split on the FIRST colon only — `background: url(http://…)` and
    // `font: 12px/1.5 x` both carry colons inside the value.
    const cssValue = rule.slice(separatorIndex + 1).trim();

    if (!cssProperty || !cssValue) return;

    // Custom properties (`--x`) are passed through untouched; camelCasing them
    // would corrupt the name, and they cannot apply themselves to anything.
    const reactProperty = cssProperty.startsWith('--')
      ? cssProperty
      : cssProperty.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

    if (!isSafeInlineStyle(reactProperty, cssValue)) return;

    styleObject[reactProperty] = cssValue;
  });

  return Object.keys(styleObject).length > 0 ? styleObject : undefined;
};
