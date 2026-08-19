import { diffLines, diffWordsWithSpace } from 'diff';

/**
 * Line-level diff with word-level detail.
 *
 * Returns an array of rows:
 *   { type: 'context', oldNo, newNo, content }
 *   { type: 'add',            newNo, content }
 *   { type: 'del',     oldNo,        content }
 *   { type: 'mod',     oldNo, newNo, content, oldContent, segments }
 *
 * A removed line immediately followed by an added line is paired as a
 * single "modified" row when the two lines are similar enough, and the
 * word-level changes inside it are captured in `segments`
 * ([{ value, added?, removed? }, …]).
 */
export function computeLineDiff(oldText, newText) {
  const parts = diffLines(normalize(oldText), normalize(newText));
  const rows = [];
  let oldNo = 1;
  let newNo = 1;
  let i = 0;

  while (i < parts.length) {
    const part = parts[i];
    const lines = splitLines(part.value);

    if (!part.added && !part.removed) {
      for (const line of lines) {
        rows.push({ type: 'context', oldNo: oldNo++, newNo: newNo++, content: line });
      }
      i += 1;
    } else if (part.removed && parts[i + 1]?.added) {
      const delLines = lines;
      const addLines = splitLines(parts[i + 1].value);
      pairChangedLines(rows, delLines, addLines, () => oldNo++, () => newNo++);
      i += 2;
    } else if (part.removed) {
      for (const line of lines) {
        rows.push({ type: 'del', oldNo: oldNo++, content: line });
      }
      i += 1;
    } else {
      for (const line of lines) {
        rows.push({ type: 'add', newNo: newNo++, content: line });
      }
      i += 1;
    }
  }

  return rows;
}

/**
 * Pair up removed/added lines. Similar lines become a "mod" row with
 * word-level segments; dissimilar lines stay separate del/add rows.
 * Pairing is greedy and in order, which reads naturally for prose edits.
 */
function pairChangedLines(rows, delLines, addLines, nextOldNo, nextNewNo) {
  const n = Math.min(delLines.length, addLines.length);
  let paired = 0;

  for (let k = 0; k < n; k++) {
    if (similarity(delLines[k], addLines[k]) < 0.34) break;
    paired = k + 1;
  }

  for (let k = 0; k < paired; k++) {
    rows.push({
      type: 'mod',
      oldNo: nextOldNo(),
      newNo: nextNewNo(),
      oldContent: delLines[k],
      content: addLines[k],
      segments: diffWordsWithSpace(delLines[k], addLines[k]),
    });
  }
  for (let k = paired; k < delLines.length; k++) {
    rows.push({ type: 'del', oldNo: nextOldNo(), content: delLines[k] });
  }
  for (let k = paired; k < addLines.length; k++) {
    rows.push({ type: 'add', newNo: nextNewNo(), content: addLines[k] });
  }
}

/** Rough similarity in [0,1]: share of characters sitting in unchanged word-diff segments. */
function similarity(a, b) {
  if (a === b) return 1;
  if (!a.trim() && !b.trim()) return 1;
  const total = Math.max(a.length, b.length);
  if (total === 0) return 1;
  let common = 0;
  for (const seg of diffWordsWithSpace(a, b)) {
    if (!seg.added && !seg.removed) common += seg.value.length;
  }
  return common / total;
}

export function diffStats(rows) {
  const stats = { add: 0, del: 0, mod: 0, context: 0 };
  for (const row of rows) stats[row.type] += 1;
  stats.total = stats.add + stats.del + stats.mod;
  return stats;
}

/**
 * Group rows for display, collapsing long unchanged runs.
 * Returns items: { kind: 'rows', rows } | { kind: 'collapsed', rows }
 * Keeps `margin` context lines visible around each change.
 */
export function collapseContext(rows, { margin = 3, minCollapse = 8 } = {}) {
  const items = [];
  let run = [];

  const flushRun = (isLast) => {
    if (run.length === 0) return;
    const lead = items.length === 0 ? 0 : margin;
    const tail = isLast ? 0 : margin;
    if (run.length >= minCollapse + lead + tail) {
      if (lead) pushRows(items, run.slice(0, lead));
      items.push({ kind: 'collapsed', rows: run.slice(lead, run.length - tail) });
      if (tail) pushRows(items, run.slice(run.length - tail));
    } else {
      pushRows(items, run);
    }
    run = [];
  };

  for (const row of rows) {
    if (row.type === 'context') {
      run.push(row);
    } else {
      flushRun(false);
      pushRows(items, [row]);
    }
  }
  flushRun(true);
  return items;
}

function pushRows(items, rows) {
  const last = items[items.length - 1];
  if (last?.kind === 'rows') last.rows.push(...rows);
  else items.push({ kind: 'rows', rows: [...rows] });
}

function normalize(text) {
  return (text ?? '').replace(/\r\n/g, '\n');
}

function splitLines(value) {
  const lines = value.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
