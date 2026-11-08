// Class guide, exam schedule and real exam results (BE P-CM #575, base /study).

/** `GET/PUT /classes/:id/guide` — applied as system context to every AI call of the class. */
export interface ClassGuide {
  markdown: string;
  updatedAt: string | null;
}

/** `GET/PUT /classes/:id/exams-schedule` row. `date` is `YYYY-MM-DD`; null → derived from `week`. */
export interface ExamScheduleEntry {
  name: string;
  week: number | null;
  date: string | null;
  chapters: string[];
  topics: string[];
}

export interface ExamResultSection {
  name: string;
  score: number;
  max: number;
}

/** `GET/POST /classes/:id/exam-results`, `PATCH …/:resultId`. Listed oldest first. */
export interface ExamResultRow {
  id: string;
  name: string;
  date: string | null;
  score: number;
  maxScore: number;
  /** One decimal; null when maxScore is 0. */
  percent?: number | null;
  chapters: string[];
  sections?: ExamResultSection[];
  notes?: string | null;
}

export interface ExamResultInput {
  name: string;
  date?: string | null;
  score: number;
  maxScore: number;
  chapters?: string[];
  sections?: ExamResultSection[];
  notes?: string | null;
}

/** Question types a blueprint section can ask for (`any` = whatever fits). */
export type BlueprintSectionType =
  | 'free'
  | 'mcq'
  | 'code_output'
  | 'code_write'
  | 'label_image'
  | 'matching'
  | 'fill_blank'
  | 'any';

export interface BlueprintSection {
  section: string;
  type: BlueprintSectionType;
  count: number;
  points?: number;
  bonus?: boolean;
  /** Bank only — never generated; skipped when the bank has none. */
  optional?: boolean;
  preferImage?: boolean;
  from?: 'concept_map' | null;
}

export interface ExamBlueprint {
  minutes: number | null;
  sections: BlueprintSection[];
}

/** `GET/PUT /classes/:id/exam-blueprint`. `source` = the owner's stored one, the course default, or none. */
export interface ExamBlueprintState {
  blueprint: ExamBlueprint | null;
  source: 'stored' | 'default' | null;
}
