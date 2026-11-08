/**
 * FSRS-5 scheduler (pure). `ts-fsrs` is not installed and no dependency was added; this is the
 * published FSRS-5 algorithm with its default 19 weights (open-spaced-repetition/fsrs4anki
 * wiki, "The Algorithm" — FSRS-5), desired retention 0.9.
 *
 *   R(t,S)  = (1 + F·t/S)^C,  C = −0.5, F = 19/81        (so R(S,S) = 0.9 → interval = S)
 *   S0(G)   = w[G−1]
 *   D0(G)   = w4 − e^{w5(G−1)} + 1
 *   D'      = w7·D0(4) + (1−w7)·(D + ΔD·(10−D)/9),  ΔD = −w6(G−3)
 *   S'r     = S·(e^{w8}(11−D)S^{−w9}(e^{w10(1−R)}−1)·[w15 if Hard]·[w16 if Easy] + 1)
 *   S'f     = min(S, w11·D^{−w12}((S+1)^{w13}−1)e^{w14(1−R)})
 *   same-day S' = S·e^{w17(G−3+w18)}
 */
export type Rating = 1 | 2 | 3 | 4; // Again, Hard, Good, Easy
export const Rating = { Again: 1, Hard: 2, Good: 3, Easy: 4 } as const;

export const FSRS5_WEIGHTS = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315,
  2.9898, 0.51655, 0.6621,
] as const;

const DECAY = -0.5;
const FACTOR = 19 / 81;
export const DESIRED_RETENTION = 0.9;
export const MAX_INTERVAL_DAYS = 36500;
const DAY_MS = 86400_000;

export interface SrsState {
  dueAt: Date;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  lastReviewAt: Date | null;
}

const w = FSRS5_WEIGHTS;
const clampD = (d: number) => Math.min(10, Math.max(1, d));
const initStability = (g: Rating) => Math.max(0.1, w[g - 1]);
const initDifficulty = (g: Rating) => w[4] - Math.exp(w[5] * (g - 1)) + 1;

export const retrievability = (elapsedDays: number, stability: number) =>
  stability > 0 ? Math.pow(1 + (FACTOR * Math.max(0, elapsedDays)) / stability, DECAY) : 0;

export const nextIntervalDays = (stability: number, retention = DESIRED_RETENTION) => {
  const raw = (stability / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
  return Math.min(MAX_INTERVAL_DAYS, Math.max(1, Math.round(raw)));
};

function nextDifficulty(d: number, g: Rating) {
  const delta = -w[6] * (g - 3);
  const damped = d + (delta * (10 - d)) / 9;
  return clampD(w[7] * initDifficulty(4) + (1 - w[7]) * damped);
}

function recallStability(d: number, s: number, r: number, g: Rating) {
  const hard = g === 2 ? w[15] : 1;
  const easy = g === 4 ? w[16] : 1;
  return s * (Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp(w[10] * (1 - r)) - 1) * hard * easy + 1);
}

function forgetStability(d: number, s: number, r: number) {
  const sf = w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp(w[14] * (1 - r));
  return Math.min(s, sf);
}

/** A never-reviewed card: due immediately, reps 0. */
export const newSrs = (now = new Date()): SrsState => ({ dueAt: now, stability: 0, difficulty: 0, reps: 0, lapses: 0, lastReviewAt: null });

/** Schedule one review. Pure: same inputs → same output. */
export function schedule(prev: SrsState, g: Rating, now = new Date()): SrsState {
  let stability: number;
  let difficulty: number;
  let lapses = prev.lapses;
  if (prev.reps === 0 || !prev.lastReviewAt || prev.stability <= 0) {
    stability = initStability(g);
    difficulty = clampD(initDifficulty(g));
  } else {
    const elapsed = (now.getTime() - new Date(prev.lastReviewAt).getTime()) / DAY_MS;
    difficulty = nextDifficulty(prev.difficulty, g);
    if (elapsed < 1) {
      stability = prev.stability * Math.exp(w[17] * (g - 3 + w[18]));
    } else {
      const r = retrievability(elapsed, prev.stability);
      stability = g === 1 ? forgetStability(prev.difficulty, prev.stability, r) : recallStability(prev.difficulty, prev.stability, r, g);
    }
    if (g === 1) lapses += 1;
  }
  stability = Math.max(0.1, Number(stability.toFixed(4)));
  // Again = a reset: back tomorrow regardless of the (already shrunken) stability.
  const days = g === 1 ? 1 : nextIntervalDays(stability);
  return {
    dueAt: new Date(now.getTime() + days * DAY_MS),
    stability,
    difficulty: Number(difficulty.toFixed(4)),
    reps: prev.reps + 1,
    lapses,
    lastReviewAt: now,
  };
}
