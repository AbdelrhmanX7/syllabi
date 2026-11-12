/** Board AI — public surface of the package (host apps build the transport against these types). */
export type {
  BoardAiAnalyzeRequest,
  BoardAiAskAction,
  BoardAiAskRequest,
  BoardAiBlock,
  BoardAiCapabilities,
  BoardAiCatalog,
  BoardAiClassification,
  BoardAiClassifyContext,
  BoardAiSuggestedAction,
  BoardAiGenerateKind,
  BoardAiGenerateRequest,
  BoardAiImageLabel,
  BoardAiImageRequest,
  BoardAiImageSize,
  BoardAiImageStyle,
  BoardAiRegionKind,
  BoardAiScope,
  BoardAiService,
  BoardAiStreamEvent,
  ConceptEdgeArrow,
  ConceptMap,
  ConceptMapAnalysis,
  ConceptMapAnalyzeRequest,
  ConceptMapDirection,
  ConceptMapEdge,
  ConceptMapFixOp,
  ConceptMapGenerateRequest,
  ConceptMapNode,
  ConceptMapStyle,
  ConceptMapSuggestion,
  ConceptNodeShape,
  NormalizedBox,
  PageAnalysis,
  PagePoint,
  PenAction,
  PenActionEnd,
  PenActionTarget,
  PenPlanRequest,
  PenPlanResult,
  PenStrokeTool,
  PageAnalysisQuestion,
  PageAnalysisType,
  PageAnalysisVerdict,
  RemakeImageResult,
  RemakeOverlayBlock,
  RemakePartialPicture,
  RemakePartialQuestions,
  RemakePageRequest,
  SceneRect as BoardAiSceneRect,
  TermCluster,
  TermsMapDirection,
  TermsMapEdge,
  TermsMapExtra,
  TermsMapNode,
  TermsMapRequest,
  TermsMapResult,
} from './types';
export { BoardAiLayer } from './BoardAiLayer';
export type { BoardAiEditorBridge, BoardAiLayerProps, BoardAiRenderRequest } from './BoardAiLayer';
export { BOARD_AI_COMMAND_EVENT, isBoardAiCommand, requestBoardAiCommand } from './commands';
export type { BoardAiCommand, BoardAiCommandDetail } from './commands';
export {
  BOARD_BUDDY_REQUEST_EVENT,
  BOARD_BUDDY_STATE_EVENT,
  BOARD_BUDDY_TALK_EVENT,
  emitBoardBuddyState,
  emitBoardBuddyTalk,
  isBoardBuddyRequest,
  requestBoardBuddy,
} from './buddy';
export type { BoardBuddyRequest, BoardBuddyState } from './buddy';
export { blocksToMarkdown, extractJsonObject, markdownToBlocks } from './markdownBlocks';
export { parsePageAnalysis } from './pageAnalysis';
export { DEFAULT_CONCEPT_STYLE, parseConceptMap, parseConceptMapAnalysis } from './conceptMap';
export { AI_OBJECT_PROP, registerAiObjectPersistence } from './boardObjects';
export { HAND_FONT_FAMILY, setHandwritingFontUrl } from './handwritingObjects';
export { renderHtmlImage, setBoardFontBaseUrl } from './rasterize';
export type { AiObjectTag } from './boardObjects';
export { layoutToPlacements, parsePageLayout } from './pageLayout';
export type { LayoutPlacement, PageLayout, PageLayoutBlock, PageLayoutBlockKind, RemakeMode } from './pageLayout';
export { IMAGE_PROMPT_MAX } from './types';
export { parseTermsMap } from './termsMap';
export { parsePenPlan, PEN_MAX_ACTIONS, PEN_MAX_STROKE_POINTS, PEN_MAX_TEXT } from './penActions';
export { planHandConceptMap } from './handConceptMap';
// «My handwriting» glyph bank: the contract, the device/server store and (for now) the sheet + normalise stubs.
export * from './glyphBank';
