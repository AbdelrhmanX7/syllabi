/**
 * The on-device classifier: rules on the recognised text + layout cues measured from the ink.
 *
 * A line is cut into SEGMENTS and every word of a segment gets the SAME class — the colour unit is the
 * segment, never a single recognised word (ML Kit's words are often fragments of a real word: «Mito» +
 * «sis»; a per-word guess on a fragment is what split «Mitosis» into two colours). The segments:
 *
 *   bullet   leading «->», «→», «-», «•», «*», «1.», «1)» — structure, keeps the ink, never makes the
 *            line a formula;
 *   label    the words before a colon near the line start («Definition:», «Part 1:»);
 *   rest     everything after the label (or the whole line when there is none).
 *
 * Order of precedence (on the line after its bullets):
 *   cue word at the start (heading / example / keypoint)     → whole rest, conf 0.9
 *   box drawn round words                                    → keypoint, 0.8
 *   «X:» alone on the line                                   → heading, 0.8
 *   «Part 1: …», «Step 2: …» (enumerated label)               → label heading, rest by its own rules
 *   «X: …»                                                   → term + definition (rest formula if it is one)
 *   formula line: an operator BETWEEN operands, few words    → formula, 0.8 (digits alone never are)
 *   enumerated label without a colon («Part 2 Mitosis»)      → label heading, rest plain
 *   term marker («X is», «X means», «ACRONYM …»)             → term + definition, 0.8 / 0.75
 *   ink much taller than the page (or a fully underlined line) → heading, 0.7
 *   underlined lead word                                     → term + definition
 *   one word that is itself an operator expression («x=2»)   → formula, 0.7
 *   anything else                                            → plain, 0.5 (ambiguous; cloud may help)
 */
import type { InkClassification, InkGroupCues, InkLineCues } from './model';

export interface RuleWord {
  text: string;
  cues?: Partial<InkGroupCues>;
}

/** Segment ids carried on every result (`seg`): words sharing one are coloured as one unit. */
export const SEG_BULLET = 0;
export const SEG_LABEL = 1;
export const SEG_REST = 2;
/** Per-word decisions inside a plain line get their own unit: `SEG_WORD + index`. */
export const SEG_WORD = 100;

// Cue words the recognised handwriting is matched against, not UI copy.
const HEADING_START = /^(chapter|unit|lesson|lecture|topic|section)(?![a-z])/i;
const EXAMPLE_START = /^(e\.?g\.?|ex[:.]|example|for)(?![a-z])/i;
// «*» is a bullet, not a key point.
const KEY_START = /^(remember|important|note|nb)(?![a-z])|^(!{1,3}|⚠|★|☆)/i;
const DEFINE_WORD = /^(is|are|means|=|:)$/i;
/**
 * An enumerated label, matched on the label's text with spaces removed («Part 1» / «Par t1» → «Part1»):
 * a label word followed by a number or a roman numeral.
 */
const ENUM_LABEL =
  /^(part|step|stage|phase|case|type|point|question|q|rule|method|level|item|no\.?|chapter|unit|lesson|lecture|section)(\d+|[ivx]{1,4}(?![a-z]))[:：.)]*$/i;
/** A whole word that is a list bullet. */
const BULLET_WORD =
  /^(?:[-–—_~=]{1,3}\s*[>›»)]|[→⇒➔➜➝►▶•·∙●○◦▪■*+\-–—~>›»]|[-–—_]{2,3}|(?:\d{1,2}|[a-z]|[ivx]{1,4})\s*[.)\-]|[([]\s*\d{1,2}\s*[)\]])$/i;
/** A bullet glued to the first word («->Part»): stripped before the line is read. */
const BULLET_PREFIX = /^(?:[-–—_~=]{1,3}\s*[>›»]|[→⇒➔➜➝►▶•·∙●○◦▪■*])\s*/;
/** An operator BETWEEN two operands: «2n -> 2n», «6CO2 + 6H2O», «F = m × a». A hyphen is not one. */
const OPERATOR_BETWEEN = /[A-Za-z0-9\u00C0-\u024F)\]²³]\s*(?:=|\+|×|÷|\^|->|→|⇒|⇌|≈|≤|≥|<|>|\*|\/|−)\s*[A-Za-z0-9\u00C0-\u024F([√−]/;
const LONG_WORD = /[A-Za-z]{3,}/;
const HAS_ALNUM = /[A-Za-z0-9\u00C0-\u024F]/;
const COLON_END = /[:：]\s*$/;

const result = (cls: InkClassification['cls'], conf: number, seg: number, src: InkClassification['src'] = 'rules'): InkClassification => ({
  cls,
  conf,
  src,
  seg,
});

const clean = (text: string) => text.trim().replace(/^[«"'(]+/, '');

/** Does this word read as a list bullet (text, or the ink's shape when the text is not a word)? */
export function isBulletWord(word: RuleWord): boolean {
  const text = clean(word.text);

  if (BULLET_WORD.test(text)) return true;

  // An arrow/dash shape whose reading is not a word («-s», «_7», nothing at all).
  return Boolean(word.cues?.bullet) && !/[A-Za-z0-9\u00C0-\u024F]{2,}/.test(text);
}

/** An operator expression: operator between operands. `maxWords` caps the real (3+ letter) words. */
export function isFormulaText(text: string, maxWords = 2): boolean {
  if (!OPERATOR_BETWEEN.test(text)) return false;

  return text.split(/\s+/).filter((w) => LONG_WORD.test(w)).length <= maxWords;
}

/** Index of the last word of a term (no colon), or -1. Looks only at the first three words. */
function termEnd(texts: readonly string[]): number {
  if (texts.length < 2) return -1;

  for (let index = 0; index < Math.min(3, texts.length - 1); index += 1) {
    const word = texts[index].trim();

    if (/=\s*$/.test(word) && word.length > 1) return index;
    if (DEFINE_WORD.test(texts[index + 1].trim())) return index;
  }

  if (/^[A-Z]{2,6}$/.test(texts[0].trim())) return 0;

  return -1;
}

/** Index (in `words`) of the word that closes a label with a colon, or -1. */
function labelEnd(words: readonly RuleWord[], texts: readonly string[]): number {
  for (let index = 0; index < Math.min(6, words.length); index += 1) {
    const colon = Boolean(words[index].cues?.colon) || COLON_END.test(texts[index]) || texts[index] === ':';

    if (!colon) continue;
    const label = texts.slice(0, index + 1).join(' ').replace(/[:：]/g, ' ');
    const realWords = label.split(/\s+/).filter((w) => LONG_WORD.test(w)).length;

    // «:» first, or a whole sentence before the colon: not a label.
    if (!HAS_ALNUM.test(label) || realWords > 4) return -1;

    return index;
  }

  return -1;
}

/** Classes for the words after a label («X: rest»), all one segment. */
function restAfterLabel(texts: readonly string[]): InkClassification {
  const joined = texts.join(' ');

  if (isFormulaText(joined, 3)) return result('formula', 0.8, SEG_REST);

  return result('definition', 0.75, SEG_REST);
}

/**
 * Classify every word of one line. `words` are in READING order (first word first, whatever the
 * script's direction). Words sharing a `seg` always share a class.
 */
export function classifyLine(words: readonly RuleWord[], line: Partial<InkLineCues> = {}): InkClassification[] {
  const n = words.length;

  if (n === 0) return [];

  // 1. Bullets: structure, keep the ink.
  let lead = 0;

  while (lead < n && isBulletWord(words[lead])) lead += 1;
  // Only the bullet is written so far: it stays ink, and is not ambiguous.
  if (lead === n) return words.map(() => result('plain', 0.9, SEG_BULLET));
  const out: InkClassification[] = words.map((_, index) => (index < lead ? result('plain', 0.9, SEG_BULLET) : result('plain', 0.5, SEG_REST, 'none')));
  const bodyWords = words.slice(lead);
  const texts = bodyWords.map((w, index) => (index === 0 ? clean(w.text).replace(BULLET_PREFIX, '') : clean(w.text)));
  const m = texts.length;
  const setBody = (pick: (index: number) => InkClassification) => {
    for (let index = 0; index < m; index += 1) out[lead + index] = pick(index);
  };
  const all = (cls: InkClassification['cls'], conf: number, src: InkClassification['src'] = 'rules') =>
    setBody(() => result(cls, conf, SEG_REST, src));
  const first = texts[0] ?? '';
  const spaceless = texts.join('').replace(/\s+/g, '');

  // 2. Cue words decide the whole line.
  if (HEADING_START.test(first) || HEADING_START.test(spaceless)) {
    all('heading', 0.9);

    return out;
  }

  // «for» alone is too common a word: only «for example» starts an example.
  if (EXAMPLE_START.test(first) && (!/^for$/i.test(first) || /^example/i.test(texts[1] ?? ''))) {
    all('example', 0.9);

    return out;
  }

  if (KEY_START.test(first)) {
    all('keypoint', 0.9);

    return out;
  }

  // 3. A box round words: they are a must-remember point.
  if (bodyWords.some((w) => w.cues?.boxed)) {
    setBody((index) => (bodyWords[index].cues?.boxed ? result('keypoint', 0.8, SEG_LABEL, 'geo') : result('plain', 0.5, SEG_REST, 'none')));

    return out;
  }

  // 4. «X:» — a label closed by a colon.
  const end = labelEnd(bodyWords, texts);

  if (end >= 0) {
    const labelText = texts.slice(0, end + 1).join('').replace(/\s+/g, '');
    const rest = texts.slice(end + 1);

    if (rest.length === 0) {
      // Nothing after it: a section heading («Definition:», «Part 2:»).
      all('heading', 0.8);

      return out;
    }

    const labelClass = ENUM_LABEL.test(labelText) ? result('heading', 0.8, SEG_LABEL) : result('term', 0.8, SEG_LABEL);
    const restClass = restAfterLabel(rest);

    setBody((index) => (index <= end ? { ...labelClass } : { ...restClass }));

    return out;
  }

  // 5. A formula line: an operator between operands, few real words. Digits alone never are.
  if (isFormulaText(texts.join(' '))) {
    all('formula', 0.8);

    return out;
  }

  // 6. An enumerated label without a colon: «Part 2 Mitosis», «Step iv».
  for (let index = Math.min(2, m - 1); index >= 0; index -= 1) {
    if (!ENUM_LABEL.test(texts.slice(0, index + 1).join('').replace(/\s+/g, ''))) continue;
    setBody((k) => (k <= index ? result('heading', 0.8, SEG_LABEL) : result('plain', 0.6, SEG_REST)));

    return out;
  }

  // 7. «X is …», «X means …», an acronym lead.
  const term = termEnd(texts);

  if (term >= 0) {
    setBody((index) => (index <= term ? result('term', 0.8, SEG_LABEL) : result('definition', 0.75, SEG_REST)));

    return out;
  }

  // 8. Layout: big ink or a fully underlined line is a heading.
  const sizeRatio = line.sizeRatio ?? 1;

  if ((sizeRatio >= 1.4 || line.fullyUnderlined) && m <= 7) {
    all('heading', 0.7, 'geo');

    return out;
  }

  // 9. An underlined lead word: what follows on the line is its definition.
  if (bodyWords[0].cues?.underlined && m > 1) {
    let k = 0;

    while (k < m && bodyWords[k].cues?.underlined) k += 1;
    setBody((index) => (index < k ? result('term', 0.7, SEG_LABEL, 'geo') : result('definition', 0.6, SEG_REST, 'geo')));

    return out;
  }

  // 10. Per word: an underlined word, or one word that is itself an expression («x=2»).
  for (let index = 0; index < m; index += 1) {
    if (bodyWords[index].cues?.underlined && m > 1) out[lead + index] = result('term', 0.7, SEG_WORD + lead + index, 'geo');
    else if (isFormulaText(texts[index], 0)) out[lead + index] = result('formula', 0.7, SEG_WORD + lead + index);
  }

  return out;
}
