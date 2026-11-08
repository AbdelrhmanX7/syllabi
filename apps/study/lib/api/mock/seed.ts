// The mock's data: a small built-in demo seed that keeps every screen renderable without a server.
import type { Item, MasteryTopic, ModuleNode, Question, StudyClass, Today, Transcript } from '../types';

import { demoFlashcards } from '@/features/flashcards/mock-fixtures';

export interface MockSeed {
  classes: StudyClass[];
  modulesByClass: Record<string, ModuleNode[]>;
  items: Item[];
  today: Today | null;
  questions: Question[];
  masteryByClass: Record<string, { topics: MasteryTopic[] }>;
  transcriptsByItem: Record<string, Transcript>;
}

const DAY = 86_400_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

function builtinSeed(): MockSeed {
  const classes: StudyClass[] = [
    {
      id: 'cls_demo_cs',
      canvasCourseId: 1,
      name: 'Intro to Programming (C++)',
      code: 'CS 101',
      term: 'Fall 2026',
      color: '#C05621',
      grade: { score: 96.4, letter: 'A', trend: 1 },
      counts: { due: 1, overdue: 0, unseen: 2 },
    },
    {
      id: 'cls_demo_earth',
      canvasCourseId: 2,
      name: 'Earth Science',
      code: 'EAS 101',
      term: 'Fall 2026',
      color: '#2B6CB0',
      grade: { score: 88.0, letter: 'B+', trend: -1 },
      counts: { due: 1, overdue: 1, unseen: 1 },
    },
    {
      id: 'cls_demo_lab',
      canvasCourseId: 4,
      name: 'Earth Science Lab',
      code: 'EAS 102',
      term: 'Fall 2026',
      color: '#2F855A',
      grade: { score: 95.5, letter: 'A', trend: 0 },
      counts: { due: 0, overdue: 0, unseen: 0 },
    },
    {
      id: 'cls_demo_math',
      canvasCourseId: 5,
      name: 'Calculus I',
      code: 'MATH 101',
      term: 'Fall 2026',
      color: '#4F6BED',
      grade: { score: 91.2, letter: 'A-', trend: 1 },
      counts: { due: 0, overdue: 0, unseen: 0 },
    },
  ];
  const items: Item[] = [
    {
      id: 'itm_demo_syllabus',
      classId: 'cls_demo_cs',
      moduleId: 'mod_demo_1',
      type: 'page',
      title: 'Syllabus & course outline',
      canvasUrl: 'https://canvas.example.edu/',
      updatedAt: iso(-20 * DAY),
      seenAt: iso(-19 * DAY),
      html: '<h2>Welcome</h2><p>This course covers classes, inheritance, polymorphism and templates in modern C++.</p>',
    },
    {
      id: 'itm_demo_pdf',
      classId: 'cls_demo_cs',
      moduleId: 'mod_demo_1',
      type: 'file',
      title: 'Lecture 3 — Constructors.pdf',
      canvasUrl: 'https://canvas.example.edu/',
      updatedAt: iso(-3 * DAY),
      seenAt: null,
      file: {
        mime: 'application/pdf',
        size: 12_340,
        version: 1,
        url: '/mock/sample.pdf',
        expiresAt: iso(6 * 3_600_000),
      },
    },
    {
      id: 'itm_demo_hw',
      classId: 'cls_demo_cs',
      moduleId: 'mod_demo_2',
      type: 'assignment',
      title: 'Lab 4: Bank account class',
      canvasUrl: 'https://canvas.example.edu/',
      updatedAt: iso(-2 * DAY),
      seenAt: null,
      dueAt: iso(2 * DAY),
      points: 20,
      submission: { state: 'unsubmitted', score: null },
      external: null,
      html: '<p>Implement <code>BankAccount</code> with deposit/withdraw and a copy constructor.</p>',
    },
    {
      id: 'itm_demo_video',
      classId: 'cls_demo_cs',
      moduleId: 'mod_demo_2',
      type: 'video',
      title: 'Lecture recording — Inheritance',
      canvasUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      updatedAt: iso(-1 * DAY),
      seenAt: null,
      video: { provider: 'youtube', videoId: 'dQw4w9WgXcQ', durationSec: 2_700, transcriptStatus: 'ready' },
    },
    {
      id: 'itm_demo_online_hw',
      classId: 'cls_demo_earth',
      moduleId: null,
      type: 'assignment',
      title: 'Online HW 5 — Plate boundaries',
      canvasUrl: 'https://canvas.example.edu/',
      updatedAt: iso(-5 * DAY),
      seenAt: iso(-4 * DAY),
      dueAt: iso(-1 * DAY),
      points: 10,
      submission: { state: 'missing', score: null },
      external: { tool: 'Online homework' },
    },
    {
      id: 'itm_demo_ann',
      classId: 'cls_demo_earth',
      moduleId: null,
      type: 'announcement',
      title: 'Field trip moved to Friday',
      canvasUrl: 'https://canvas.example.edu/',
      updatedAt: iso(-0.5 * DAY),
      seenAt: null,
      html: '<p>Meet at the parking lot at 8:00. Bring water.</p>',
    },
  ];
  const modulesByClass: Record<string, ModuleNode[]> = {
    cls_demo_cs: [
      { id: 'mod_demo_1', name: 'Module 1: Getting started', position: 1, items: items.slice(0, 2) },
      { id: 'mod_demo_2', name: 'Module 2: Classes', position: 2, items: items.slice(2, 4) },
    ],
    cls_demo_earth: [],
    cls_demo_lab: [],
    cls_demo_math: [],
  };
  const questions: Question[] = [
    {
      id: 'q_demo_1',
      classId: 'cls_demo_cs',
      topic: 'Constructors',
      subtopic: null,
      difficulty: 2,
      source: { kind: 'manual', itemId: null, pageId: null, lectureId: null, ref: null },
      type: 'free',
      stem: 'When is a copy constructor invoked implicitly? Give two cases.',
      imageUrl: null,
      answer: 'Passing an object by value; returning an object by value (pre-elision); initializing `T b = a;`.',
      solutionSteps: ['Think of every place a new object is created from an existing one.'],
      tags: ['copy'],
      stats: { attempts: 2, correct: 1, lastResult: 'partial', mastery: 0.5 },
      srs: { dueAt: iso(-1 * DAY), stability: 2, difficulty: 5, reps: 2, lapses: 0 },
      createdAt: iso(-10 * DAY),
    },
    {
      id: 'q_demo_2',
      classId: 'cls_demo_earth',
      topic: 'Plate tectonics',
      subtopic: null,
      difficulty: 1,
      source: { kind: 'manual', itemId: null, pageId: null, lectureId: null, ref: null },
      type: 'mcq',
      stem: 'Which boundary type produces new oceanic crust?',
      imageUrl: null,
      choices: ['Convergent', 'Divergent', 'Transform', 'Subduction'],
      answer: 'Divergent',
      solutionSteps: ['Plates pull apart → upwelling magma → new crust.'],
      tags: [],
      stats: { attempts: 0, correct: 0, lastResult: null, mastery: 0 },
      srs: { dueAt: iso(0), stability: 0, difficulty: 5, reps: 0, lapses: 0 },
      createdAt: iso(-3 * DAY),
    },
  ];

  return {
    classes,
    modulesByClass,
    items,
    today: {
      due: [items[2]],
      overdue: [items[4]],
      unseen: [items[1], items[3], items[5]],
      announcements: [items[5]],
      review: { dueCount: 1, newCount: 1 },
      weakTopics: [
        { classId: 'cls_demo_cs', topic: 'Constructors', mastery: 0.5 },
        { classId: 'cls_demo_earth', topic: 'Plate tectonics', mastery: 0.2 },
      ],
      classes,
    },
    questions: [...questions, ...demoFlashcards(classes)],
    masteryByClass: {
      cls_demo_cs: { topics: [{ topic: 'Constructors', mastery: 0.5, attempts: 2, dueCount: 1 }] },
      cls_demo_earth: { topics: [{ topic: 'Plate tectonics', mastery: 0.2, attempts: 0, dueCount: 1 }] },
    },
    transcriptsByItem: {
      itm_demo_video: {
        segments: [
          { start: 0, end: 7, text: 'Inheritance lets a derived class reuse and extend a base class.' },
          { start: 7, end: 15, text: 'Public inheritance models an is-a relationship.' },
          { start: 15, end: 24, text: 'Virtual functions give you runtime polymorphism through the base pointer.' },
        ],
        summary: 'Base/derived classes, access specifiers, virtual dispatch.',
        keyPoints: ['is-a vs has-a', 'virtual + override', 'destructors should be virtual in a polymorphic base'],
      },
    },
  };
}

/**
 * The demo seed. Dates are relative to now, so the demo never goes stale. (Captures from a real Canvas
 * account made with `fixtures/capture.mjs` stay local and are not loaded by the public build.)
 */
export async function loadMockSeed(): Promise<MockSeed> {
  return builtinSeed();
}

/** A demo class's code + name by its fixture id, synchronously (feature mocks pick per-subject data by it). */
export function seedClassById(id: string): Pick<StudyClass, 'code' | 'name'> | undefined {
  const cls = builtinSeed().classes.find((item) => item.id === id);

  return cls ? { code: cls.code, name: cls.name } : undefined;
}
