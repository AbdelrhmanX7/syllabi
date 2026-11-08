/**
 * «My handwriting» glyph bank — the public surface. Host apps (the Study calibration sheet) import ONLY from
 * here, so the two temporary modules below can be swapped for the real ones in one place.
 */
export {
  addSampleToBank,
  bankCoveredKeys,
  bankSampleCount,
  clearedBank,
  MAX_SAMPLES_PER_GLYPH,
  mergeGlyphBanks,
  removeGlyphFromBank,
  sameBankContent,
  sampleId,
} from './merge';
export {
  createIndexedDbGlyphBankLocal,
  createMemoryGlyphBankLocal,
  GLYPH_BANK_DB_NAME,
  GLYPH_BANK_STORE_NAME,
  GlyphBankConflictError,
  glyphBankRemoteFrom,
  GlyphBankStore,
  GlyphBankUnavailableError,
} from './store';
export type {
  GlyphBankLocal,
  GlyphBankRecord,
  GlyphBankRemote,
  GlyphBankRemoteSnapshot,
  GlyphBankRemoteStatus,
  GlyphBankState,
  GlyphBankStoreOptions,
} from './store';

export type { GlyphBank, GlyphEntry, GlyphForm, GlyphKey, GlyphPoint, GlyphSample } from './types';
export { EMPTY_GLYPH_BANK } from './types';

export type { ResolvedGlyph } from './latin';
export { digitKey, dotKey, isDigit, isLatin, latinKey, resolveGlyph, shapeWord } from './latin';

export type { NormalizeInput, SceneStroke } from './normalize';
export { BASELINE_BAND, DEFAULT_EPSILON, DEFAULT_TAIL_FRACTION, normalizeGlyph, simplifyStroke, strokesBbox } from './normalize';

export type { ComposedGlyph, ComposedLine, ComposedStroke, ComposedWord, ComposeOptions, Composition } from './compose';
export { composeText, DEFAULT_LINE_HEIGHT, DEFAULT_WORD_SPACING, wordIsWritable } from './compose';

export type { SheetCell, SheetPage } from './sheet';
import type { SheetCell as SheetCellData } from './sheet';
import { sheetCells, TARGET_CELLS_PER_PAGE } from './sheet';
export { FORM_LABEL, paginate, sheetCells, sheetKeys, sheetPages, TARGET_CELLS_PER_PAGE } from './sheet';

/** The calibration sheet as one flat list, paged by the host. */
export const SHEET_CELLS: readonly SheetCellData[] = sheetCells();
export const SHEET_PAGE_SIZE = TARGET_CELLS_PER_PAGE;
