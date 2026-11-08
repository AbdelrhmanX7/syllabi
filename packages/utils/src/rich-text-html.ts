/**
 * Markup-level normalisation for teacher-authored rich text (exam stems, option
 * bodies, question-bank items), applied on the way into a renderer.
 *
 * Sibling of `rich-text-style.ts`, and the same rule in a different disguise:
 * **authored content may decorate text, never lay out the page.** That file
 * drops a pasted `white-space: nowrap`; this one drops the non-breaking space,
 * which is the pasted-CSS bug spelled with characters instead of a declaration.
 */

/**
 * The editor writes EVERY space as a non-breaking one.
 *
 * A stem typed into the Quill modal comes back with `&nbsp;` between each pair
 * of words rather than a plain space. `&nbsp;` is `U+00A0`, and the one thing
 * that character is defined to do is refuse to break — so the browser is told
 * the entire sentence is a single unbreakable word. It renders on one line,
 * overflows the question card sideways, and on a phone drags the page's width
 * with it. That is production behaviour today, not a hypothetical: the stems
 * are already stored this way.
 *
 * A non-breaking space has no legitimate role in this content. It exists to
 * keep `10 km` or `Dr. X` from splitting across a line, and nothing in an exam
 * stem is authored with that intent — every occurrence we have is editor
 * exhaust. So the substitution is unconditional rather than heuristic.
 *
 * Both spellings have to go. The entity forms are what the editor stores, and
 * the literal character is what survives a round-trip through anything that
 * decodes on the way (a parse-and-reserialise, a copy through the clipboard).
 * A renderer that handles only one of them looks fixed on the fixture and is
 * still broken on the data.
 *
 * ⚠️ The entity patterns must not match `&amp;nbsp;` — an author who typed the
 * text «&nbsp;» meaning to show it. They do not: that string contains no `&`
 * directly followed by `nbsp;`, so it passes through and still renders as the
 * literal text they wrote.
 */
const NBSP_ENTITY = /&nbsp;/gi;

/** `&#160;` and `&#xa0;`, with the leading zeros both forms tolerate. */
const NBSP_NUMERIC_ENTITY = /&#(?:0*160|[xX]0*[aA]0);/g;

/** The decoded character itself, escaped — a literal U+00A0 in source is invisible. */
const NBSP_CHARACTER = /\u00A0/g;

/**
 * Authored HTML with its non-breaking spaces turned into ordinary ones.
 *
 * Runs on the raw markup string, BEFORE sanitising or parsing, so it reaches
 * both the entity the editor stored and the character a decoder produced. It is
 * a string substitution with no DOM, so it is safe during SSR and cheap enough
 * to sit inside a render path.
 *
 * ⚠️ **Not a sanitiser.** It removes nothing dangerous and grants nothing safe;
 * callers still sanitise exactly as before. Never let this substitute for that.
 */
export const normalizeAuthoredHtml = (html: string | null | undefined): string =>
  (html ?? '').replace(NBSP_ENTITY, ' ').replace(NBSP_NUMERIC_ENTITY, ' ').replace(NBSP_CHARACTER, ' ');
