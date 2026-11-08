/**
 * Tiny tokenizer for the code the bank shows (C++ first — the OOP class — plus enough for
 * pseudo-code and shell). No highlighter ships in node_modules, and the stems are short, so a
 * single-pass regex tokenizer is the whole dependency.
 */

export type TokenKind = 'kw' | 'type' | 'str' | 'num' | 'cmt' | 'pre' | 'fn' | 'op' | 'plain';

export interface CodeToken {
  kind: TokenKind;
  text: string;
}

const KEYWORDS = new Set(
  (
    'alignas alignof asm auto break case catch class concept const consteval constexpr constinit const_cast continue ' +
    'co_await co_return co_yield decltype default delete do dynamic_cast else enum explicit export extern false for ' +
    'friend goto if inline mutable namespace new noexcept nullptr operator override final private protected public ' +
    'register reinterpret_cast requires return sizeof static static_assert static_cast struct switch template this ' +
    'thread_local throw true try typedef typeid typename union using virtual volatile while ' +
    'def elif except finally from global import in is lambda not or pass raise with yield None True False ' +
    'function let var of instanceof typeof'
  ).split(' '),
);

const TYPES = new Set(
  (
    'bool char char8_t char16_t char32_t double float int long short signed unsigned void wchar_t size_t string ' +
    'vector map set unordered_map unordered_set array list deque stack queue pair tuple shared_ptr unique_ptr ' +
    'ostream istream iostream std cout cin endl'
  ).split(' '),
);

const TOKEN_RE =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[uUlLfF]*\b)|([A-Za-z_]\w*)(?=\s*\()|([A-Za-z_]\w*)|([{}()[\];,.<>=!+\-*/%&|^~?:]+)|(\s+)|(.)/g;

export function tokenizeCode(source: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let match: RegExpExecArray | null;

  TOKEN_RE.lastIndex = 0;

  while ((match = TOKEN_RE.exec(source)) !== null) {
    const [text, comment, str, num, fn, ident, op] = match;

    if (comment !== undefined) tokens.push({ kind: comment.startsWith('#') ? 'pre' : 'cmt', text });
    else if (str !== undefined) tokens.push({ kind: 'str', text });
    else if (num !== undefined) tokens.push({ kind: 'num', text });
    else if (fn !== undefined) tokens.push({ kind: KEYWORDS.has(fn) ? 'kw' : TYPES.has(fn) ? 'type' : 'fn', text });
    else if (ident !== undefined)
      tokens.push({ kind: KEYWORDS.has(ident) ? 'kw' : TYPES.has(ident) ? 'type' : 'plain', text });
    else if (op !== undefined) tokens.push({ kind: 'op', text });
    else tokens.push({ kind: 'plain', text });
  }

  return tokens;
}

export const TOKEN_CLASS: Record<TokenKind, string> = {
  kw: 'text-violet-700 dark:text-violet-300',
  type: 'text-sky-700 dark:text-sky-300',
  str: 'text-emerald-700 dark:text-emerald-300',
  num: 'text-amber-700 dark:text-amber-300',
  cmt: 'text-zinc-500 italic',
  pre: 'text-rose-700 dark:text-rose-300',
  fn: 'text-blue-700 dark:text-blue-300',
  op: 'text-zinc-600 dark:text-zinc-400',
  plain: '',
};
