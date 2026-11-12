// Demo answer for `GET /classes/:id/knowledge` (the class knowledge map). The calculus class has a
// hand-made map; any other class gets one concept per topic of its sample questions. Invented data only.
import type { ClassKnowledge, KnowledgeConcept, MasteryTopic } from '../types';

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

type Row = [id: string, label: string, parent: string | null, strength: number | null, attempts: number, lastDays: number | null];

const CALCULUS: Row[] = [
  ['limits', 'Limits', null, 0.86, 14, 2],
  ['continuity', 'Continuity', 'limits', 0.72, 5, 6],
  ['derivatives', 'Derivatives', null, 0.64, 22, 1],
  ['chain-rule', 'Chain rule', 'derivatives', 0.38, 9, 1],
  ['product-rule', 'Product rule', 'derivatives', 0.81, 7, 4],
  ['implicit', 'Implicit differentiation', 'derivatives', null, 0, null],
  ['integrals', 'Integrals', null, 0.47, 8, 3],
  ['substitution', 'Substitution', 'integrals', 0.29, 4, 3],
  ['tangent-line', 'Tangent line', null, 0.9, 3, 9],
  ['series', 'Series', null, null, 0, null],
];

const CALCULUS_LINKS: [string, string][] = [
  ['limits', 'derivatives'],
  ['derivatives', 'tangent-line'],
  ['chain-rule', 'substitution'],
];

function calculus(topics: MasteryTopic[]): ClassKnowledge {
  const id = (key: string) => `kc_math_${key}`;
  // A topic the demo question bank also has shows the bank's own numbers, so the map and the topic list agree.
  const live = new Map(topics.filter((t) => t.attempts > 0).map((t) => [t.topic.toLowerCase(), t]));
  const concepts: KnowledgeConcept[] = CALCULUS.map(([key, label, parent, strength, attempts, lastDays]) => {
    const bank = parent ? undefined : live.get(label.toLowerCase());

    return {
      id: id(key),
      label,
      parentId: parent ? id(parent) : null,
      sources: parent ? ['subtopic'] : key === 'tangent-line' ? ['map-term'] : key === 'series' ? ['exam-topic'] : ['topic'],
      strength: bank ? bank.mastery : strength,
      attempts: bank ? bank.attempts : attempts,
      lastAt: lastDays === null ? null : daysAgo(lastDays),
    };
  });

  return {
    concepts,
    edges: [
      ...concepts.filter((c) => c.parentId).map((c) => ({ from: c.id, to: c.parentId!, kind: 'part-of' as const })),
      ...CALCULUS_LINKS.map(([from, to]) => ({ from: id(from), to: id(to), kind: 'linked' as const })),
    ],
  };
}

/** `classId` is a fixture class id; `topics` = the mock's own per-topic numbers for that class. */
export function mockClassKnowledge(classId: string, topics: MasteryTopic[]): ClassKnowledge {
  if (classId === 'cls_demo_math') return calculus(topics);

  return {
    concepts: topics
      .filter((t) => t.topic.trim() && t.topic.trim().toLowerCase() !== 'general')
      .map((t, index) => ({
        id: `kc_${classId}_${index}`,
        label: t.topic,
        parentId: null,
        sources: ['topic'] as KnowledgeConcept['sources'],
        strength: t.attempts > 0 ? t.mastery : null,
        attempts: t.attempts,
        lastAt: null,
      })),
    edges: [],
  };
}
