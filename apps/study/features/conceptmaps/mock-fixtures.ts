// Demo concept maps per subject, for the mock transport. Everything here is invented — lecture
// titles, transcriptions, comments and scores. The subject is picked from the class's code / name;
// any class that matches none gets the general study-skills set. Some maps carry no term list on
// purpose: the AI builds and checks those from the topic alone.
import type { PredictedPrompt } from './types';

import { PLATE_TECTONICS_TRANSCRIPTION } from './lib/diagram.fixture';

export type Subject = 'programming' | 'calculus' | 'geology' | 'general';

export interface Fixture {
  number: number;
  week: number;
  lecture: string;
  /** Empty = no term list (optional). */
  terms: string[];
  /** days before "today" */
  dueDaysAgo: number;
  score: number | null;
  examReview?: boolean;
  transcription?: string;
  comment?: string | null;
  modelAnswer?: string | null;
}

export interface SubjectData {
  fixtures: Fixture[];
  predictions: Omit<PredictedPrompt, 'week'>[];
  /** What the mock «reads» off a photo. */
  photoTerms: string[];
  /** Concepts the mock «reads» off a map that has no term list and no transcription. */
  topicConcepts: string[];
  textbook: string;
}

/** Picks the demo subject from a class's code / name. */
export function subjectOf(cls: { code?: string | null; name?: string | null } | undefined): Subject {
  const text = `${cls?.code ?? ''} ${cls?.name ?? ''}`;

  if (/\b(COMSC|CS|CIS|CSE)\b|program|software|c\+\+|java|python/i.test(text)) return 'programming';
  if (/\bMATH\b|calculus|algebra|statistic/i.test(text)) return 'calculus';
  if (/\bGEOL\b|geolog|earth science/i.test(text)) return 'geology';

  return 'general';
}

const PROGRAMMING: Fixture[] = [
  {
    number: 1,
    week: 1,
    lecture: 'L1 Classes and Objects',
    terms: ['Class', 'Object', 'Constructor', 'Member function', 'Encapsulation'],
    dueDaysAgo: 38,
    score: 8.5,
    transcription:
      'Class → "is the blueprint for an" → Object\nConstructor → "initialises a new" → Object\nClass → "declares" → Member function\nEncapsulation → unlabeled → Class',
    comment: 'Say what encapsulation hides — private data behind public functions.',
    modelAnswer:
      'A class is a blueprint that bundles data and the member functions that act on it. Each object is one instance, set up by a constructor. Encapsulation keeps the data private so code outside the class goes through its public functions.',
  },
  {
    number: 2,
    week: 2,
    lecture: 'L3 Recursion',
    terms: ['Base case', 'Recursive case', 'Call stack', 'Stack overflow'],
    dueDaysAgo: 30,
    score: 7,
    examReview: true,
    transcription:
      'Recursive case → "calls itself on a smaller input until the" → Base case\nRecursive case → "pushes a frame onto the" → Call stack\nCall stack → unlabeled → Stack overflow',
    comment: 'Why does the stack overflow? Missing base case — label that arrow.',
    modelAnswer:
      'A recursive function solves a problem by calling itself on a smaller input (the recursive case) until it reaches a base case it answers directly. Each call adds a frame to the call stack; with no reachable base case the stack grows until it overflows.',
  },
  {
    number: 3,
    week: 3,
    lecture: 'L5 Pointers and Memory',
    terms: ['Pointer', 'Reference', 'Stack', 'Heap', 'Memory leak'],
    dueDaysAgo: 22,
    score: null,
    transcription:
      'Pointer → "holds the address of memory on the" → Heap\nReference → "is an alias for an existing variable, often on the" → Stack\nHeap → "memory never deleted causes a" → Memory leak',
    comment: null,
    modelAnswer: null,
  },
  {
    // No term list: graded on links and depth only.
    number: 4,
    week: 4,
    lecture: 'L7 Inheritance and Polymorphism',
    terms: [],
    dueDaysAgo: 12,
    score: 9,
    examReview: true,
    transcription:
      'Base class → "is extended by a" → Derived class\nDerived class → "overrides a" → Virtual function\nVirtual function → "called through a base pointer gives" → Polymorphism\nAbstract class → "has at least one pure" → Virtual function',
    comment: 'Clear. Add one example (Shape → Circle) for depth.',
    modelAnswer:
      'A derived class inherits the members of its base class and can override its virtual functions. Calling a virtual function through a base-class pointer runs the derived version — that is polymorphism. A class with a pure virtual function is abstract and cannot be instantiated.',
  },
  {
    number: 5,
    week: 5,
    lecture: 'L9 Templates',
    terms: [],
    dueDaysAgo: 2,
    score: null,
  },
];

const CALCULUS: Fixture[] = [
  {
    number: 1,
    week: 1,
    lecture: 'L2 Limits and Continuity',
    terms: ['Limit', 'One-sided limit', 'Continuity', 'Vertical asymptote'],
    dueDaysAgo: 36,
    score: 9,
    transcription:
      'One-sided limit → "both sides agree means the" → Limit exists\nLimit exists → "and equals f(a) gives" → Continuity\nOne-sided limit → "going to infinity shows a" → Vertical asymptote',
    comment: null,
    modelAnswer:
      'A limit describes the value f(x) approaches as x approaches a. It exists when both one-sided limits agree. A function is continuous at a when the limit exists and equals f(a); a one-sided limit that grows without bound marks a vertical asymptote.',
  },
  {
    number: 2,
    week: 3,
    lecture: 'L4 The Derivative',
    terms: ['Difference quotient', 'Derivative', 'Tangent line', 'Rate of change'],
    dueDaysAgo: 24,
    score: 7.5,
    examReview: true,
    transcription:
      'Difference quotient → "its limit as h → 0 is the" → Derivative\nDerivative → "is the slope of the" → Tangent line\nDerivative → unlabeled → Rate of change',
    comment: 'Label the last arrow — the derivative IS the instantaneous rate of change.',
    modelAnswer:
      'The derivative is the limit of the difference quotient as h approaches 0. It gives the slope of the tangent line at a point and the instantaneous rate of change of the function there.',
  },
  {
    // No term list: graded on links and depth only.
    number: 3,
    week: 4,
    lecture: 'L6 The Chain Rule',
    terms: [],
    dueDaysAgo: 15,
    score: 8,
    transcription:
      'Composite function → "is differentiated with the" → Chain rule\nChain rule → "multiplies the outer derivative by the" → Inner derivative\nChain rule → "applied to an equation in x and y gives" → Implicit differentiation',
    comment: null,
    modelAnswer:
      'For a composite function f(g(x)) the chain rule gives f′(g(x))·g′(x): the outer derivative, evaluated at the inner function, times the inner derivative. Implicit differentiation is the chain rule applied to y as a function of x.',
  },
  {
    number: 4,
    week: 6,
    lecture: 'L9 Integrals',
    terms: ['Riemann sum', 'Definite integral', 'Antiderivative', 'Fundamental Theorem'],
    dueDaysAgo: 3,
    score: null,
    examReview: true,
  },
];

const GENERAL: Fixture[] = [
  {
    number: 1,
    week: 1,
    lecture: 'How memory works',
    terms: ['Retrieval practice', 'Long-term memory', 'Forgetting curve', 'Spaced repetition'],
    dueDaysAgo: 20,
    score: 8,
    transcription:
      'Retrieval practice → "strengthens" → Long-term memory\nForgetting curve → "is flattened by" → Spaced repetition\nSpaced repetition → unlabeled → Retrieval practice',
    comment: 'Good. Label the last link — spacing schedules the retrieval.',
    modelAnswer:
      'Recalling an idea without looking (retrieval practice) strengthens it in long-term memory. Memories fade along a forgetting curve; reviewing at growing intervals (spaced repetition) flattens that curve, and each review is itself retrieval practice.',
  },
  {
    // No term list: graded on links and depth only.
    number: 2,
    week: 2,
    lecture: 'Taking good notes',
    terms: [],
    dueDaysAgo: 9,
    score: null,
    transcription:
      'Lecture → "is summarised in" → Notes\nNotes → "are turned into" → Questions\nQuestions → "are answered from memory during" → Review',
  },
  {
    number: 3,
    week: 3,
    lecture: 'Preparing for an exam',
    terms: ['Practice test', 'Feedback', 'Weak topics', 'Study plan'],
    dueDaysAgo: 1,
    score: null,
  },
];

/** Geology: a fictional lecture sequence. */
const GEOLOGY: Fixture[] = [
  {
    number: 1,
    week: 1,
    lecture: 'L1 Evidence and Inference',
    terms: ['Evidence', 'Inference', 'Model', 'Prediction'],
    dueDaysAgo: 42,
    score: 8,
    transcription:
      'Evidence → "is interpreted into" → Inference\nInference → "is organised as a" → Model\nModel → unlabeled → Prediction\nPrediction → "is checked against new" → Evidence',
    comment: 'Good loop. One arrow has no label — every arrow needs one.',
    modelAnswer:
      'Scientists gather evidence from rocks and landscapes, draw inferences about the processes that produced it, assemble those inferences into a model, and use the model to make predictions that new evidence can confirm or reject.',
  },
  {
    number: 2,
    week: 1,
    lecture: 'L2 Earth as a System',
    terms: ['Atmosphere', 'Biosphere', 'Geosphere', 'Hydrosphere', 'Feedback loop'],
    dueDaysAgo: 40,
    score: 9,
    transcription:
      'Geosphere → "exchanges water with" → Hydrosphere\nHydrosphere → "evaporates into" → Atmosphere\nAtmosphere → "supplies gases to" → Biosphere\nBiosphere → "weathers rock in" → Geosphere\nall four → "interact through" → Feedback loop',
    comment: null,
    modelAnswer:
      'Earth is a system of four interacting spheres. Matter and energy move among the geosphere, hydrosphere, atmosphere and biosphere, and feedback loops amplify or dampen those exchanges over time.',
  },
  {
    number: 3,
    week: 2,
    lecture: 'L3 The Rock Cycle',
    terms: ['Igneous rock', 'Sedimentary rock', 'Metamorphic rock', 'Weathering', 'Melting'],
    dueDaysAgo: 35,
    score: 7,
    examReview: true,
    transcription:
      'Igneous rock → "breaks down by" → Weathering\nWeathering → "produces sediment that becomes" → Sedimentary rock\nSedimentary rock → "heat + pressure" → Metamorphic rock\nMetamorphic rock → unlabeled → Melting\nMelting → "cools into" → Igneous rock',
    comment: 'Define the terms, not only the arrows. Why does weathering happen?',
    modelAnswer:
      'Rock moves between three families. Weathering breaks any rock into sediment, which is buried and lithified into sedimentary rock; heat and pressure transform rock into metamorphic rock; melting returns rock to magma, which cools into igneous rock.',
  },
  {
    number: 4,
    week: 2,
    lecture: "L4 Earth's Interior",
    terms: ['Crust', 'Mantle', 'Outer core', 'Inner core', 'Seismic waves'],
    dueDaysAgo: 33,
    score: null,
    transcription:
      'Seismic waves → "reveal the layers" → Crust, Mantle, Outer core, Inner core\nCrust → "thin, rigid, sits on" → Mantle\nMantle → "surrounds the liquid" → Outer core\nOuter core → "surrounds the solid" → Inner core',
    comment: null,
    modelAnswer: null,
  },
  {
    number: 5,
    week: 3,
    lecture: 'L5 Plate Boundaries',
    terms: ['Subduction', 'Seafloor spreading', 'Transform fault', 'Hot spot', 'Convection'],
    dueDaysAgo: 26,
    score: 6.5,
    examReview: true,
    transcription:
      'Convection → "drives" → Seafloor spreading\nConvection → "drives" → Subduction\nSeafloor spreading → unlabeled → Transform fault\nHot spot → unlabeled',
    comment: 'Hot spot is not connected to anything — show how it relates to the plate moving over it.',
    modelAnswer:
      'Mantle convection moves the plates. New seafloor forms by spreading at divergent boundaries, old seafloor is consumed by subduction at convergent ones, and transform faults let plates slide past each other. Hot spots are fixed plumes that leave a track as the plate moves over them.',
  },
  {
    number: 6,
    week: 4,
    lecture: 'L6 Building Minerals',
    terms: ['Crystal lattice', 'Silica tetrahedron', 'Quartz', 'Feldspar', 'Mica'],
    dueDaysAgo: 19,
    score: 8.5,
    transcription:
      'Silica tetrahedron → "repeats to form a" → Crystal lattice\nCrystal lattice → "fully linked tetrahedra →" → Quartz\nCrystal lattice → "with Al, K, Na, Ca →" → Feldspar\nCrystal lattice → "sheets →" → Mica',
    comment: 'Nice — the sheet structure explains why mica cleaves. Say so.',
    modelAnswer:
      'The silica tetrahedron is the building block of silicate minerals. How tetrahedra link into a crystal lattice sets the mineral: a fully linked framework gives quartz, frameworks with aluminium and alkali ions give feldspar, and sheets give mica.',
  },
  {
    number: 7,
    week: 4,
    lecture: 'L7 Sediment to Rock',
    terms: ['Erosion', 'Deposition', 'Compaction', 'Cementation', 'Lithification'],
    dueDaysAgo: 17,
    score: 9.5,
    examReview: true,
    transcription:
      'Erosion → "carries sediment to" → Deposition\nDeposition → "buries layers, causing" → Compaction\nCompaction → "squeezes water out; minerals then cause" → Cementation\nCompaction + Cementation → "together are" → Lithification',
    comment: null,
    modelAnswer:
      'Erosion transports sediment; deposition lays it down in layers. Burial compacts the layers and squeezes out water, dissolved minerals cement the grains, and compaction plus cementation together lithify loose sediment into sedimentary rock.',
  },
  {
    number: 8,
    week: 5,
    lecture: 'L8 Volcanoes',
    terms: ['Viscosity', 'Shield volcano', 'Stratovolcano', 'Pyroclastic flow', 'Caldera'],
    dueDaysAgo: 12,
    score: null,
    transcription: undefined,
    comment: null,
    modelAnswer: null,
  },
  {
    number: 9,
    week: 5,
    lecture: 'L9 Earthquakes',
    terms: ['Focus', 'Epicenter', 'P-wave', 'S-wave', 'Magnitude'],
    dueDaysAgo: 10,
    score: 8,
    examReview: true,
    transcription:
      'Focus → "the point directly above it on the surface is the" → Epicenter\nFocus → "releases" → P-wave, S-wave\nP-wave → "arrives first, travels through liquids" \nS-wave → "arrives second, solids only"\nMagnitude → "measures energy released at the" → Focus',
    comment: 'Label the arrow from magnitude — "measures" is enough.',
    modelAnswer:
      'An earthquake starts at the focus; the epicenter is the surface point above it. P-waves and S-waves radiate from the focus, P-waves faster and through liquids, S-waves slower and only through solids. Magnitude measures the energy released.',
  },
  {
    // A map transcribed in the import's markdown, with definition sentences hanging off the terms —
    // the shape the «Compare maps» diff has to cope with.
    number: 10,
    week: 6,
    lecture: 'L10 From Continental Drift to Plate Tectonics',
    terms: ['Continental Drift', 'Plate Tectonics', 'Lithosphere', 'Asthenosphere', 'Pangaea'],
    dueDaysAgo: 4,
    score: 9.5,
    transcription: PLATE_TECTONICS_TRANSCRIPTION,
    comment: 'Label your arrows, and say what Pangaea has to do with drift.',
    modelAnswer:
      "Wegener's **continental drift** said the continents were once joined as **Pangaea**, but it lacked a mechanism. **Plate tectonics** supplied one: the rigid **lithosphere** is broken into plates that move over the weak, hot **asthenosphere**.",
  },
  {
    // No term list: the AI grades and drafts the reference from the topic alone.
    number: 11,
    week: 6,
    lecture: 'L11 Groundwater',
    terms: [],
    dueDaysAgo: 1,
    score: null,
  },
];


export const SUBJECTS: Record<Subject, SubjectData> = {
  programming: {
    fixtures: PROGRAMMING,
    predictions: [
      {
        terms: ['Operator overloading', 'Friend function', 'Copy constructor', 'Assignment operator'],
        lecture: 'L10 Operator Overloading',
        why: 'Next chapter in the syllabus; the week 6 slides list these terms in bold.',
      },
      {
        terms: ['Exception', 'try', 'catch', 'throw', 'Stack unwinding'],
        lecture: 'L11 Exceptions',
        why: 'The schedule covers error handling the week after.',
      },
      {
        terms: ['Vector', 'Iterator', 'Map', 'Algorithm'],
        lecture: 'L12 The Standard Library',
        why: 'The study guide names the STL as the first topic of Exam 2.',
      },
    ],
    photoTerms: ['Class', 'Object', 'Inheritance', 'Virtual function', 'Polymorphism'],
    topicConcepts: ['Class', 'Object', 'Function', 'Example', 'Use case'],
    textbook: 'C++ textbook — ch. 9',
  },
  calculus: {
    fixtures: CALCULUS,
    predictions: [
      {
        terms: ['Substitution', 'Indefinite integral', 'Change of variables', 'Chain rule'],
        lecture: 'L10 Integration by Substitution',
        why: 'Next section in the syllabus; it reverses the chain rule.',
      },
      {
        terms: ['Area between curves', 'Volume', 'Disk method', 'Shell method'],
        lecture: 'L11 Applications of Integrals',
        why: 'The schedule moves to applications the week after.',
      },
      {
        terms: ['Critical point', 'First derivative test', 'Concavity', 'Optimization'],
        lecture: 'Review: Applications of Derivatives',
        why: 'The study guide lists optimization problems for the final.',
      },
    ],
    photoTerms: ['Limit', 'Derivative', 'Tangent line', 'Slope', 'Rate of change'],
    topicConcepts: ['Function', 'Limit', 'Derivative', 'Example', 'Graph'],
    textbook: 'Calculus textbook — ch. 5',
  },
  geology: {
    fixtures: GEOLOGY,
    predictions: [
      {
        terms: ['Porosity', 'Permeability', 'Aquifer', 'Water table', 'Recharge'],
        lecture: 'L12 Groundwater',
        why: 'Next chapter in the syllabus; the slides for week 6 list these five bold terms.',
      },
      {
        terms: ['Glacier', 'Moraine', 'Till', 'Outwash', 'Ablation'],
        lecture: 'L13 Glaciers',
        why: 'The lab manual covers glacial deposits the week after groundwater.',
      },
      {
        terms: ['Stress', 'Strain', 'Fold', 'Fault', 'Joint'],
        lecture: 'L14 Deformation',
        why: 'The study guide names structural geology as the first topic of Exam 2.',
      },
    ],
    photoTerms: ['Fault', 'Epicenter', 'Focus', 'Seismic wave', 'Richter scale'],
    topicConcepts: ['Process', 'Cause', 'Result', 'Example', 'Evidence'],
    textbook: 'Geology textbook — ch. 19',
  },
  general: {
    fixtures: GENERAL,
    predictions: [
      {
        terms: ['Interleaving', 'Blocked practice', 'Transfer', 'Desirable difficulty'],
        lecture: 'Mixing up practice',
        why: 'Builds on spaced repetition from the earlier maps.',
      },
      {
        terms: ['Elaboration', 'Concrete example', 'Dual coding', 'Self-explanation'],
        lecture: 'Making ideas stick',
        why: 'The next reading covers these strategies.',
      },
    ],
    photoTerms: ['Main idea', 'Cause', 'Effect', 'Example', 'Definition'],
    topicConcepts: ['Main idea', 'Definition', 'Example', 'Cause', 'Effect'],
    textbook: 'Course reading',
  },
};
