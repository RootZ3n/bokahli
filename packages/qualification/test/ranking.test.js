/**
 * Deterministic ranking.
 *
 * Two properties matter here and they pull in different directions. Ranking has
 * to be *stable* — the same inputs must always give the same answer, whatever
 * order the catalog happens to list artifacts in — and it has to be *honest*,
 * meaning it must not manufacture an ordering that looks like a fitness
 * judgement when no evidence supports one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankCandidates } from '../dist/ranking.js';

function candidate(modelId, opts = {}) {
  return {
    modelId,
    decision: {
      qualified: opts.qualified ?? false,
      reason: opts.qualified ? 'QUALIFIED' : 'MODEL_NOT_QUALIFIED_FOR_TASK',
      taskClass: 'test_log_triage',
      key: null,
      shortfalls: [],
      evidenceHash: null,
      evidenceGeneratedAt: null,
      authority: opts.qualified ? 'luak' : 'none',
      detail: '',
    },
    passRate: opts.passRate ?? null,
    meanScore: opts.meanScore ?? null,
    sampleCount: opts.sampleCount ?? null,
  };
}

const permutations = (xs) =>
  xs.length <= 1
    ? [xs]
    : xs.flatMap((x, i) =>
        permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]),
      );

test('order is independent of the order candidates arrive in', () => {
  const input = [
    candidate('zebra', { qualified: true, passRate: 0.9, sampleCount: 10 }),
    candidate('alpha', { qualified: true, passRate: 0.95, sampleCount: 10 }),
    candidate('mango'),
  ];
  const expected = rankCandidates(input).map((c) => c.modelId);
  for (const perm of permutations(input)) {
    assert.deepEqual(rankCandidates(perm).map((c) => c.modelId), expected);
  }
  // Highest measured pass rate first, then the other qualified one, then the
  // unqualified candidate — never on account of its name.
  assert.deepEqual(expected, ['alpha', 'zebra', 'mango']);
});

test('qualified candidates outrank unqualified ones regardless of name', () => {
  const ranked = rankCandidates([
    candidate('aaa-unqualified'),
    candidate('zzz-qualified', { qualified: true, passRate: 0.5 }),
  ]);
  assert.equal(ranked[0].modelId, 'zzz-qualified');
  assert.equal(ranked[0].rankBasis, 'QUALIFICATION');
});

test('a high score on unqualified evidence never outranks a qualified candidate', () => {
  // The point of policy is that a number alone is not permission.
  const ranked = rankCandidates([
    candidate('flashy', { qualified: false, passRate: 1, meanScore: 1, sampleCount: 1 }),
    candidate('proven', { qualified: true, passRate: 0.6, meanScore: 0.6, sampleCount: 50 }),
  ]);
  assert.equal(ranked[0].modelId, 'proven');
});

test('with nothing qualified, order is identity alone and says so', () => {
  const ranked = rankCandidates([candidate('beta'), candidate('alpha'), candidate('gamma')]);
  assert.deepEqual(ranked.map((c) => c.modelId), ['alpha', 'beta', 'gamma']);
  for (const c of ranked) {
    assert.equal(
      c.rankBasis,
      'IDENTITY_TIEBREAK',
      'alphabetical order must never be reported as a fitness judgement',
    );
  }
});

test('measured values break ties between qualified candidates, in a stated order', () => {
  const byPass = rankCandidates([
    candidate('a', { qualified: true, passRate: 0.8, meanScore: 0.99 }),
    candidate('b', { qualified: true, passRate: 0.9, meanScore: 0.1 }),
  ]);
  assert.equal(byPass[0].modelId, 'b');
  assert.equal(byPass[0].rankBasis, 'MEASURED_PASS_RATE');

  const byScore = rankCandidates([
    candidate('a', { qualified: true, passRate: 0.9, meanScore: 0.5 }),
    candidate('b', { qualified: true, passRate: 0.9, meanScore: 0.7 }),
  ]);
  assert.equal(byScore[0].modelId, 'b');
  assert.equal(byScore[0].rankBasis, 'MEASURED_MEAN_SCORE');

  const bySamples = rankCandidates([
    candidate('a', { qualified: true, passRate: 0.9, meanScore: 0.9, sampleCount: 5 }),
    candidate('b', { qualified: true, passRate: 0.9, meanScore: 0.9, sampleCount: 50 }),
  ]);
  assert.equal(bySamples[0].modelId, 'b');
  assert.equal(bySamples[0].rankBasis, 'SAMPLE_COUNT');
});

test('an unmeasured value never wins a comparison', () => {
  const ranked = rankCandidates([
    candidate('unmeasured', { qualified: true, passRate: null }),
    candidate('measured', { qualified: true, passRate: 0.1 }),
  ]);
  assert.equal(ranked[0].modelId, 'measured');
});

test('ranking reads no meaning from a model name', () => {
  // Nothing about a name may influence order beyond the alphabetical tiebreak:
  // no family detection, no allowlist, no "the one we usually use".
  const names = ['qwen3.5-35b-a3b.q2-k', 'llama4-70b.q8', 'aardvark', 'gpt-9'];
  const ranked = rankCandidates(names.map((n) => candidate(n))).map((c) => c.modelId);
  assert.deepEqual(ranked, [...names].sort());
});

test('ranking is total: every candidate gets a distinct rank', () => {
  const ranked = rankCandidates([candidate('a'), candidate('b'), candidate('c')]);
  assert.deepEqual(ranked.map((c) => c.rank), [1, 2, 3]);
});

test('a single candidate is ranked without inventing a comparison', () => {
  const ranked = rankCandidates([candidate('only')]);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[0].rankBasis, 'IDENTITY_TIEBREAK');
});

test('an empty candidate set ranks to nothing', () => {
  assert.deepEqual(rankCandidates([]), []);
});
