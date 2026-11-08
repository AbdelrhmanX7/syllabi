// A realistic reference map (the shape the backend's `result {graph}` frame carries, bboxes in its
// normalised 0..1 space included) — for the diagram tests and the mock's plate-tectonics maps.
import type { ReferenceMap } from '../types';

const box = (x: number, y: number): [number, number, number, number] => [x, y, 0.2, 0.1];

export const PLATE_TECTONICS_REFERENCE: ReferenceMap = {
  title: 'From Continental Drift to Plate Tectonics',
  nodes: [
    { id: 'n1', text: 'Alfred Wegener', level: 0, bbox: box(0.1, 0.05) },
    { id: 'n2', text: 'Continental Drift', level: 1, bbox: box(0.1, 0.2) },
    { id: 'n3', text: 'Supercontinent Pangaea', level: 2, bbox: box(0, 0.35) },
    { id: 'n4', text: 'Lacked a mechanism', level: 2, bbox: box(0.2, 0.35) },
    { id: 'n5', text: 'Fossil and rock evidence matching across oceans', level: 2, bbox: box(0.4, 0.35) },
    { id: 'n6', text: 'Plate Tectonics', level: 2, bbox: box(0.6, 0.35) },
    { id: 'n7', text: "Unifying theory of how Earth's surface moves and changes", level: 3, bbox: box(0, 0.5) },
    { id: 'n8', text: 'Rigid lithospheric plates', level: 3, bbox: box(0.2, 0.5) },
    { id: 'n9', text: 'Lithosphere', level: 4, bbox: box(0.4, 0.65) },
    { id: 'n10', text: "Earth's outer rigid layer", level: 5, bbox: box(0, 0.8) },
    { id: 'n11', text: 'Crust + uppermost mantle', level: 5, bbox: box(0.2, 0.8) },
    { id: 'n12', text: 'Asthenosphere', level: 4, bbox: box(0.6, 0.65) },
    { id: 'n13', text: 'Mantle convection', level: 3, bbox: box(0.8, 0.5) },
    { id: 'n14', text: 'Seafloor spreading', level: 3, bbox: box(0.6, 0.5) },
    { id: 'n15', text: 'Subduction', level: 3, bbox: box(0.4, 0.5) },
  ],
  edges: [
    { from: 'n1', to: 'n2', label: 'proposed' },
    { from: 'n2', to: 'n3', label: 'described the breakup of' },
    { from: 'n2', to: 'n4', label: 'was rejected because it' },
    { from: 'n2', to: 'n5', label: 'was supported by' },
    { from: 'n2', to: 'n6', label: 'later led to' },
    { from: 'n6', to: 'n7', label: 'is defined as' },
    { from: 'n6', to: 'n8', label: 'divides the surface into' },
    { from: 'n8', to: 'n9', label: 'are broken pieces of the' },
    { from: 'n9', to: 'n10', label: 'is' },
    { from: 'n9', to: 'n11', label: 'consists of' },
    { from: 'n8', to: 'n12', label: 'glide over the weak' },
    { from: 'n13', to: 'n8', label: 'drags and moves' },
    { from: 'n6', to: 'n14', label: 'explains' },
    { from: 'n6', to: 'n15', label: 'explains' },
    { from: 'n14', to: 'n9', label: 'creates new' },
    { from: 'n15', to: 'n9', label: 'recycles old' },
    { from: 'n14', to: 'n4', label: 'supplied what Wegener' },
  ],
};

/** His hand-drawn map for the same lecture, as the Canvas import transcribes it (markdown, one link per line). */
export const PLATE_TECTONICS_TRANSCRIPTION = [
  "**Continental Drift** → It's a theory showing that the world was a super continent",
  '**Continental Drift** → unlabeled → **Plate Tectonics**',
  'Using it to know more about ocean ridges and the sea floor → **Plate Tectonics**',
  '**Plate Tectonics** → unlabeled → **Asthenosphere**',
  '**Asthenosphere** → (part of upper mantle) hotter and weak compared to the Lithosphere',
  '**Asthenosphere** → unlabeled → **Lithosphere**',
  '**Lithosphere** → Crust + uppermost mantle, outermost strong rigid layer',
].join('\n');

// The owner's sedimentary-rocks map: three parents fanning to a dozen children, long phrases.
export const SEDIMENTARY = {
  title: 'Sedimentary Rocks: Transport Forms and Rock Types',
  nodes: [
    ['root', 'Sedimentary rocks'],
    ['chem', 'Chemical sedimentary rock'],
    ['clas', 'Clastic Sedimentary Rock'],
    ['bio', 'Biochemical sedimentary rock'],
    ['inorg', 'Rock formed by inorganic precipitation of dissolved ions'],
    ['susp', 'Suspended load'],
    ['lith', 'Rock formed from accumulated, lithified rock and mineral fragments'],
    ['diss', 'Dissolved load'],
    ['lime', 'Limestone'],
    ['lithif', 'Lithification'],
    ['org', 'Rock formed when organisms convert dissolved ions into mineral material'],
    ['fine', 'Fine sediment particles held within flowing water'],
    ['shale', 'Shale'],
    ['ions', 'Ions carried in solution within water'],
    ['cem', 'Cementation'],
    ['calc', 'Rock chiefly comprised of calcite; most limestone is biochemical in origin'],
    ['trans', 'Transformation of sediments into sedimentary rock'],
    ['comp', 'Compaction'],
  ].map(([id, text]) => ({ id: id!, text: text! })),
  edges: [
    ['root', 'chem', 'includes'],
    ['root', 'clas', 'includes'],
    ['root', 'bio', 'includes'],
    ['chem', 'inorg', 'is defined as'],
    ['chem', 'susp', 'can form from'],
    ['clas', 'lith', 'is defined as'],
    ['clas', 'shale', 'includes'],
    ['clas', 'diss', 'forms from'],
    ['chem', 'diss', 'forms from'],
    ['bio', 'lime', 'includes inorganic varieties of'],
    ['clas', 'lime', 'commonly forms'],
    ['bio', 'lithif', 'forms through'],
    ['bio', 'org', 'is defined as'],
    ['susp', 'fine', 'is defined as'],
    ['susp', 'shale', 'can accumulate to form'],
    ['diss', 'ions', 'is defined as'],
    ['lithif', 'cem', 'involves'],
    ['lime', 'calc', 'is defined as'],
    ['lithif', 'trans', 'is defined as'],
    ['lithif', 'comp', 'involves sediment compression by'],
  ].map(([from, to, label]) => ({ from: from!, to: to!, label: label! })),
};
