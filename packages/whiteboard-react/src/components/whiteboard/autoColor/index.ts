/** Auto-colour handwriting («Auto colour») — what the package exports. */
export type { InkCandidate, InkClass, InkCloudClassifier, InkLineForCloud, InkPoint, InkRecognizeRequest, InkRecognizer } from './types';
export type { AutoColorConfig, InkDebugEntry, InkPalette, InkPhraseMemory, InkScript } from './model';
export { AMBIGUOUS_CONFIDENCE, INK_CLASSES } from './model';
export { DEFAULT_INK_PALETTE, resolvePalette } from './recolor';
export { classifyLine } from './rules';
