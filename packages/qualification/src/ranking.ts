/**
 * Deterministic candidate ranking.
 *
 * Ranking is where a router is most tempted to invent something. A score has to
 * come from somewhere, and if no evidence supplies one it is very easy to reach
 * for parameter count, recency, or "the one we usually use" and present the
 * result as a judgement. This module does not do that.
 *
 * It ranks on exactly three things, in order:
 *
 *   1. Qualified before unqualified. This is a fact about imported evidence,
 *      not an opinion.
 *   2. Where *both* candidates are qualified, the measured values behind those
 *      qualifications — pass rate, then mean score, then sample count. These
 *      are Luak's numbers, compared, never synthesised.
 *   3. Model id, ascending. A tiebreak and nothing more.
 *
 * Step 3 is the important one to be honest about: when nothing is qualified —
 * which is every case today — ranking collapses entirely to alphabetical order
 * by identity. That is not a fitness ordering and must never be reported as
 * one. Its only job is to make the result independent of catalog order, so that
 * reordering `artifacts.json` cannot change which model answers a request.
 *
 * Nothing here reads a model's name for meaning. There is no allowlist, no
 * family detection, no special case: a candidate called `qwen3.5-35b-a3b.q2-k`
 * is ordered by the same rules as one called `aardvark`.
 */
import type { QualificationDecision } from '@bokahli/contracts';

export interface RankableCandidate {
  readonly modelId: string;
  readonly decision: QualificationDecision;
  /** Evidence-derived values, present only where evidence supplied them. */
  readonly passRate: number | null;
  readonly meanScore: number | null;
  readonly sampleCount: number | null;
}

export interface RankedCandidate extends RankableCandidate {
  readonly rank: number;
  /** Which comparison decided this candidate's place. For audit, not display. */
  readonly rankBasis: RankBasis;
}

export type RankBasis =
  /** Ordered above unqualified candidates because evidence qualifies it. */
  | 'QUALIFICATION'
  /** Ordered against another qualified candidate by measured pass rate. */
  | 'MEASURED_PASS_RATE'
  /** Ordered against another qualified candidate by measured mean score. */
  | 'MEASURED_MEAN_SCORE'
  /** Ordered against another qualified candidate by sample count. */
  | 'SAMPLE_COUNT'
  /**
   * Ordered only by identity. No evidence distinguished these candidates and
   * none is claimed to be better than another.
   */
  | 'IDENTITY_TIEBREAK';

/**
 * Rank candidates. Stable and total: the same input always produces the same
 * output, and no two candidates can compare equal because model ids are unique.
 */
export function rankCandidates(candidates: readonly RankableCandidate[]): readonly RankedCandidate[] {
  const sorted = [...candidates].sort(compare);
  return sorted.map((c, i) => ({
    ...c,
    rank: i + 1,
    rankBasis: basisAgainstNeighbour(c, sorted[i + 1] ?? sorted[i - 1] ?? null),
  }));
}

function compare(a: RankableCandidate, b: RankableCandidate): number {
  if (a.decision.qualified !== b.decision.qualified) return a.decision.qualified ? -1 : 1;

  // Measured values are only comparable between two qualified candidates.
  // Comparing them across an unqualified one would let a high score on
  // insufficient evidence outrank a verdict that actually passed policy.
  if (a.decision.qualified && b.decision.qualified) {
    const byPass = compareDesc(a.passRate, b.passRate);
    if (byPass !== 0) return byPass;
    const byScore = compareDesc(a.meanScore, b.meanScore);
    if (byScore !== 0) return byScore;
    const bySamples = compareDesc(a.sampleCount, b.sampleCount);
    if (bySamples !== 0) return bySamples;
  }

  return a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0;
}

/** Higher is better; a null is never treated as a value and never wins. */
function compareDesc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

function basisAgainstNeighbour(c: RankableCandidate, other: RankableCandidate | null): RankBasis {
  if (!other || other === c) return c.decision.qualified ? 'QUALIFICATION' : 'IDENTITY_TIEBREAK';
  if (c.decision.qualified !== other.decision.qualified) return 'QUALIFICATION';
  if (c.decision.qualified && other.decision.qualified) {
    if (compareDesc(c.passRate, other.passRate) !== 0) return 'MEASURED_PASS_RATE';
    if (compareDesc(c.meanScore, other.meanScore) !== 0) return 'MEASURED_MEAN_SCORE';
    if (compareDesc(c.sampleCount, other.sampleCount) !== 0) return 'SAMPLE_COUNT';
  }
  return 'IDENTITY_TIEBREAK';
}
