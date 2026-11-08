/**
 * Minimal source-map lookup (no dependency): (generated line, column) → original source path.
 * Handles plain v3 maps and Turbopack's index maps (`sections`).
 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGIT = Object.fromEntries([...B64].map((c, i) => [c, i]));

function decodeMappings(mappings) {
  // lines[genLine] = sorted [genCol, sourceIndex][]
  const lines = [];
  let src = 0;

  for (const line of mappings.split(';')) {
    const segs = [];
    let col = 0;

    for (const seg of line.split(',')) {
      if (!seg) continue;
      const vals = [];
      let v = 0;
      let shift = 0;

      for (const ch of seg) {
        const d = DIGIT[ch];

        v += (d & 31) << shift;
        if (d & 32) shift += 5;
        else {
          vals.push(v & 1 ? -(v >>> 1) : v >>> 1);
          v = 0;
          shift = 0;
        }
      }
      col += vals[0];
      if (vals.length > 1) {
        src += vals[1];
        segs.push([col, src]);
      }
    }
    lines.push(segs);
  }

  return lines;
}

function plain(map) {
  const lines = decodeMappings(map.mappings);

  return (line, col) => {
    const segs = lines[line];

    if (!segs || !segs.length) return null;
    let lo = 0;
    let hi = segs.length - 1;
    let best = -1;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;

      if (segs[mid][0] <= col) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }

    return best < 0 ? null : (map.sources[segs[best][1]] ?? null);
  };
}

/** Returns lookup(line0, col0) → source path | null. */
export function loadSourceMap(map) {
  if (!map.sections) return plain(map);
  const sections = map.sections.map((s) => ({ line: s.offset.line, col: s.offset.column, look: plain(s.map) }));

  return (line, col) => {
    let sec = null;

    for (const s of sections) {
      if (s.line < line || (s.line === line && s.col <= col)) sec = s;
      else break;
    }
    if (!sec) return null;

    return sec.look(line - sec.line, sec.line === line ? col - sec.col : col);
  };
}
