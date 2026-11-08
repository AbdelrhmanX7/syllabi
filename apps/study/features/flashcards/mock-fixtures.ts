// Demo flashcard decks for the mock seed. Everything here is invented study content (no real course
// material); the subject is picked from the demo class's code / name. Must not import the seed.
import type { Question } from '@/lib/api/types';

type Subject = 'programming' | 'geology' | 'calculus';
type Card = [topic: string, front: string, back: string];

const DAY = 86_400_000;

const CARDS: Record<Subject, Card[]> = {
  programming: [
    ['Basics', 'What does a compiler do?', 'Translates source code into machine code (or another lower-level form) before the program runs.'],
    ['Basics', 'Variable vs constant', 'A variable can be reassigned; a constant keeps the value it was given.'],
    ['Loops', 'When does a `while` loop check its condition?', 'Before every pass, so the body may run zero times.'],
    ['Loops', 'What is an off-by-one error?', 'A loop that runs one time too many or too few, usually from `<` vs `<=`.'],
    ['Functions', 'Parameter vs argument', 'The parameter is the name in the definition; the argument is the value passed in the call.'],
    ['Functions', 'What is recursion?', 'A function that calls itself on a smaller input until it reaches a base case.'],
    ['Classes', 'What is a constructor?', 'A special member function that sets up a new object when it is created.'],
    ['Classes', 'What does encapsulation hide?', 'An object\'s data, behind public functions that control access to it.'],
  ],
  geology: [
    ['Minerals', 'Mohs hardness of quartz', '7 — it scratches glass.'],
    ['Minerals', 'Cleavage vs fracture', 'Cleavage breaks along flat planes of weak bonds; fracture breaks unevenly.'],
    ['Rocks', 'How does an igneous rock form?', 'Magma or lava cools and crystallises.'],
    ['Rocks', 'What turns a rock metamorphic?', 'Heat and pressure change its minerals and texture without melting it.'],
    ['Plate tectonics', 'Divergent boundary', 'Plates move apart; magma rises and makes new crust (mid-ocean ridges).'],
    ['Plate tectonics', 'Subduction', 'A denser oceanic plate sinks beneath another plate into the mantle.'],
    ['Earth layers', 'Which layer is liquid?', 'The outer core — molten iron and nickel.'],
    ['Earth layers', 'Lithosphere', 'The rigid outer shell: the crust plus the uppermost mantle.'],
  ],
  calculus: [
    ['Limits', 'When does a limit exist at x = a?', 'When the left- and right-hand limits both exist and are equal.'],
    ['Limits', '$\\lim_{x\\to 0} \\frac{\\sin x}{x}$', '$1$'],
    ['Derivatives', 'Power rule', '$\\frac{d}{dx} x^n = n x^{n-1}$'],
    ['Derivatives', 'Derivative of $e^x$', '$e^x$'],
    ['Derivatives', 'Chain rule', '$\\frac{d}{dx} f(g(x)) = f\'(g(x))\\,g\'(x)$'],
    ['Derivatives', 'What does $f\'(a)$ mean geometrically?', 'The slope of the tangent line to $y = f(x)$ at $x = a$.'],
    ['Integrals', '$\\int x^n\\,dx$ for $n \\ne -1$', '$\\frac{x^{n+1}}{n+1} + C$'],
    ['Integrals', 'Fundamental theorem (part 2)', '$\\int_a^b f(x)\\,dx = F(b) - F(a)$ where $F\' = f$.'],
  ],
};

/** The demo subject of a class, or null when none fits. */
export function flashcardSubject(cls: { code?: string | null; name?: string | null }): Subject | null {
  const text = `${cls.code ?? ''} ${cls.name ?? ''}`;

  if (/\b(CS|CIS|CSE)\b|program|software|c\+\+|java|python/i.test(text)) return 'programming';
  if (/\bMATH\b|calculus/i.test(text)) return 'calculus';
  if (/\b(GEOL|EAS)\b|geolog|earth/i.test(text)) return 'geology';

  return null;
}

/**
 * ~8 cards per demo class (the first class of each subject), with a mix of overdue, new and
 * scheduled-later cards so due counts show something.
 */
export function demoFlashcards(classes: { id: string; code?: string | null; name?: string | null }[]): Question[] {
  const used = new Set<Subject>();
  const out: Question[] = [];
  const iso = (offset: number) => new Date(Date.now() + offset).toISOString();

  for (const cls of classes) {
    const subject = flashcardSubject(cls);

    if (!subject || used.has(subject)) continue;
    used.add(subject);
    CARDS[subject].forEach(([topic, stem, answer], index) => {
      // 0–2 reviewed and due, 3–4 new, 5–7 reviewed and due later.
      const reps = index <= 2 || index >= 5 ? 1 + (index % 3) : 0;
      const dueAt = index <= 2 ? iso(-(index + 1) * DAY) : index >= 5 ? iso((index - 3) * DAY) : iso(0);

      out.push({
        id: `fc_demo_${subject}_${index + 1}`,
        classId: cls.id,
        topic,
        subtopic: null,
        difficulty: 2,
        source: { kind: 'manual', itemId: null, pageId: null, lectureId: null, ref: null },
        type: 'free',
        stem,
        imageUrl: null,
        answer,
        solutionSteps: [],
        tags: ['flashcard'],
        stats: { attempts: reps, correct: reps ? reps - 1 : 0, lastResult: reps ? 'right' : null, mastery: reps ? 0.4 : 0 },
        srs: { dueAt, stability: reps ? reps * 1.5 : 0, difficulty: 5, reps, lapses: 0 },
        createdAt: iso(-(14 - index) * DAY),
      });
    });
  }

  return out;
}
