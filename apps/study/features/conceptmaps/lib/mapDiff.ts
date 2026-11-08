// His map vs the AI reference, as a visual diff. Concepts are matched by normalised term (case,
// plurals, punctuation, one name containing the other); then the reference is split into CORE —
// links between two prompt terms, and each prompt term's definition («is», «is defined as»,
// «consists of» → a description) — and ENRICHMENT, everything else, which is only ever «an idea you
// could add», never «missing». His dotted definition notes satisfy a term's definition link when
// their words overlap the reference description. Each link is then matched, label off (no label /
// worded differently / reversed / a definition that says something else), missing (core only),
// idea (enrichment he does not have), extra (his own; not wrong — her wording wins) or definition.
// Also builds the overlay graph. Pure — unit-tested.
import type { MapReading, ReadNodeKind, ReferenceEdge, ReferenceMap, ReferenceNode, WrongLink } from '../types';

import { matchTerms, normalizeTerm, termMatches, termTokens, tokensEqual } from './terms';

export interface MapGraphNode {
  id: string;
  label: string;
  kind: ReadNodeKind;
}

export interface MapGraphEdge {
  from: string;
  to: string;
  label: string | null;
}

/** His map as a graph: from the grader's reading of a practice attempt, or the Canvas transcription. */
export interface MapGraph {
  nodes: MapGraphNode[];
  edges: MapGraphEdge[];
}

export type EdgeClass = 'matched' | 'labelOff' | 'missing' | 'idea' | 'extra' | 'definition';
export type LinkTier = 'core' | 'enrichment';

export interface EdgeDiff {
  cls: EdgeClass;
  /** Ids in the overlay graph (his ids, or `ghost:<ref id>` for a concept only the reference has). */
  from: string;
  to: string;
  hisLabel: string | null;
  refLabel: string | null;
  /** His arrow points the other way. */
  reversed: boolean;
  /** His definition note is there but says something else than the reference description. */
  defDiffers: boolean;
  /** The reference edge's ends and tier, when there is one. */
  refFrom: string | null;
  refTo: string | null;
  tier: LinkTier | null;
}

export type DiffNodeClass = 'matched' | 'extra' | 'note' | 'ghost' | 'idea';

export interface DiffNode {
  id: string;
  label: string;
  cls: DiffNodeClass;
  /** A prompt term he left out (drawn with a red ring). */
  absentTerm: boolean;
  /** The matching reference node, if any. */
  refId: string | null;
}

export interface DiffCounts {
  /** Core links in the reference. */
  core: number;
  matched: number;
  /** Right pair, no label on his arrow. */
  needLabel: number;
  /** Right pair, a different label or the arrow reversed. */
  reworded: number;
  /** His definition note says something else. */
  defDiffers: number;
  coreMissing: number;
  /** Enrichment links he does not have. */
  ideas: number;
  /** His links the reference does not have. */
  extra: number;
}

export interface MapDiff {
  /** Overlay graph nodes: his, then ghosts. */
  nodes: DiffNode[];
  /** Overlay graph edges: his (classified), then the reference links he does not have. */
  edges: EdgeDiff[];
  /** Reference node id → his node id (concepts). */
  refToHis: Map<string, string>;
  hisToRef: Map<string, string>;
  /** Reference description node → his definition note that covers it. */
  covered: Map<string, string>;
  /** Prompt terms that appear nowhere in his map. */
  absentTerms: string[];
  counts: DiffCounts;
}

export const ghostId = (refId: string) => `ghost:${refId}`;
export const edgeKey = (from: string, to: string) => `${from}→${to}`;

const NOTE_WORDS = 5;
const UNLABELED = /^(unlabell?ed|no label|none|-+|—|\?)$/i;

/** Markdown and list noise off one part of a transcription line. */
function cleanPart(part: string): string {
  return part
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*["“”']+|["“”']+\s*$/g, '')
    .trim();
}

const looksLikeNote = (text: string) => text.startsWith('(') || text.split(/\s+/).length >= NOTE_WORDS;

/**
 * `A → "label" → B` per line (also `->`, `⟶`, `=>`); `A → unlabeled → B` and `A → B` are unlabeled
 * links; a long part (a sentence, or one opening with «(») is a definition note. Lines without an
 * arrow are ignored.
 */
export function parseTranscription(text: string): MapGraph {
  const nodes: MapGraphNode[] = [];
  const byKey = new Map<string, MapGraphNode>();
  const edges: MapGraphEdge[] = [];
  const nodeFor = (label: string): MapGraphNode => {
    const key = normalizeTerm(label) || label.toLowerCase();
    const known = byKey.get(key);

    if (known) return known;
    const node: MapGraphNode = { id: `h${nodes.length + 1}`, label, kind: looksLikeNote(label) ? 'note' : 'concept' };

    nodes.push(node);
    byKey.set(key, node);

    return node;
  };

  for (const line of text.split(/\r?\n/)) {
    const parts = line
      .split(/\s*(?:→|⟶|->|=>|—>)\s*/)
      .map(cleanPart)
      .filter(Boolean);

    if (parts.length < 2) continue;
    if (parts.length === 2) {
      if (UNLABELED.test(parts[1]!)) continue;
      edges.push({ from: nodeFor(parts[0]!).id, to: nodeFor(parts[1]!).id, label: null });
      continue;
    }
    // A → label → B (→ label → C …)
    for (let i = 0; i + 2 < parts.length; i += 2) {
      const label = parts[i + 1]!;
      const target = parts[i + 2]!;

      if (UNLABELED.test(target)) continue;
      edges.push({
        from: nodeFor(parts[i]!).id,
        to: nodeFor(target).id,
        label: UNLABELED.test(label) ? null : label,
      });
    }
  }

  return { nodes, edges };
}

export function readingGraph(reading: MapReading): MapGraph {
  return {
    nodes: reading.nodes.map((node) => ({ id: node.id, label: node.label, kind: node.kind ?? 'concept' })),
    edges: reading.edges.map((edge) => ({ from: edge.from, to: edge.to, label: edge.label?.trim() || null })),
  };
}

const LABEL_STOP = new Set(['is', 'are', 'was', 'were', 'be', 'it', 'its', 'by', 'as', 'that', 'this', 'which']);
const labelTokens = (label: string) => termTokens(label).filter((token) => !LABEL_STOP.has(token));

/** Same wording, one inside the other, or at least half of the shorter label's words shared. */
export function labelsCompatible(a: string, b: string): boolean {
  const na = normalizeTerm(a);
  const nb = normalizeTerm(b);

  if (!na || !nb) return false;
  if (na === nb || ` ${na} `.includes(` ${nb} `) || ` ${nb} `.includes(` ${na} `)) return true;
  const ta = labelTokens(a);
  const tb = labelTokens(b);

  if (ta.length === 0 || tb.length === 0) return false;
  const shared = ta.filter((token) => tb.some((other) => tokensEqual(token, other))).length;

  return shared / Math.min(ta.length, tb.length) >= 0.5;
}

/** Reference concept → his concept: exact normalised text first, then one name containing the other. One-to-one. */
export function matchConcepts(his: MapGraph, ref: ReferenceNode[]): Map<string, string> {
  const result = new Map<string, string>();
  const claimed = new Set<string>();
  const concepts = his.nodes.filter((node) => node.kind === 'concept');
  const pass = (pick: (refNode: ReferenceNode, free: MapGraphNode[]) => MapGraphNode | undefined) => {
    for (const refNode of ref) {
      if (result.has(refNode.id)) continue;
      const hit = pick(
        refNode,
        concepts.filter((node) => !claimed.has(node.id)),
      );

      if (hit) {
        result.set(refNode.id, hit.id);
        claimed.add(hit.id);
      }
    }
  };

  pass((refNode, free) => free.find((node) => normalizeTerm(node.label) === normalizeTerm(refNode.text)));
  pass((refNode, free) =>
    [...free]
      .sort((a, b) => a.label.length - b.label.length)
      .find((node) => termMatches(refNode.text, node.label) || termMatches(node.label, refNode.text)),
  );

  return result;
}

const DEFINITION_LABEL =
  /^(is|are|is an?|are an?|is defined as|defined as|means|refers to|is called|consists? of|is made (up )?of|is composed of)$/i;

export const isDefinitionLabel = (label: string | null | undefined) => DEFINITION_LABEL.test(label?.trim() ?? '');

const DESCRIPTION_STOP = new Set([
  ...LABEL_STOP,
  'with',
  'from',
  'than',
  'compared',
  'part',
  'how',
  'what',
  'into',
  'at',
]);
const descriptionTokens = (text: string) => termTokens(text).filter((token) => !DESCRIPTION_STOP.has(token));

/** His definition says what the reference description says: one inside the other, or ≥ 30 % of the shorter one's words shared. */
export function descriptionsOverlap(his: string, ref: string): boolean {
  const a = normalizeTerm(his);
  const b = normalizeTerm(ref);

  if (!a || !b) return false;
  if (` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `)) return true;
  const ta = descriptionTokens(his);
  const tb = descriptionTokens(ref);

  if (ta.length === 0 || tb.length === 0) return false;
  const shared = tb.filter((token) => ta.some((other) => tokensEqual(token, other))).length;

  return shared / Math.min(ta.length, tb.length) >= 0.3;
}

export function diffMaps(his: MapGraph, ref: ReferenceMap, promptTerms: string[] = []): MapDiff {
  const refToHis = matchConcepts(his, ref.nodes);
  const hisToRef = new Map(Array.from(refToHis, ([refId, hisId]) => [hisId, refId]));
  const kindOf = new Map(his.nodes.map((node) => [node.id, node.kind]));
  const labelOf = new Map(his.nodes.map((node) => [node.id, node.label]));
  const refText = new Map(ref.nodes.map((node) => [node.id, node.text]));
  // One reference node per prompt term (exact first), so «Lithosphere» does not also claim «Rigid lithospheric plates».
  const termIds = new Set(
    matchTerms(
      promptTerms,
      ref.nodes.map((node) => ({ id: node.id, label: node.text })),
    ).flatMap((row) => (row.node ? [row.node.id] : [])),
  );
  const tierOf = (edge: ReferenceEdge): LinkTier =>
    promptTerms.length === 0 || (termIds.has(edge.from) && (termIds.has(edge.to) || isDefinitionLabel(edge.label)))
      ? 'core'
      : 'enrichment';
  const used = new Set<number>();
  const covered = new Map<string, string>();
  const counts: DiffCounts = {
    core: 0,
    matched: 0,
    needLabel: 0,
    reworded: 0,
    defDiffers: 0,
    coreMissing: 0,
    ideas: 0,
    extra: 0,
  };
  const classified = new Map<number, EdgeDiff>();
  const absent: EdgeDiff[] = [];
  const tally = (tier: LinkTier, bump: (c: DiffCounts) => void) => {
    if (tier === 'core') bump(counts);
  };
  /** His definition notes hanging off his concept (either arrow direction), with the edge index. */
  const notesOf = (hisId: string) =>
    his.edges
      .map((edge, index) => ({
        edge,
        index,
        note: edge.from === hisId ? edge.to : edge.to === hisId ? edge.from : null,
      }))
      .filter((row): row is { edge: MapGraphEdge; index: number; note: string } =>
        Boolean(row.note && kindOf.get(row.note) === 'note'),
      );
  const base = (refEdge: ReferenceEdge, tier: LinkTier) => ({
    refLabel: refEdge.label?.trim() || null,
    refFrom: refEdge.from,
    refTo: refEdge.to,
    tier,
    reversed: false,
    defDiffers: false,
  });

  for (const refEdge of ref.edges) {
    const tier = tierOf(refEdge);
    const from = refToHis.get(refEdge.from);
    const to = refToHis.get(refEdge.to);

    if (tier === 'core') counts.core++;

    // A prompt term's definition: his dotted note on that concept answers it.
    if (from && !to && termIds.has(refEdge.from) && isDefinitionLabel(refEdge.label)) {
      const notes = notesOf(from);
      const hit = notes.find((row) => descriptionsOverlap(labelOf.get(row.note) ?? '', refText.get(refEdge.to) ?? ''));

      if (hit) {
        tally(tier, (c) => c.matched++);
        covered.set(refEdge.to, hit.note);
        if (!classified.has(hit.index)) {
          used.add(hit.index);
          classified.set(hit.index, {
            ...base(refEdge, tier),
            cls: 'matched',
            from: hit.edge.from,
            to: hit.edge.to,
            hisLabel: hit.edge.label,
          });
        }
        continue;
      }
      const other = notes.find((row) => !classified.has(row.index));

      if (other) {
        tally(tier, (c) => c.defDiffers++);
        used.add(other.index);
        classified.set(other.index, {
          ...base(refEdge, tier),
          cls: 'labelOff',
          defDiffers: true,
          from: other.edge.from,
          to: other.edge.to,
          hisLabel: other.edge.label,
        });
        continue;
      }
    }

    let hit = -1;
    let reversed = false;

    if (from && to) {
      hit = his.edges.findIndex((edge, index) => !used.has(index) && edge.from === from && edge.to === to);
      if (hit < 0) {
        hit = his.edges.findIndex((edge, index) => !used.has(index) && edge.from === to && edge.to === from);
        reversed = hit >= 0;
      }
    }
    if (hit < 0) {
      tally(tier, (c) => c.coreMissing++);
      if (tier === 'enrichment') counts.ideas++;
      absent.push({
        ...base(refEdge, tier),
        cls: tier === 'core' ? 'missing' : 'idea',
        from: from ?? covered.get(refEdge.from) ?? ghostId(refEdge.from),
        to: to ?? covered.get(refEdge.to) ?? ghostId(refEdge.to),
        hisLabel: null,
      });
      continue;
    }
    used.add(hit);
    const hisEdge = his.edges[hit]!;
    const refLabel = refEdge.label?.trim() || null;
    const good =
      !reversed && hisEdge.label !== null && (refLabel === null || labelsCompatible(hisEdge.label, refLabel));

    if (good) tally(tier, (c) => c.matched++);
    else if (hisEdge.label === null && !reversed) tally(tier, (c) => c.needLabel++);
    else tally(tier, (c) => c.reworded++);
    classified.set(hit, {
      ...base(refEdge, tier),
      cls: good ? 'matched' : 'labelOff',
      reversed,
      from: hisEdge.from,
      to: hisEdge.to,
      hisLabel: hisEdge.label,
    });
  }
  const edges: EdgeDiff[] = his.edges.map((edge, index) => {
    const known = classified.get(index);

    if (known) return known;
    const definition = kindOf.get(edge.from) === 'note' || kindOf.get(edge.to) === 'note';

    if (!definition) counts.extra++;

    return {
      cls: definition ? 'definition' : 'extra',
      from: edge.from,
      to: edge.to,
      hisLabel: edge.label,
      refLabel: null,
      reversed: false,
      defDiffers: false,
      refFrom: null,
      refTo: null,
      tier: null,
    };
  });

  edges.push(...absent);

  const absentTerms = matchTerms(
    promptTerms,
    his.nodes.map((node) => ({ id: node.id, label: node.label, kind: node.kind })),
  )
    .filter((row) => !row.node)
    .map((row) => row.term);
  const absentRefIds = new Set<string>();
  const strayTerms: string[] = [];

  for (const term of absentTerms) {
    const refNode = ref.nodes.find((node) => !refToHis.has(node.id) && termMatches(term, node.text));

    if (refNode) absentRefIds.add(refNode.id);
    else strayTerms.push(term);
  }
  // Ghosts only for reference concepts an absent link (or an absent prompt term) needs; red when a
  // core link or a prompt term needs it, faint otherwise.
  const ghostNeed = new Map<string, 'core' | 'idea'>();

  for (const edge of absent)
    for (const end of [edge.refFrom!, edge.refTo!])
      if (!refToHis.has(end) && !covered.has(end))
        ghostNeed.set(end, edge.cls === 'missing' || ghostNeed.get(end) === 'core' ? 'core' : 'idea');
  for (const id of absentRefIds) ghostNeed.set(id, 'core');
  const nodes: DiffNode[] = [
    ...his.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      cls: (hisToRef.has(node.id) ? 'matched' : node.kind === 'note' ? 'note' : 'extra') as DiffNodeClass,
      absentTerm: false,
      refId: hisToRef.get(node.id) ?? null,
    })),
    ...ref.nodes
      .filter((node) => ghostNeed.has(node.id))
      .map((node) => ({
        id: ghostId(node.id),
        label: node.text,
        cls: (ghostNeed.get(node.id) === 'core' ? 'ghost' : 'idea') as DiffNodeClass,
        absentTerm: absentRefIds.has(node.id),
        refId: node.id,
      })),
    ...strayTerms.map((term, index) => ({
      id: `term:${index}`,
      label: term,
      cls: 'ghost' as const,
      absentTerm: true,
      refId: null,
    })),
  ];

  return { nodes, edges, refToHis, hisToRef, covered, absentTerms, counts };
}

/** The overlay as drawable graph data, with each link's chip text. */
export function overlayGraph(diff: MapDiff): { nodes: ReferenceNode[]; edges: ReferenceEdge[] } {
  return {
    nodes: diff.nodes.map((node) => ({ id: node.id, text: node.label })),
    edges: diff.edges.map((edge) => {
      const label =
        edge.cls === 'labelOff'
          ? edge.defDiffers
            ? 'definition differs'
            : edge.reversed
              ? `reversed · ${edge.refLabel ?? ''}`
              : edge.hisLabel === null
                ? `add «${edge.refLabel ?? 'a linking phrase'}»`
                : `${edge.hisLabel} → ${edge.refLabel ?? '—'}`
          : edge.cls === 'missing' || edge.cls === 'idea'
            ? edge.refLabel
            : edge.hisLabel;

      return label ? { from: edge.from, to: edge.to, label } : { from: edge.from, to: edge.to };
    }),
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** «Core: 2/5 links · 1 needs a label · 1 core missing». */
export function summarizeDiff(counts: DiffCounts): string {
  const parts = [`Core: ${counts.matched}/${counts.core} links`];

  if (counts.needLabel) parts.push(plural(counts.needLabel, 'needs a label', 'need a label'));
  if (counts.reworded) parts.push(`${counts.reworded} worded differently`);
  if (counts.defDiffers) parts.push(plural(counts.defDiffers, 'definition differs', 'definitions differ'));
  if (counts.coreMissing) parts.push(`${counts.coreMissing} core missing`);

  return parts.join(' · ');
}

/** «+12 ideas you could add · 2 links of your own» — never part of the score. */
export function summarizeExtras(counts: DiffCounts): string | null {
  const parts: string[] = [];

  if (counts.ideas) parts.push(`+${plural(counts.ideas, 'idea', 'ideas')} you could add`);
  if (counts.extra) parts.push(plural(counts.extra, 'link of your own', 'links of your own'));

  return parts.length ? parts.join(' · ') : null;
}

/** His node ids for a grader comment's `from` / `to` labels (null when either is not on his map). */
export function locateWrongLink(his: MapGraph, link: WrongLink): { from: string; to: string } | null {
  const find = (label: string) =>
    his.nodes.find((node) => normalizeTerm(node.label) === normalizeTerm(label)) ??
    his.nodes.find((node) => termMatches(label, node.label) || termMatches(node.label, label));
  const from = find(link.from);
  const to = find(link.to);

  return from && to ? { from: from.id, to: to.id } : null;
}
