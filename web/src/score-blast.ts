// The anchor that lays an uploaded score on the song, BLAST-like. The score is the source of everything shown and
// played; the song's stems only tell where it is. The score, unfolded as played (musicxml.ts unrollRepeats), is a
// sequence of measures; the song, its stems cut into bars on the drum grid, a sequence of beats. Laying the score's
// measures one after another from some beat of the song is one diagonal of the two sequences; along it each measure
// meets the song's beats it would be played over.
//
// - Scoring: how alike a measure and the song are where it would be played (0 to 1, from their chords, notes and
//   rhythm, given by the caller), less the background (BACKGROUND share of all such pairs score lower), so a measure
//   only as alike as chance scores below zero, like a substitution matrix.
// - The anchor (BLAST's high-scoring pair): along each diagonal, the stretch of measures with the highest total
//   (ungapped extension, as far as it pays: a few unlike measures inside a passage that is alike around them are
//   kept). Neither the score's start nor its end has to be in it. The best stretch of all is the anchor, if it scores
//   at least MIN_ANCHOR_PAIRS good measures' margin; of stretches as good, the longest, then the one from the score's
//   earlier measures.
// - The measures before and after the anchor are not matched: they go on, in the score's order, on the song's beats
//   before and after it (the caller lays them; their times are estimated, not synced).
// Pure functions only, so they can be unit-tested.

// The version of the laying, kept in each result laid (fromScore.engine): a result laid by an earlier one is laid
// again when its score check is opened. Raise it when the laying changes what is laid.
export const SCORE_ENGINE = 4;

export const BACKGROUND = 0.75;
const MIN_ANCHOR_PAIRS = 1.6;
const MARGIN = 0.1, LEAST = 0.4;

export interface Anchor {
  offset: number;                         // The song beat the score's first quarter is laid on (may be below zero).
  from: number; to: number;               // The measures (as played, both included) synced with the song.
  score: number; threshold: number;
}

function quantile(values: number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] : 0;
}

// offsets: the diagonals tried (song beats for the score's first quarter); similarity(measure, offset): how alike the
// measure is with the song laid from that offset, or null where it would fall outside the song's beats.
export function findAnchor(measures: number, offsets: number[], similarity: (measure: number, offset: number) => number | null): Anchor | null {
  const table = offsets.map(offset => Array.from({ length: measures }, (_, measure) => similarity(measure, offset)));
  const all = table.flatMap(row => row.filter((value): value is number => value !== null));
  if (!all.length) return null;
  // A song whose bars are all alike (a steady groove) still matches: the background stays MARGIN under the best.
  const best = quantile(all, 0.98);
  // and a measure less alike than LEAST never scores.
  const threshold = Math.max(LEAST, Math.min(quantile(all, BACKGROUND), best - MARGIN));
  const minimum = Math.max(1e-6, MIN_ANCHOR_PAIRS * (best - threshold));
  let anchor: Anchor | null = null;
  offsets.forEach((offset, row) => {
    // The best-scoring stretch along this diagonal (Kadane); a measure outside the song breaks it.
    let total = 0, from = 0;
    table[row].forEach((value, measure) => {
      if (value === null) { total = 0; from = measure + 1; return; }
      if (total <= 0) { total = 0; from = measure; }
      total += value - threshold;
      // As good: the longer, then the one from the score's earlier measures (bars all alike fit anywhere).
      const tie = !!anchor && Math.abs(total - anchor.score) <= 1e-9;
      const better = !anchor || total > anchor.score + 1e-9
        || (tie && (measure - from > anchor.to - anchor.from || (measure - from === anchor.to - anchor.from && from < anchor.from)));
      if (total >= minimum && better) anchor = { offset, from, to: measure, score: total, threshold };
    });
  });
  return anchor;
}
