/**
 * Assertions that survived contact with these apps.
 *
 * Each one exists because its naive version produced a FALSE PASS or a false
 * failure at least once — the comments say which.
 */

/** One surface's worth of assertions. `failures` empty ⇒ the surface passed. */
export class Check {
  constructor(label, log = (msg) => console.log(msg)) {
    this.label = label;
    this.failures = [];
    this.notes = [];
    this.log = log;
  }

  ok(name, condition, detail = '') {
    if (!condition) this.failures.push(`${name}${detail ? ` (${detail})` : ''}`);
    this.log(`   ${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);

    return !!condition;
  }

  eq(name, actual, expected) {
    const passed = JSON.stringify(actual) === JSON.stringify(expected);

    if (!passed) this.failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    this.log(`   ${passed ? 'PASS' : 'FAIL'}  ${name} → ${JSON.stringify(actual)}`);

    return passed;
  }

  fail(name, detail = '') {
    return this.ok(name, false, detail);
  }

  note(message) {
    this.notes.push(message);
    this.log(`   note  ${message}`);
  }

  get passed() {
    return this.failures.length === 0;
  }
}

/**
 * Wait for every figure to finish DECODING.
 *
 * FOOTGUN: `loading="lazy"` plus `content-visibility` means an off-screen image
 * never decodes — `naturalWidth` stays 0 and the assertion fails on a page where
 * the figure is perfectly fine. Scroll the document first, then wait for the
 * decode, then scroll back so the screenshot frames the top of the page.
 */
export async function settleFigures(page, alt, expected = null) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

  const count = await page.locator(`img[alt="${alt}"]`).count();

  for (let i = 0; i < count; i++) {
    await page
      .locator(`img[alt="${alt}"]`)
      .nth(i)
      .scrollIntoViewIfNeeded({ timeout: 5000 })
      .catch(() => {});
  }

  if (expected === null || expected > 0) {
    await page
      .waitForFunction(
        ({ alt: a, expected: n }) => {
          const imgs = [...document.querySelectorAll(`img[alt="${a}"]`)];

          if (n !== null && imgs.length !== n) return false;

          return imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0);
        },
        { alt, expected },
        { timeout: 15_000 },
      )
      .catch(() => {
        /* let the assertion below report the real state */
      });
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
}

/**
 * Every figure on the page: whether it decoded, and the geometry of its box.
 *
 * `complete` alone is a FALSE PASS — a 404'd image is also "complete". The pair
 * `complete && naturalWidth > 0` is the real load signal.
 */
export async function figureReport(page, alt, { settle = true } = {}) {
  if (settle) await settleFigures(page, alt);

  return page.evaluate((a) => {
    const round = (n) => Math.round(n * 100) / 100;

    return [...document.querySelectorAll(`img[alt="${a}"]`)].map((img) => {
      const style = getComputedStyle(img);
      const rect = img.getBoundingClientRect();
      const parent = img.parentElement;
      const parentRect = parent ? parent.getBoundingClientRect() : null;

      return {
        src: img.getAttribute('src'),
        currentSrc: img.currentSrc,
        loading: img.getAttribute('loading'),
        complete: img.complete,
        loaded: img.complete && img.naturalWidth > 0,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: round(rect.width), height: round(rect.height) },
        // The LAYOUT box, which is what the CSS actually asked for. `rect` is the
        // TRANSFORMED box: these cards run an entry animation, so a figure whose
        // layout is a clean 322x202 measures 324.79x206.48 mid-scale. Geometry is
        // asserted on `layout`; `rect` stays for overflow, which compares two
        // transformed boxes against each other and so is consistent either way.
        layout: { width: parseFloat(style.width) || 0, height: parseFloat(style.height) || 0 },
        css: { width: style.width, height: style.height, objectFit: style.objectFit, display: style.display },
        parentWidth: parentRect ? Math.round(parentRect.width) : null,
        overflowsParent: parentRect ? rect.width > parentRect.width + 1 : null,
        docScrollsX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
  }, alt);
}

/** `imgLoaded` for a single figure — the common one-question-on-screen case. */
export async function imgLoaded(page, alt, { settle = true } = {}) {
  const [figure] = await figureReport(page, alt, { settle });

  return figure ? figure.loaded : false;
}

/**
 * Geometry problems with a figure's box.
 *
 * The figure is `max-h-64 max-w-full self-start object-contain` in a flex
 * column. `self-start` is what stops it stretching to the column's width — with
 * `stretch` (the flex default) it renders full-width and letterboxed, which is a
 * real bug that a "did it load" assertion cannot see. So: never larger than its
 * own natural size (plus the 1px border on each side), never wider than its
 * parent, and the aspect ratio preserved.
 *
 * Measured on the LAYOUT box — see the note in `figureReport`.
 */
export function geometryProblems(figure, { label = 'figure', tolerance = 4, checkDocScroll = false } = {}) {
  const problems = [];

  if (!figure) return [`${label}: no figure to measure`];

  const { layout, naturalWidth, naturalHeight } = figure;

  if (!(layout.width > 0 && layout.height > 0)) problems.push(`${label}: zero-sized box ${JSON.stringify(layout)}`);
  if (figure.overflowsParent) {
    problems.push(`${label}: overflows its parent (${figure.rect.width} > ${figure.parentWidth})`);
  }
  if (checkDocScroll && figure.docScrollsX) problems.push(`${label}: the document scrolls horizontally`);

  if (naturalWidth > 0 && layout.width > naturalWidth + tolerance) {
    problems.push(`${label}: stretched — laid out ${layout.width}px wide from a ${naturalWidth}px source`);
  }
  if (naturalHeight > 0 && layout.height > naturalHeight + tolerance) {
    problems.push(`${label}: stretched — laid out ${layout.height}px tall from a ${naturalHeight}px source`);
  }

  if (naturalWidth > 0 && naturalHeight > 0 && layout.height > 0) {
    const natural = naturalWidth / naturalHeight;
    const rendered = layout.width / layout.height;

    // 4% covers the 1px border on each side of a small figure without letting a
    // genuinely squashed box through.
    if (Math.abs(rendered - natural) > natural * 0.04) {
      problems.push(`${label}: aspect ratio ${rendered.toFixed(3)} ≠ natural ${natural.toFixed(3)}`);
    }
  }

  return problems;
}

/**
 * Document-order check: the stem comes BEFORE the figure, which comes BEFORE the
 * first option.
 *
 * FOOTGUN 1: an ANCESTOR of the figure also reports as "preceding" it, so a
 * container wrapping both stem and figure passes a naive check even when the
 * figure is rendered in the wrong place. Only a true sibling subtree counts.
 *
 * FOOTGUN 2: text is matched EXACTLY on normalised whitespace. Substring
 * matching is a trap — stems share long prefixes, and an option's text
 * is frequently a substring of the stem's.
 */
export async function betweenInDocumentOrder(page, { alt, stemText, firstOptionText }) {
  return page.evaluate(
    ({ alt: a, stemText: stem, firstOptionText: option }) => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const all = [...document.querySelectorAll('body *')];
      const exact = (text) => all.filter((el) => norm(el.textContent) === text);
      const imgs = [...document.querySelectorAll(`img[alt="${a}"]`)];

      const BEFORE = Node.DOCUMENT_POSITION_PRECEDING;
      const AFTER = Node.DOCUMENT_POSITION_FOLLOWING;

      const stems = exact(stem);
      const options = exact(option);

      if (stems.length === 0) return { ok: false, why: 'stem text not found on page' };
      if (options.length === 0) return { ok: false, why: 'first option text not found on page' };
      if (imgs.length === 0) return { ok: false, why: 'no figure on page' };

      for (const img of imgs) {
        const sibling = (el) => !el.contains(img) && !img.contains(el);
        const stemBefore = stems.some((el) => sibling(el) && img.compareDocumentPosition(el) & BEFORE);
        const optionAfter = options.some((el) => sibling(el) && img.compareDocumentPosition(el) & AFTER);

        if (stemBefore && optionAfter) return { ok: true };
      }

      return { ok: false, why: `no figure sits between the stem and its options (figures on page: ${imgs.length})` };
    },
    { alt, stemText, firstOptionText },
  );
}

/**
 * The ABSENCE case, scoped to one question.
 *
 * "No figure anywhere on the page" is the wrong assertion on a review list that
 * shows every question at once. The question BLOCK is the nearest ancestor of
 * the stem that also holds that question's first option — the smallest subtree
 * that is unambiguously "this question" on every surface.
 */
export async function noFigureInQuestionBlock(page, { alt, stemText, firstOptionText }) {
  return page.evaluate(
    ({ alt: a, stemText: stem, firstOptionText: option }) => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const all = [...document.querySelectorAll('body *')];
      const stems = all.filter((el) => norm(el.textContent) === stem);

      if (stems.length === 0) return { ok: false, why: 'stem text not found on page' };

      const holdsOption = (root) => [...root.querySelectorAll('*')].some((el) => norm(el.textContent) === option);

      const deepestStem = stems[stems.length - 1];
      let node = deepestStem.parentElement;

      while (node && node !== document.body && !holdsOption(node)) node = node.parentElement;

      if (!node || node === document.body) return { ok: false, why: 'could not isolate the question block' };

      const inside = node.querySelectorAll(`img[alt="${a}"]`).length;

      return inside === 0 ? { ok: true } : { ok: false, why: `${inside} figure(s) inside the no-figure question` };
    },
    { alt, stemText, firstOptionText },
  );
}

/**
 * Does the stem stay inside its card?
 *
 * The bug: the editor writes every space in a stem as `&nbsp;`, so the browser is
 * told the whole sentence is one unbreakable word. It renders on a single line
 * that runs out of the card sideways and, on the surfaces where the stem is a
 * flex item, widens the card and the whole page with it.
 *
 * ⚠️ MEASURED ON LAYOUT VALUES (`scrollWidth` / `clientWidth`), NOT `getBoundingClientRect`.
 * These cards run an entry animation, so a rect-based version of this assertion
 * compares a mid-scale transformed box against an untransformed one and reports
 * an overflow that does not exist. `scrollWidth` and `clientWidth` are both
 * pre-transform, so they stay consistent whenever the check happens to run.
 *
 * `stem.scrollWidth > card.clientWidth` is the one comparison that catches BOTH
 * shapes of the failure: the stem whose text spills out of a fixed-width box, and
 * the stem that is itself a flex item and grows instead of wrapping. Checking
 * only `stem.scrollWidth > stem.clientWidth` misses the second — the box grew to
 * fit its text, so it looks perfectly contained, and only the card is destroyed.
 *
 * The card is auto-detected as the nearest ancestor that is drawn like one (a
 * radius, a border or a background of its own), which is what `Card`, `PaperCard`
 * and the minology equivalents all are. Pass `cardSelector` when a surface has a
 * card the heuristic cannot see.
 *
 * ⚠️ `measured.nbsp` IS THE ASSERTION FOR THE NORMALISER; THE WIDTHS ARE NOT.
 *
 * The renderers also carry a CSS guard (`break-words`), and that guard alone is
 * enough to keep the stem inside the card — verified by disabling the normaliser
 * and watching every width assertion here still pass. So a width check cannot
 * tell a working normaliser from a bypassed one; it only proves the containment
 * net holds. `nbsp` counts the `U+00A0` characters that actually reached the
 * screen, which is the one number that moves when the normaliser stops running.
 * Assert both: the count for the fix, the widths for the net under it.
 */
export async function stemContainment(page, { stemText, cardSelector = null, tolerance = 1 }) {
  return page.evaluate(
    ({ stemText: stem, cardSelector: sel, tolerance: slack }) => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const all = [...document.querySelectorAll('body *')];
      const matches = all.filter((el) => norm(el.textContent) === stem);

      if (matches.length === 0) return { ok: false, why: 'stem text not found on page' };

      // The DEEPEST match is the element that actually carries the text; the
      // outer ones merely contain it, and their width is the card's, not the
      // stem's — measuring one of those is a guaranteed false pass.
      const stemEl = matches[matches.length - 1];

      const describe = (el) =>
        el ? `${el.tagName.toLowerCase()}.${String(el.className || '').slice(0, 50)}`.trim() : 'none';

      const looksLikeCard = (el) => {
        const style = getComputedStyle(el);
        const bg = style.backgroundColor;
        const opaqueBg = bg && bg !== 'transparent' && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(bg);

        return (
          parseFloat(style.borderTopLeftRadius) > 0 || parseFloat(style.borderTopWidth) > 0 || opaqueBg
        );
      };

      let card = sel ? stemEl.closest(sel) : null;

      if (!card) {
        let node = stemEl.parentElement;

        while (node && node !== document.body && !looksLikeCard(node)) node = node.parentElement;
        card = node && node !== document.body ? node : document.documentElement;
      }

      const measured = {
        stem: describe(stemEl),
        card: describe(card),
        stemScrollWidth: stemEl.scrollWidth,
        stemClientWidth: stemEl.clientWidth,
        cardClientWidth: card.clientWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        docClientWidth: document.documentElement.clientWidth,
        // How many non-breaking spaces reached the screen — see the note above.
        nbsp: ((stemEl.textContent || '').match(/\u00A0/g) || []).length,
      };

      if (measured.stemScrollWidth > measured.cardClientWidth + slack) {
        return {
          ok: false,
          measured,
          why: `the stem is ${measured.stemScrollWidth}px wide inside a ${measured.cardClientWidth}px ${measured.card}`,
        };
      }

      return { ok: true, measured };
    },
    { stemText, cardSelector, tolerance },
  );
}

/**
 * Does the PAGE scroll sideways?
 *
 * The card-level check above is the precise one; this is the symptom a student
 * actually reports. Kept separate because one surface (`apps/web`'s homework
 * page) has a pre-existing horizontal scroll of its own that has nothing to do
 * with stems — there, assert containment and skip this.
 */
export async function documentScrollsX(page, { tolerance = 1 } = {}) {
  return page.evaluate((slack) => {
    const root = document.documentElement;

    return {
      scrolls: root.scrollWidth > root.clientWidth + slack,
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
    };
  }, tolerance);
}

/**
 * Flat document-order indexes for the figures and a set of named text markers.
 *
 * Comparing integers is how a LIST surface ("figure 2 belongs to question 3, and
 * sits above the banner") is checked, where per-question subtree isolation is
 * more machinery than the question needs. -1 means the marker was not found.
 */
export async function domOrderIndexes(page, { alt, texts }) {
  return page.evaluate(
    ({ alt: a, texts: wanted }) => {
      const all = [...document.querySelectorAll('*')];
      const imgs = [];

      all.forEach((el, i) => {
        if (el.tagName === 'IMG' && el.getAttribute('alt') === a) imgs.push(i);
      });

      const found = {};

      for (const [key, needle] of Object.entries(wanted)) {
        let leaf = -1;
        let any = -1;

        all.forEach((el, i) => {
          if ((el.textContent || '').trim() !== needle) return;
          if (any === -1) any = i;
          if (el.children.length === 0 && leaf === -1) leaf = i;
        });
        // Prefer the leaf that CARRIES the text over the outermost container
        // that merely contains it.
        found[key] = leaf !== -1 ? leaf : any;
      }

      return { imgs, texts: found };
    },
    { alt, texts },
  );
}

/**
 * A locator for text matched EXACTLY.
 *
 * `getByText(x)` is substring matching, which on dense surfaces resolves
 * to several elements (stem, aria label, a nav pill) and then throws strict-mode
 * violations — or worse, silently matches the wrong one.
 */
export function exactText(page, text) {
  return page.getByText(text, { exact: true });
}

/**
 * Would a real tap at this element's centre actually reach it?
 *
 * `expect(button).toBeVisible()` is a FALSE PASS when a fixed overlay (Next's
 * dev indicator, a push-permission banner, a sticky footer) sits on top: the
 * button is visible, and the tap lands on the overlay. `elementFromPoint` is
 * what the browser itself would hit.
 */
export async function clickReachable(page, selector) {
  return page.evaluate((sel) => {
    const el = typeof sel === 'string' ? document.querySelector(sel) : null;

    if (!el) return { ok: false, why: `no element matches ${sel}` };

    const rect = el.getBoundingClientRect();

    if (rect.width === 0 || rect.height === 0) return { ok: false, why: 'element has a zero-sized box' };

    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const hit = document.elementFromPoint(x, y);

    if (hit && (hit === el || el.contains(hit) || hit.contains(el))) return { ok: true, point: [x, y] };

    return {
      ok: false,
      point: [x, y],
      why: `a tap at (${x}, ${y}) lands on ${hit ? `${hit.tagName}.${String(hit.className).slice(0, 60)}` : 'nothing'}`,
    };
  }, selector);
}

/** Same reachability question, for a locator rather than a CSS selector. */
export async function locatorReachable(locator) {
  return locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();

    if (rect.width === 0 || rect.height === 0) return { ok: false, why: 'element has a zero-sized box' };

    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const hit = document.elementFromPoint(x, y);

    if (hit && (hit === el || el.contains(hit) || hit.contains(el))) return { ok: true, point: [x, y] };

    return {
      ok: false,
      point: [x, y],
      why: `a tap at (${x}, ${y}) lands on ${hit ? `${hit.tagName}.${String(hit.className).slice(0, 60)}` : 'nothing'}`,
    };
  });
}

/** Quill writes typed spaces as `&nbsp;` and wraps content in tags — compare as plain text. */
export const plainText = (html) =>
  String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;| /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** `hasOwnProperty` — an ABSENT key and a `null` value are different bugs. */
export const hasKey = (obj, key) => !!obj && Object.prototype.hasOwnProperty.call(obj, key);
