/**
 * The study buddy's experts. The buddy is not one model doing whatever it likes: every turn ONE
 * expert answers, and an expert is only this file's entry — a job written in plain rules, what it
 * may read (memory, the class's weak topics) and what it hands back. To change how the buddy
 * behaves, change the expert's `job`; to teach it something new, add an entry. evals/buddy checks
 * each of them against sample pages.
 */
export interface BuddyExpert {
  id: string;
  /** Shown to the student: «Solve expert». */
  name: string;
  /** For the picker: when this expert is the right one. */
  when: string;
  /** The rules of this turn, appended to the shared page-marking rules. */
  job: string[];
  /** Reads the class's weakest topics (services/study/concepts). */
  weakTopics?: boolean;
  /** The extra part of the reply this expert must fill. */
  gives?: "steps" | "quiz" | "similar";
}

const MATHS = "Write maths as LaTeX between dollar signs ($\\frac{dy}{dx}$, $x^2$, $\\int_0^1 x\\,dx$); never plain-text maths in this field.";

export const BUDDY_EXPERTS: readonly BuddyExpert[] = [
  {
    id: "check",
    name: "Checker",
    when: "The student wants their own work or answer checked, asks «is this right?», or asks where they went wrong.",
    job: [
      "Check the student's own work. Solve it yourself first, compare line by line, find the FIRST place it goes wrong.",
      "Always give `verdict` when there is work of theirs to check. Do not return `steps`, `quiz` or `similar`.",
    ],
  },
  {
    id: "hint",
    name: "Hint giver",
    when: "The student is stuck and wants a nudge or the next step, not the answer.",
    job: [
      "Give ONE hint for the next step only. Never state the final answer, never solve it, never list more than one step.",
      "Point at the place on the page the hint is about (one circle or underline). `say` = the hint, 1–2 sentences, ending with a question that makes them think.",
      "Do not return `verdict`, `steps`, `quiz` or `similar`.",
    ],
  },
  {
    id: "explain",
    name: "Explainer",
    when: "The student asks what something means, why something is true, or wants the page or a part of it explained.",
    job: [
      "Explain the idea in simple words, as to a friend. Point at the key parts of the page (2–4 marks).",
      "`say` = the explanation in 2–3 short sentences; one concrete example if it helps. Do not return `verdict`, `steps`, `quiz` or `similar`.",
    ],
  },
  {
    id: "solve",
    name: "Solver",
    when: "The student asks for the question to be solved, worked out, or shown step by step.",
    gives: "steps",
    job: [
      "Solve the question and return `steps` (the whole worked solution, 3–12 steps, last one = the final answer), as the shared rules describe.",
      "If the page has several questions, solve the one they wrote about or point at, else the first unsolved one, and name it in `say` (one sentence). At most one circle on the page. Do not return `quiz` or `similar`.",
    ],
  },
  {
    id: "similar",
    name: "Question maker",
    when: "The student wants another question like this one to practise, a similar problem, or more practice.",
    gives: "similar",
    weakTopics: true,
    job: [
      'Write ONE new practice question of the same kind and difficulty as the question on the page (the one they wrote about, else the first one): same skill, different numbers / functions / wording, so the answer is NOT the same. It must be solvable and complete on its own.',
      'Return it as "similar": {"title":"3–6 words naming the skill","markdown":"the question text"}. ' + MATHS,
      "Do NOT include the solution, the answer, or a hint in `markdown`. Multi-part questions use (a), (b) on their own lines.",
      "`say` = one sentence telling them what the new question practises. At most one circle on the source question. Do not return `verdict`, `steps` or `quiz`.",
    ],
  },
  {
    id: "quiz",
    name: "Quick check",
    when: "The student wants to be tested or quizzed, or asks «do I understand this?».",
    gives: "quiz",
    weakTopics: true,
    job: [
      "Write ONE multiple-choice question that tests whether the student understands the IDEA behind the page (not a copy of the question on it, and not a trick). It must be answerable in under a minute without paper.",
      'Return it as "quiz": {"question":"…","choices":["…","…","…","…"],"answer":<index of the right choice, 0-based>,"why":"1–2 sentences: why that one is right and what the most tempting wrong one gets wrong","topic":"2–4 words"}. ' + MATHS,
      "Exactly 4 choices, exactly one right. The wrong ones are the mistakes students really make (a dropped sign, the wrong rule), similar in length to the right one. Put the right answer at a random position.",
      "`say` = one short inviting sentence (\"Quick one to check the idea:\"). No marks on the page (`actions`: []). Do not return `verdict`, `steps` or `similar`.",
    ],
  },
];

export const expertById = (id: string | undefined | null): BuddyExpert | null => BUDDY_EXPERTS.find((e) => e.id === id) ?? null;
/** The expert used when nothing was picked (a free question the picker could not place). */
export const DEFAULT_EXPERT = BUDDY_EXPERTS[0]!;

/**
 * This turn's brief: the expert's job, then what the buddy remembers about the student and what the
 * class's knowledge map says — each only when there is something to say.
 */
export function buildBrief(expert: BuddyExpert, ctx: { memory: string[]; weakTopics: string[] }): string {
  return [
    `THIS TURN YOU ARE THE ${expert.name.toUpperCase()}. Your job (it overrides anything above that conflicts with it):`,
    ...expert.job.map((line) => `- ${line}`),
    ...(ctx.memory.length
      ? ["", "WHAT YOU REMEMBER ABOUT THIS STUDENT (from earlier turns; use it quietly, never quote it back as a list):", ...ctx.memory.map((line) => `- ${line}`)]
      : []),
    ...(ctx.weakTopics.length ? ["", `THE STUDENT'S WEAKEST TOPICS IN THIS CLASS (lean towards these when it fits the page): ${ctx.weakTopics.join("; ")}`] : []),
    "",
    'MEMORY: if this turn shows something lasting about the student that would help next time (a mistake they keep making, a method they prefer, something they have clearly mastered), add "remember": ["one short sentence"] — at most one, about the STUDENT, not about this page. Usually leave it out.',
  ].join("\n");
}

export const PICKER_SYSTEM = [
  "You route a student's request to ONE expert of a study helper. Read the request and pick the expert whose description fits best.",
  'Reply with ONE JSON object: {"skill":"<id>","heard":"<the request as plain text, at most 200 characters>"}. Nothing else.',
].join("\n");

export function pickerTurn(question: string | null): string {
  return [
    "EXPERTS:",
    ...BUDDY_EXPERTS.map((e) => `- ${e.id}: ${e.when}`),
    "",
    question ? `The student's request: ${question}` : "The student's request is handwritten in the image. Read it.",
  ].join("\n");
}
