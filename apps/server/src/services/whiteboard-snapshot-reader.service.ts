/** A page's parsed Fabric canvas — only ever returned when it actually has ink. */
export interface ParsedPageCanvas {
  objects: any[];
  background: any;
  [key: string]: any;
}

function preview(text: string, max = 120): string {
  const head = text.slice(0, max).replace(/\s+/g, " ");
  return text.length > max ? `${head}…` : head;
}

/**
 * Parse one page's `canvasJSON`. Null means "no ink, skip it" (empty/whitespace/non-string,
 * or no objects). Throws only on a non-empty string that is malformed JSON, so corruption
 * is never silently dropped.
 */
export function parsePageCanvas(canvasJSON: unknown): ParsedPageCanvas | null {
  if (typeof canvasJSON !== "string") return null;
  const trimmed = canvasJSON.trim();
  if (trimmed.length === 0) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `parsePageCanvas: canvasJSON is not valid JSON (${trimmed.length} chars, starts "${preview(trimmed, 60)}"): ${(error as Error).message}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (!Array.isArray(parsed.objects) || parsed.objects.length === 0) return null;
  return parsed as ParsedPageCanvas;
}
