import type { InkClass, InkLineForCloud } from './types';

/** Tiny text rules standing in for the backend's JEV classifier until `/ai/ink-classify` ships. */
export function mockClassifyLine(line: InkLineForCloud): { cls: InkClass; confidence: number } {
  const text = line.text.trim();

  if (!text) return { cls: 'plain', confidence: 0.5 };
  if (/^\s*(e\.?g\.?|example)(?![\p{L}])/iu.test(text)) return { cls: 'example', confidence: 0.9 };
  if (/(^|\s)(remember|important|note)(?![\p{L}])|!!/iu.test(text)) return { cls: 'keypoint', confidence: 0.85 };
  if (/[=±×÷^]|\d\s?(km|m|s|kg|g|N|J|W|V|A|%)\b/.test(text)) return { cls: 'formula', confidence: 0.8 };
  if (/^(chapter|lesson|unit)(?![\p{L}])/iu.test(text) || (line.cues.relHeight >= 1.4 && text.length < 40)) {
    return { cls: 'heading', confidence: 0.8 };
  }
  if (/[:：]\s*$/.test(text) || (line.cues.underlined && text.length < 30)) return { cls: 'term', confidence: 0.75 };
  if (/\s(is|are|means)\s/i.test(text) && text.length > 20) return { cls: 'definition', confidence: 0.65 };

  return { cls: 'plain', confidence: 0.6 };
}
