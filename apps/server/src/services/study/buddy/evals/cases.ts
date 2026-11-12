import type { BoardCluster, BoardReply } from "../../board-actions";

/**
 * The buddy's answer-quality checks. A case = a sample page (typed lines = the printed question,
 * `hand` lines = the student's writing), what the student asks (a button's expert, or free words for
 * the picker), and plain yes/no checks on the answer. Run: `node dist/services/study/buddy/evals/run.js`
 * (see run.ts). Add a case whenever a real answer was bad — the turn log has the page and the question.
 */
export interface EvalLine {
  text: string;
  /** The student's handwriting (drawn in a script face, blue) rather than print. */
  hand?: boolean;
}
export type EvalReply = Omit<BoardReply, "remember"> & { skill: string };
export interface EvalCheck {
  name: string;
  pass: (reply: EvalReply) => boolean;
}
export interface EvalCase {
  id: string;
  lines: EvalLine[];
  /** The expert the student tapped; absent = the picker chooses from `question`. */
  skill?: string;
  question: string;
  memory?: string[];
  checks: EvalCheck[];
}

const text = (r: EvalReply) => [r.say ?? "", ...(r.steps ?? [])].join(" ");
const flat = (s: string) => s.replace(/[\s$\\{}()*·]/g, "").toLowerCase();
const noExtras = (keep: "steps" | "quiz" | "similar" | null): EvalCheck => ({
  name: "only its own part",
  pass: (r) => (keep === "steps" || !r.steps) && (keep === "quiz" || !r.quiz) && (keep === "similar" || !r.similar),
});
const skillIs = (id: string): EvalCheck => ({ name: `picked ${id}`, pass: (r) => r.skill === id });
const says: EvalCheck = { name: "says something", pass: (r) => (r.say ?? "").length > 10 };

const LINEAR: EvalLine[] = [{ text: "1. Solve for x: 3x − 7 = 2x + 5." }];
const LINEAR_RIGHT: EvalLine[] = [...LINEAR, { text: "3x − 2x = 5 + 7", hand: true }, { text: "x = 12", hand: true }];
const LINEAR_WRONG: EvalLine[] = [...LINEAR, { text: "3x − 2x = 5 − 7", hand: true }, { text: "x = −2", hand: true }];
const PRODUCT: EvalLine[] = [{ text: "2. Find dy/dx for y = x² · sin(3x)." }];
const CHAIN_WRONG: EvalLine[] = [{ text: "3. Differentiate y = (2x + 1)³." }, { text: "dy/dx = 3(2x + 1)²", hand: true }];

export const BUDDY_EVAL_CASES: EvalCase[] = [
  {
    id: "check-right",
    lines: LINEAR_RIGHT,
    skill: "check",
    question: "Check my work on this page. Is it right? If not, show me exactly where it goes wrong and how to fix it.",
    checks: [{ name: "verdict correct", pass: (r) => r.verdict === "correct" }, { name: "no wrong marks", pass: (r) => !r.actions.some((a) => a.type === "mark" && a.verdict === "wrong") }, says, noExtras(null)],
  },
  {
    id: "check-sign-slip",
    lines: LINEAR_WRONG,
    skill: "check",
    question: "Check my work on this page. Is it right? If not, show me exactly where it goes wrong and how to fix it.",
    checks: [
      { name: "verdict not correct", pass: (r) => r.verdict === "wrong" || r.verdict === "partly" },
      { name: "marks the first wrong line", pass: (r) => r.actions.some((a) => a.type === "mark" && a.verdict === "wrong" && "clusterId" in a.target && a.target.clusterId === "c2") },
      { name: "names the fix", pass: (r) => /\+\s*7|12|sign/i.test(JSON.stringify(r)) },
      noExtras(null),
    ],
  },
  {
    id: "check-chain-rule",
    lines: CHAIN_WRONG,
    skill: "check",
    question: "Check my work on this page. Is it right? If not, show me exactly where it goes wrong and how to fix it.",
    checks: [{ name: "verdict not correct", pass: (r) => r.verdict === "wrong" || r.verdict === "partly" }, { name: "names the missing factor", pass: (r) => /6\s*\(|chain|inner|\b2\b/i.test(JSON.stringify(r)) }],
  },
  {
    id: "hint-no-answer",
    lines: LINEAR,
    skill: "hint",
    question: "Give me a hint for the next step only. Do not give the full answer or solve it for me.",
    checks: [says, { name: "does not give the answer", pass: (r) => !/x=12|=12\b/.test(flat(text(r))) }, { name: "no verdict", pass: (r) => !r.verdict }, noExtras(null)],
  },
  {
    id: "explain",
    lines: PRODUCT,
    skill: "explain",
    question: "Explain what matters on this page in simple words, and point at the key parts.",
    checks: [says, { name: "names the rule", pass: (r) => /product/i.test(text(r)) }, { name: "no verdict", pass: (r) => !r.verdict }, noExtras(null)],
  },
  {
    id: "solve-linear",
    lines: LINEAR,
    skill: "solve",
    question: "Solve this question for me step by step. Show every step in order and end with the final answer.",
    checks: [{ name: "3+ steps", pass: (r) => (r.steps?.length ?? 0) >= 3 }, { name: "ends with x = 12", pass: (r) => /x=12/.test(flat(r.steps?.[r.steps.length - 1] ?? "")) }, noExtras("steps")],
  },
  {
    id: "solve-product-rule",
    lines: PRODUCT,
    skill: "solve",
    question: "Solve this question for me step by step. Show every step in order and end with the final answer.",
    checks: [
      { name: "3+ steps", pass: (r) => (r.steps?.length ?? 0) >= 3 },
      { name: "right derivative", pass: (r) => /2xsin3x\+3x\^?2cos3x|3x\^?2cos3x\+2xsin3x/.test(flat(r.steps?.[r.steps.length - 1] ?? "")) },
      noExtras("steps"),
    ],
  },
  {
    id: "similar-question",
    lines: PRODUCT,
    skill: "similar",
    question: "Make me a similar question to practise.",
    checks: [
      { name: "has a question", pass: (r) => (r.similar?.markdown.length ?? 0) > 20 },
      { name: "maths is typeset", pass: (r) => /\$[^$]+\$/.test(r.similar?.markdown ?? "") },
      { name: "not the same question", pass: (r) => !/x\^?\{?2\}?\\?(cdot|·)?\\?sin\(?3x/.test(flat(r.similar?.markdown ?? "")) },
      { name: "no answer given away", pass: (r) => !/answer|solution|=\s*2x/i.test(r.similar?.markdown ?? "") },
      noExtras("similar"),
    ],
  },
  {
    id: "quick-check",
    lines: PRODUCT,
    skill: "quiz",
    question: "Ask me one quick multiple-choice question to check I understand this.",
    checks: [
      { name: "4 choices", pass: (r) => r.quiz?.choices.length === 4 },
      { name: "an answer and a reason", pass: (r) => !!r.quiz && r.quiz.answer >= 0 && r.quiz.answer < r.quiz.choices.length && r.quiz.why.length > 10 },
      { name: "no marks on the page", pass: (r) => r.actions.length === 0 },
      noExtras("quiz"),
    ],
  },
  { id: "pick-check", lines: LINEAR_RIGHT, question: "did i do this right?", checks: [skillIs("check")] },
  { id: "pick-hint", lines: LINEAR, question: "im stuck, what do i do next", checks: [skillIs("hint")] },
  { id: "pick-explain", lines: PRODUCT, question: "why do we use the product rule here", checks: [skillIs("explain")] },
  { id: "pick-solve", lines: LINEAR, question: "work this out for me please", checks: [skillIs("solve")] },
  { id: "pick-similar", lines: PRODUCT, question: "give me another one like this to practice", checks: [skillIs("similar")] },
  { id: "pick-quiz", lines: PRODUCT, question: "test me on this", checks: [skillIs("quiz")] },
  {
    id: "memory-is-used",
    lines: CHAIN_WRONG,
    skill: "check",
    question: "Check my work on this page. Is it right? If not, show me exactly where it goes wrong and how to fix it.",
    memory: ["Often forgets to multiply by the derivative of the inside when using the chain rule."],
    checks: [{ name: "verdict not correct", pass: (r) => r.verdict === "wrong" || r.verdict === "partly" }, { name: "links it to the habit", pass: (r) => /again|before|keep|habit|same|usual|remember/i.test(r.say ?? "") }],
  },
];

/** The page as an image description: an SVG and the regions (one per line) the model can name. */
export function renderCase(lines: EvalLine[]): { svg: string; clusters: BoardCluster[] } {
  const W = 1000;
  const H = 1300;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  let y = 130;
  let hands = 0;
  let prints = 0;
  const parts: string[] = [];
  const clusters: BoardCluster[] = [];
  for (const line of lines) {
    const size = line.hand ? 40 : 30;
    const x = line.hand ? 140 : 80;
    const width = Math.min(W - x - 40, line.text.length * size * 0.56);
    parts.push(
      line.hand
        ? `<text x="${x}" y="${y}" font-family="Comic Sans MS, Purisa, cursive" font-style="italic" font-size="${size}" fill="#1d3fb8">${esc(line.text)}</text>`
        : `<text x="${x}" y="${y}" font-family="DejaVu Serif, serif" font-size="${size}" fill="#111">${esc(line.text)}</text>`
    );
    clusters.push({ id: line.hand ? `c${++hands}` : `p${++prints}`, box: { x: (x - 8) / W, y: (y - size) / H, w: (width + 16) / W, h: (size * 1.4) / H } });
    y += line.hand ? 90 : 110;
  }
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#fff"/>${parts.join("")}</svg>`, clusters };
}
