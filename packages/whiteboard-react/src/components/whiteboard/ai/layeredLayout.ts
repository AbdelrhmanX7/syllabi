// Layered (Sugiyama-style) layout of a labelled graph, size-agnostic: every node and linking-phrase
// chip comes in with its MEASURED box, and nothing is ever placed on anything else. Cycles broken,
// longest-path ranks, an extra layer between ranks that holds each edge's phrase chip (so a phrase
// never sits on a box or on another phrase), dummy points for long edges (so a link never runs
// through a box it does not connect), barycenter ordering sweeps, then x positions pulled toward
// neighbours under a no-overlap constraint (pool-adjacent-violators).
//
// One engine for both drawings of a concept map: the study app's SVG viewer (`layoutDiagram`, boxes
// from typeset text) and the board's hand-drawn map (`planHandConceptMap`, boxes round written
// ellipses). Pure and deterministic — unit-tested in both places.

export interface LayeredNodeInput {
  id: string;
  w: number;
  h: number;
}

export interface LayeredEdgeInput {
  from: string;
  to: string;
  /** The linking phrase's chip, or null for an unlabelled link. */
  label: { w: number; h: number } | null;
}

export interface LayeredOptions {
  /** Vertical gap between consecutive layers (node layer ↔ phrase layer). */
  layerGap: number;
  /** Horizontal gap between two nodes in a layer. */
  nodeGap: number;
  /** …between a node and an edge point / phrase chip. */
  mixedGap: number;
  /** …between two edge points / phrase chips. */
  pointGap: number;
  /** Margin round the whole drawing. */
  padding: number;
  /** Share of a box's bottom / top border the edge ports spread along. */
  portSpread?: number;
  /** Width a bend point (a long link passing through a layer) takes up. Default 2. */
  pointWidth?: number;
  /** Vertical distance between two links' own horizontal runs in the same gap. Default `pointGap`. */
  channelGap?: number;
}

export interface LayeredNode {
  id: string;
  rank: number;
  /** A root: nothing points at it, it points at something. */
  root: boolean;
  /** Top-left. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayeredEdge {
  /** Index into the input `edges`. */
  index: number;
  from: string;
  to: string;
  /** The phrase chip (top-left box), centred on the edge's course. */
  labelBox: { x: number; y: number; w: number; h: number } | null;
  /**
   * From the `from` box border to the `to` box border, through the dummy points. Vertical through
   * every in-between layer, so bends happen only in the gaps between layers.
   */
  points: [number, number][];
  /** The drawing direction was flipped to break a cycle (points still run from → to). */
  reversed: boolean;
}

export interface LayeredLayout {
  width: number;
  height: number;
  nodes: LayeredNode[];
  /** One per valid input edge (both ends known, not a self-loop), in input order. */
  edges: LayeredEdge[];
}

interface Slot {
  /** Node id, or `null` for an edge point. */
  id: string | null;
  edge: number;
  w: number;
  h: number;
  x: number;
  layer: number;
}

/** Number of crossings between two adjacent layers' links, given each slot's order index. */
function crossings(links: [number, number][]): number {
  let count = 0;

  for (let i = 0; i < links.length; i++)
    for (let j = i + 1; j < links.length; j++) {
      const [a1, b1] = links[i]!;
      const [a2, b2] = links[j]!;

      if ((a1 - a2) * (b1 - b2) < 0) count++;
    }

  return count;
}

/**
 * Positions closest (least squares) to `desired` with x[i+1] − x[i] ≥ sep[i] — pool-adjacent-
 * violators on the separation-shifted targets.
 */
export function placeInOrder(desired: number[], sep: number[]): number[] {
  const offset: number[] = [0];

  for (let i = 1; i < desired.length; i++) offset.push(offset[i - 1]! + sep[i - 1]!);
  const blocks: { sum: number; count: number }[] = [];

  desired.forEach((value, i) => {
    blocks.push({ sum: value - offset[i]!, count: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1]!;
      const prev = blocks[blocks.length - 2]!;

      if (prev.sum / prev.count <= last.sum / last.count) break;
      prev.sum += last.sum;
      prev.count += last.count;
      blocks.pop();
    }
  });
  const out: number[] = [];

  for (const block of blocks) for (let k = 0; k < block.count; k++) out.push(block.sum / block.count);

  return out.map((value, i) => value + offset[i]!);
}

export function layeredLayout(nodes: LayeredNodeInput[], edges: LayeredEdgeInput[], opt: LayeredOptions): LayeredLayout {
  const ids = new Map(nodes.map((node, index) => [node.id, index]));
  const validIndex: number[] = [];

  edges.forEach((edge, index) => {
    if (ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to) validIndex.push(index);
  });
  const valid = validIndex.map((index) => edges[index]!);

  if (nodes.length === 0) return { width: opt.padding * 2, height: opt.padding * 2, nodes: [], edges: [] };

  // 1. Break cycles: DFS from the sources (then anything left) in input order; back edges flip.
  const out = new Map<string, number[]>();
  const indeg = new Map<string, number>();

  valid.forEach((edge, index) => {
    out.set(edge.from, [...(out.get(edge.from) ?? []), index]);
    indeg.set(edge.to, (indeg.get(edge.to) ?? 0) + 1);
  });
  const reversed = new Set<number>();
  const state = new Map<string, 1 | 2>();
  const dfsOrder: string[] = [];
  const visit = (start: string) => {
    const stack: [string, number][] = [[start, 0]];

    state.set(start, 1);
    dfsOrder.push(start);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const list = out.get(top[0]) ?? [];

      if (top[1] >= list.length) {
        state.set(top[0], 2);
        stack.pop();
        continue;
      }
      const index = list[top[1]++]!;
      const next = valid[index]!.to;
      const seen = state.get(next);

      if (seen === 1) reversed.add(index);
      else if (!seen) {
        state.set(next, 1);
        dfsOrder.push(next);
        stack.push([next, 0]);
      }
    }
  };

  for (const node of nodes) if (!indeg.get(node.id) && out.has(node.id) && !state.has(node.id)) visit(node.id);
  for (const node of nodes) if (!state.has(node.id)) visit(node.id);
  const dag = valid.map((edge, index) => (reversed.has(index) ? { from: edge.to, to: edge.from } : { from: edge.from, to: edge.to }));

  // 2. Longest-path ranks; a source sits just above its highest child; isolated nodes go last.
  const rank = new Map<string, number>();
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();

  for (const edge of dag) {
    preds.set(edge.to, [...(preds.get(edge.to) ?? []), edge.from]);
    succs.set(edge.from, [...(succs.get(edge.from) ?? []), edge.to]);
  }
  const rankOf = (id: string): number => {
    const known = rank.get(id);

    if (known !== undefined) return known;
    const value = Math.max(-1, ...(preds.get(id) ?? []).map(rankOf)) + 1;

    rank.set(id, value);

    return value;
  };

  for (const node of nodes) rankOf(node.id);
  for (const node of nodes) {
    const children = succs.get(node.id);

    if (!preds.has(node.id) && children) rank.set(node.id, Math.min(...children.map((id) => rank.get(id)!)) - 1);
  }
  const connected = (id: string) => preds.has(id) || succs.has(id);
  const deepest = Math.max(0, ...nodes.filter((node) => connected(node.id)).map((node) => rank.get(node.id)!));

  for (const node of nodes) if (!connected(node.id)) rank.set(node.id, valid.length ? deepest + 1 : 0);

  // 3. Slots per layer: nodes on even layers, edge points (phrase chip or bend) on odd/between.
  const size = new Map(nodes.map((node) => [node.id, node]));
  const layerCount = Math.max(...nodes.map((node) => rank.get(node.id)! * 2)) + 1;
  const layers: Slot[][] = Array.from({ length: layerCount }, () => []);
  const slotOf = new Map<string, Slot>();
  // Initial order: DFS discovery (keeps a parent's children together), then input order.
  const discovery = new Map(dfsOrder.map((id, index) => [id, index]));

  for (const node of [...nodes].sort((a, b) => discovery.get(a.id)! - discovery.get(b.id)!)) {
    const layer = rank.get(node.id)! * 2;
    const slot: Slot = { id: node.id, edge: -1, w: size.get(node.id)!.w, h: size.get(node.id)!.h, x: 0, layer };

    layers[layer]!.push(slot);
    slotOf.set(node.id, slot);
  }
  // Each edge's chain of slots, top to bottom.
  const chains: Slot[][] = dag.map((edge, index) => {
    const top = slotOf.get(edge.from)!;
    const bottom = slotOf.get(edge.to)!;
    const chain: Slot[] = [top];
    const label = valid[index]!.label;

    for (let layer = top.layer + 1; layer < bottom.layer; layer++) {
      const isLabel = layer === top.layer + 1 && label !== null;
      const slot: Slot = { id: null, edge: index, w: isLabel ? label.w : (opt.pointWidth ?? 2), h: isLabel ? label.h : 0, x: 0, layer };

      layers[layer]!.push(slot);
      chain.push(slot);
    }
    chain.push(bottom);

    return chain;
  });

  // Links between adjacent layers.
  const up = new Map<Slot, Slot[]>();
  const down = new Map<Slot, Slot[]>();

  for (const chain of chains)
    for (let i = 0; i + 1 < chain.length; i++) {
      down.set(chain[i]!, [...(down.get(chain[i]!) ?? []), chain[i + 1]!]);
      up.set(chain[i + 1]!, [...(up.get(chain[i + 1]!) ?? []), chain[i]!]);
    }
  const totalCrossings = () => {
    let total = 0;

    for (let layer = 0; layer + 1 < layers.length; layer++) {
      const below = new Map(layers[layer + 1]!.map((slot, index) => [slot, index]));
      const links: [number, number][] = [];

      layers[layer]!.forEach((slot, index) => {
        for (const next of down.get(slot) ?? []) links.push([index, below.get(next)!]);
      });
      total += crossings(links);
    }

    return total;
  };

  // 4. Barycenter sweeps, keeping the best order seen.
  let best = layers.map((row) => [...row]);
  let bestCrossings = totalCrossings();

  for (let pass = 0; pass < 8 && bestCrossings > 0; pass++) {
    const downward = pass % 2 === 0;
    const order = downward
      ? layers.map((_, i) => i).slice(1)
      : layers
          .map((_, i) => i)
          .reverse()
          .slice(1);

    for (const layer of order) {
      const ref = layers[downward ? layer - 1 : layer + 1]!;
      const position = new Map(ref.map((slot, index) => [slot, index]));
      const row = layers[layer]!;
      const keyed = row.map((slot, index) => {
        const neighbours = (downward ? up : down).get(slot) ?? [];
        const bary = neighbours.length ? neighbours.reduce((sum, other) => sum + position.get(other)!, 0) / neighbours.length : index;

        return { slot, key: bary, index };
      });

      keyed.sort((a, b) => a.key - b.key || a.index - b.index);
      layers[layer] = keyed.map((item) => item.slot);
    }
    const now = totalCrossings();

    if (now < bestCrossings) {
      bestCrossings = now;
      best = layers.map((row) => [...row]);
    }
  }
  for (let layer = 0; layer < layers.length; layer++) layers[layer] = best[layer]!;

  // 5. x: pack, then pull each slot toward its neighbours' centres without overlapping.
  const gapBetween = (a: Slot, b: Slot) =>
    (a.w + b.w) / 2 + (a.id !== null && b.id !== null ? opt.nodeGap : a.id === null && b.id === null ? opt.pointGap : opt.mixedGap);

  for (const row of layers) {
    let x = 0;

    row.forEach((slot, index) => {
      if (index > 0) x += gapBetween(row[index - 1]!, slot);
      slot.x = x;
    });
  }
  for (let pass = 0; pass < 12; pass++) {
    const downward = pass % 2 === 0;
    const order = downward ? layers.map((_, i) => i) : layers.map((_, i) => i).reverse();

    for (const layer of order) {
      const row = layers[layer]!;

      if (row.length === 0) continue;
      const desired = row.map((slot) => {
        const neighbours = pass >= 8 ? [...(up.get(slot) ?? []), ...(down.get(slot) ?? [])] : ((downward ? up : down).get(slot) ?? []);

        return neighbours.length ? neighbours.reduce((sum, other) => sum + other.x, 0) / neighbours.length : slot.x;
      });
      const placed = placeInOrder(
        desired,
        row.slice(1).map((slot, index) => gapBetween(row[index]!, slot)),
      );

      row.forEach((slot, index) => (slot.x = placed[index]!));
    }
  }
  const minX = Math.min(...layers.flat().map((slot) => slot.x - slot.w / 2));
  const maxX = Math.max(...layers.flat().map((slot) => slot.x + slot.w / 2));

  for (const slot of layers.flat()) slot.x += opt.padding - minX;

  // 6. Channels. A link that has to travel sideways between two layers does it on a horizontal run
  // of its own: links whose runs would overlap get different heights in the gap (a bus of shared
  // segments tells nobody which parent a line comes from), ordered to cross each other least.
  const spread = opt.portSpread ?? 0.6;
  const portX = (slot: Slot, toward: Slot, side: 'top' | 'bottom') => {
    const list = side === 'bottom' ? (down.get(slot) ?? []) : (up.get(slot) ?? []);
    const sorted = [...list].sort((a, b) => a.x - b.x);
    const index = sorted.indexOf(toward);
    const usable = slot.w * spread;

    return slot.x - usable / 2 + (usable * (index + 1)) / (sorted.length + 1);
  };
  /** Chain link `i` (slot i → i + 1) of a link: where it leaves and where it arrives, in x. */
  const hop = (chain: Slot[], i: number): [number, number] => [
    i === 0 ? portX(chain[0]!, chain[1]!, 'bottom') : chain[i]!.x,
    i + 2 === chain.length ? portX(chain[i + 1]!, chain[i]!, 'top') : chain[i + 1]!.x,
  ];
  const channelStep = opt.channelGap ?? opt.pointGap;
  // Per gap (between layer g and g + 1): the sideways runs, and the track each one runs on.
  const runs: { edge: number; from: number; to: number; track: number }[][] = layers.map(() => []);

  chains.forEach((chain, edge) => {
    for (let i = 0; i + 1 < chain.length; i++) {
      const [from, to] = hop(chain, i);

      if (Math.abs(from - to) > 0.5) runs[chain[i]!.layer]!.push({ edge, from, to, track: 0 });
    }
  });
  const trackCount: number[] = runs.map((list) => {
    const lo = (run: { from: number; to: number }) => Math.min(run.from, run.to);
    const hi = (run: { from: number; to: number }) => Math.max(run.from, run.to);
    const clash = (a: (typeof list)[number], b: (typeof list)[number]) => lo(a) < hi(b) + channelStep / 2 && lo(b) < hi(a) + channelStep / 2;
    const free = (run: (typeof list)[number], track: number) => !list.some((other) => other !== run && other.track === track && clash(run, other));
    // Lines this one's drops cross: its drop (at `from`) passes the runs above it, its rise (at `to`) those below.
    const cost = (run: (typeof list)[number], track: number) =>
      list.reduce((sum, other) => {
        if (other === run) return sum;
        const inside = (x: number) => x > lo(other) && x < hi(other);

        return sum + (inside(run.from) && other.track < track ? 1 : 0) + (inside(run.to) && other.track > track ? 1 : 0) + (inside(other.from) && track < other.track ? 1 : 0) + (inside(other.to) && track > other.track ? 1 : 0);
      }, 0);

    list.sort((a, b) => lo(a) - lo(b) || a.edge - b.edge);
    list.forEach((run) => {
      run.track = -1;
      let track = 0;

      while (!free(run, track)) track++;
      run.track = track;
    });
    const tracks = list.reduce((max, run) => Math.max(max, run.track + 1), 0);

    for (let pass = 0; pass < 4; pass++) {
      let moved = false;

      for (const run of list)
        for (let track = 0; track < tracks; track++) {
          if (track === run.track || !free(run, track) || cost(run, track) >= cost(run, run.track)) continue;
          run.track = track;
          moved = true;
        }
      if (!moved) break;
    }

    return tracks;
  });
  const runTrack = new Map<string, number>();

  runs.forEach((list, layer) => list.forEach((run) => runTrack.set(`${run.edge}:${layer}`, run.track)));

  // 7. y: each layer as tall as its tallest slot; slots centred in their layer; a gap as tall as its
  // channels need.
  const layerTop: number[] = [];
  const layerHeight: number[] = [];
  const gapHeight = trackCount.map((count) => opt.layerGap + Math.max(0, count - 1) * channelStep);
  let y = opt.padding;

  layers.forEach((row, layer) => {
    const height = Math.max(0, ...row.map((slot) => slot.h));

    layerTop.push(y);
    layerHeight.push(height);
    y += height + (layer + 1 < layers.length ? gapHeight[layer]! : 0);
  });
  const height = y + opt.padding;
  const centreY = (slot: Slot) => layerTop[slot.layer]! + layerHeight[slot.layer]! / 2;
  const laidNodes: LayeredNode[] = nodes.map((node) => {
    const slot = slotOf.get(node.id)!;

    return {
      id: node.id,
      rank: rank.get(node.id)!,
      root: !preds.has(node.id) && succs.has(node.id),
      x: slot.x - slot.w / 2,
      y: centreY(slot) - slot.h / 2,
      w: slot.w,
      h: slot.h,
    };
  });
  const channelY = (layer: number, track: number) => layerTop[layer]! + layerHeight[layer]! + opt.layerGap / 2 + track * channelStep;

  // 8. Edge courses. Ports spread along the box border, ordered by where the edge heads.
  const laidEdges: LayeredEdge[] = valid.map((edge, index) => {
    const chain = chains[index]!;
    const top = chain[0]!;
    const bottom = chain[chain.length - 1]!;
    const points: [number, number][] = [[portX(top, chain[1]!, 'bottom'), centreY(top) + top.h / 2]];

    // Down to the link's channel, along it, down again — straight down through each in-between
    // layer, so bends happen only in the gaps between layers (a course bending inside a layer could
    // clip a neighbouring box).
    for (let i = 0; i + 1 < chain.length; i++) {
      const [from, to] = hop(chain, i);
      const track = runTrack.get(`${index}:${chain[i]!.layer}`);

      if (track !== undefined) points.push([from, channelY(chain[i]!.layer, track)], [to, channelY(chain[i]!.layer, track)]);
      const next = chain[i + 1]!;

      if (i + 2 < chain.length) points.push([next.x, layerTop[next.layer]!], [next.x, layerTop[next.layer]! + layerHeight[next.layer]!]);
      else points.push([to, centreY(bottom) - bottom.h / 2]);
    }
    if (reversed.has(index)) points.reverse();
    const labelSlot = edge.label ? chain[1] : undefined;

    return {
      index: validIndex[index]!,
      from: edge.from,
      to: edge.to,
      labelBox:
        labelSlot && labelSlot.id === null
          ? { x: labelSlot.x - labelSlot.w / 2, y: centreY(labelSlot) - labelSlot.h / 2, w: labelSlot.w, h: labelSlot.h }
          : null,
      points,
      reversed: reversed.has(index),
    };
  });

  return { width: maxX - minX + opt.padding * 2, height, nodes: laidNodes, edges: laidEdges };
}
