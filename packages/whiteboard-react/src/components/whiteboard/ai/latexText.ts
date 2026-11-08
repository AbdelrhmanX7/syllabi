/**
 * LaTeX → readable plain text, for the places a typeset formula cannot go: inline math inside an
 * editable Textbox, table cells, and the fallback when a display formula cannot be rasterised.
 *
 * `\frac{2x}{2} = 4` → `2x/2 = 4`, `x^{2}` → `x²`, `\sqrt{9}` → `√9`, `\alpha` → `α`.
 *
 * Inside a formula every space is a NO-BREAK SPACE: Fabric's Textbox wraps at plain spaces only, so
 * an unbreakable run moves to the next line whole; one wider than the box widens the box instead of
 * splitting.
 */

const NBSP = '\u00A0';

const SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
  rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ',
  Omega: 'Ω',
  times: '×', div: '÷', cdot: '·', pm: '±', mp: '∓', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠',
  ne: '≠', approx: '≈', equiv: '≡', sim: '∼', propto: '∝', infty: '∞', to: '→', rightarrow: '→',
  Rightarrow: '⇒', leftarrow: '←', Leftarrow: '⇐', leftrightarrow: '↔', Leftrightarrow: '⇔',
  longrightarrow: '⟶', implies: '⇒', iff: '⇔', uparrow: '↑', downarrow: '↓', degree: '°', circ: '°',
  angle: '∠', triangle: '△', parallel: '∥', perp: '⊥', in: '∈', notin: '∉', subset: '⊂',
  subseteq: '⊆', supset: '⊃', cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅', forall: '∀',
  exists: '∃', neg: '¬', land: '∧', lor: '∨', sum: 'Σ', prod: 'Π', int: '∫', oint: '∮', partial: '∂',
  nabla: '∇', therefore: '∴', because: '∵', ldots: '…', cdots: '⋯', dots: '…', checkmark: '✓',
  hbar: 'ħ', ell: 'ℓ', prime: '′', star: '⋆', ast: '∗', bullet: '•', mid: '|', lvert: '|', rvert: '|',
  langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', Box: '□', square: '□',
  quad: ' ', qquad: '  ', ',': ' ', ';': ' ', ':': ' ', '!': '', ' ': ' ', '%': '%', '$': '$', '&': '&',
  '#': '#', _: '_', '{': '{', '}': '}', '\\': ' ', cr: ' ', newline: ' ', sin: 'sin', cos: 'cos',
  tan: 'tan', cot: 'cot', sec: 'sec', csc: 'csc', log: 'log', ln: 'ln', exp: 'exp', lim: 'lim',
  max: 'max', min: 'min', det: 'det', arcsin: 'arcsin', arccos: 'arccos', arctan: 'arctan',
};

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ', x: 'ˣ', y: 'ʸ', '°': '°',
};

const SUBSCRIPT: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', o: 'ₒ', x: 'ₓ', i: 'ᵢ', n: 'ₙ',
  m: 'ₘ', k: 'ₖ', t: 'ₜ', r: 'ᵣ',
};

/** Characters that may stand next to a fraction without parentheses: `2x/3`, `a/b`. */
const SIMPLE_OPERAND_RE = /^[A-Za-z0-9\u0391-\u03C9.′°²³]+$/;

/** Reads one `{…}` group (or a single token) starting at `index`; returns [content, nextIndex]. */
function readArgument(source: string, index: number): [string, number] {
  let cursor = index;

  while (source[cursor] === ' ') cursor += 1;

  if (source[cursor] === '{') {
    let depth = 0;

    for (let end = cursor; end < source.length; end += 1) {
      if (source[end] === '{') depth += 1;
      else if (source[end] === '}') {
        depth -= 1;

        if (depth === 0) return [source.slice(cursor + 1, end), end + 1];
      }
    }

    return [source.slice(cursor + 1), source.length];
  }

  if (source[cursor] === '\\') {
    const command = source.slice(cursor).match(/^\\([a-zA-Z]+|.)/);

    if (command) return [command[0], cursor + command[0].length];
  }

  return [source[cursor] ?? '', cursor + 1];
}

function scriptText(content: string, table: Record<string, string>, marker: string): string {
  const plain = convert(content);
  const chars = Array.from(plain);

  if (chars.length > 0 && chars.every((char) => table[char] !== undefined)) {
    return chars.map((char) => table[char]).join('');
  }

  return chars.length === 1 ? `${marker}${plain}` : `${marker}(${plain})`;
}

function wrapOperand(text: string): string {
  return SIMPLE_OPERAND_RE.test(text) ? text : `(${text})`;
}

/** The recursive core — no no-break spaces, no outer trimming. */
function convert(source: string): string {
  let out = '';
  let index = 0;

  while (index < source.length) {
    const char = source[index] ?? '';

    if (char === '\\') {
      const match = source.slice(index).match(/^\\([a-zA-Z]+|.)/);
      const name = match?.[1] ?? '';

      index += match ? match[0].length : 1;

      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        const [numerator, afterNumerator] = readArgument(source, index);
        const [denominator, afterDenominator] = readArgument(source, afterNumerator);

        index = afterDenominator;
        out += `${wrapOperand(convert(numerator))}/${wrapOperand(convert(denominator))}`;
        continue;
      }

      if (name === 'sqrt') {
        let degree = '';

        if (source[index] === '[') {
          const close = source.indexOf(']', index);

          if (close > index) {
            degree = convert(source.slice(index + 1, close));
            index = close + 1;
          }
        }

        const [radicand, next] = readArgument(source, index);

        index = next;

        const root = degree === '3' ? '∛' : degree === '4' ? '∜' : degree ? `${scriptText(degree, SUPERSCRIPT, '^')}√` : '√';

        out += `${root}${wrapOperand(convert(radicand))}`;
        continue;
      }

      if (
        ['text', 'textbf', 'textit', 'mathrm', 'mathbf', 'mathit', 'mathsf', 'operatorname', 'boldsymbol', 'bm', 'mbox', 'vec', 'overline', 'underline', 'hat', 'bar', 'widehat', 'overrightarrow'].includes(
          name,
        )
      ) {
        const [content, next] = readArgument(source, index);

        index = next;

        const converted = name.startsWith('text') || name === 'mbox' ? content : convert(content);

        out += name === 'vec' || name === 'overrightarrow' ? `${converted}⃗` : name === 'overline' || name === 'bar' ? `${converted}̅` : converted;
        continue;
      }

      if (name === 'left' || name === 'right' || name === 'big' || name === 'Big' || name === 'bigg' || name === 'displaystyle' || name === 'limits') {
        continue;
      }

      if (name === 'begin' || name === 'end') {
        const [, next] = readArgument(source, index);

        index = next;
        out += name === 'end' ? ' ' : '';
        continue;
      }

      out += SYMBOLS[name] ?? name;
      continue;
    }

    if (char === '^' || char === '_') {
      const [content, next] = readArgument(source, index + 1);

      index = next;

      // `^\circ` / `^{\circ}` is a degree sign, not a superscript ring.
      if (/^\\circ$/.test(content.trim())) {
        out += '°';
        continue;
      }

      out += char === '^' ? scriptText(content, SUPERSCRIPT, '^') : scriptText(content, SUBSCRIPT, '_');
      continue;
    }

    if (char === '{' || char === '}') {
      index += 1;
      continue;
    }

    if (char === '&') {
      out += ' ';
      index += 1;
      continue;
    }

    if (char === '~') {
      out += ' ';
      index += 1;
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

/** One formula → plain text, kept on one line (see the header). */
export function latexToText(tex: string, { isolate = true } = {}): string {
  const text = convert(tex ?? '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();

  if (!text) return '';

  return isolate ? text.replace(/ /g, NBSP) : text;
}

/**
 * A sentence with `$…$` / `\(…\)` (and stray `$$…$$`) math → plain text. Escaped `\$` stays a dollar.
 * Used for Textbox content, table cells and clipboard-free previews.
 */
export function inlineMathToText(text: string): string {
  if (!text) return '';

  return text
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex: string) => latexToText(tex))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex: string) => latexToText(tex))
    .replace(/(^|[^\\])\$([^$\n]+?)\$/g, (_, lead: string, tex: string) => `${lead}${latexToText(tex)}`)
    .replace(/\\\$/g, '$');
}

/** Splits a sentence into text and inline-math runs — the panel renders the math runs with KaTeX. */
export function splitInlineMath(text: string): Array<{ kind: 'text' | 'math'; value: string }> {
  const parts: Array<{ kind: 'text' | 'math'; value: string }> = [];
  const re = /\$\$([\s\S]+?)\$\$|\\\(([\s\S]+?)\\\)|(?<!\\)\$([^$\n]+?)\$/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push({ kind: 'text', value: text.slice(last, match.index) });
    parts.push({ kind: 'math', value: (match[1] ?? match[2] ?? match[3] ?? '').trim() });
    last = match.index + match[0].length;
  }

  if (last < text.length) parts.push({ kind: 'text', value: text.slice(last) });

  return parts;
}
