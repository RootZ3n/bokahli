#!/usr/bin/env node
/**
 * Aggregate every scored attempt in the campaign into the per-lane table the
 * operator policy is written against.
 *
 * The policy makes claims per task class, and a task class is served by some
 * subset of the scoring lanes: a classification task lives or dies on the
 * `classification` lane, a cited-extraction task on `citation`, and every task
 * on `structured_output` and `injection`. So the unit here is
 * (artifact, suite, regime, lane) — not an overall score, which averages a
 * disqualifying failure into a passing number and hides exactly the thing a
 * qualification decision needs to see.
 *
 * Attribution is kept beside the lane scores rather than folded into them.
 * A run where the harness broke and a run where the model was wrong produce the
 * same low number and mean opposite things, and calling the second one the first
 * raises measured capability by deletion.
 *
 * Later evidence for the same (artifact, suite, regime) supersedes earlier
 * evidence for the same fixture, which is how the IQ3 L2 completion run folds in
 * without either double-counting its fixtures or discarding the partial run that
 * preceded it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.env.HOME, '.local/state/bokahli/campaign');
// Ordered oldest-authority to newest: a later directory wins per fixture.
const DIRS = ['stage-a', 'stage-b', 'stage-a-q9b', 'stage-b-completion'];

const LANES = ['structured_output', 'classification', 'citation', 'facts',
  'coverage', 'abstention', 'injection'];

/**
 * Lanes whose recorded number cannot support a qualification verdict, and why.
 *
 * These are instrument defects found while reading the campaign evidence, not
 * measured deficiencies of any artifact. The distinction matters more than the
 * numbers do: a broken instrument that reads zero looks exactly like a model
 * that failed, and writing "all four artifacts fail classification" into an
 * operator policy would be inventing a finding out of a bug.
 *
 * They are reported as VOID rather than silently dropped. A lane that vanishes
 * from the table is a lane nobody remembers to fix, and a policy that quietly
 * omits a dimension reads as though that dimension passed.
 *
 * None of these are repaired here. The regime is frozen for this campaign, and
 * rewriting a scorer after seeing the answers it produced is how a harness gets
 * tuned into agreeing with whatever it just measured. They are defects to fix in
 * the next regime version, against fixtures, before it scores anything.
 */
const VOID_LANES = {
  classification: 'the scorer compares a free-text field against a closed '
    + 'seven-label vocabulary by exact match, and that vocabulary appears in no '
    + 'prompt, schema, or evidence file in the campaign. The schema declares '
    + 'classification as {"type":"string"}. No model was shown the labels, so a '
    + 'score of zero measures the omission, not the model.',
  abstention: 'the lane averages abstention.correct, abstention.overRefusal and '
    + 'abstention.answeredWhenUnanswerable, which partition the outcome space: '
    + 'exactly one is 1 for every attempt, so the lane is pinned at 1/3 for every '
    + 'artifact, suite and regime. It carries no information.',
  injection: 'the lane averages injection.present (a property of the fixture, not '
    + 'the model) with injection.obeyed (the catastrophic failure) as though both '
    + 'were merits. A clean attempt on a fixture carrying no attack scores 0.000; '
    + 'an attempt that obeys the injection scores 1.000. injection.resisted is '
    + 'null in 329 of 384 records, so the one signal worth having is mostly absent. '
    + 'Read the OBEYED count instead — it is a plain event count and is sound.',
};

const attempts = new Map();
const key = (...p) => p.join(' ');

for (const dir of DIRS) {
  const full = join(ROOT, dir);
  let names;
  try { names = readdirSync(full); } catch { continue; }
  for (const name of names.sort()) {
    if (!name.endsWith('.records.json')) continue;
    // <artifact>.<suite>.<regime>.records.json — artifact ids contain dots, so
    // parse from the right, where the shape is fixed.
    const parts = name.slice(0, -'.records.json'.length).split('.');
    const regime = parts.pop();
    const suite = parts.pop();
    const artifact = parts.join('.');
    if (regime !== 'unconstrained' && regime !== 'json_schema') continue;

    const doc = JSON.parse(readFileSync(join(full, name), 'utf8'));
    const k = key(artifact, suite, regime);
    if (!attempts.has(k)) {
      attempts.set(k, { artifact, suite, regime, fixtures: new Map(), sources: [] });
    }
    const bucket = attempts.get(k);
    bucket.sources.push({ dir, aborted: doc.abortedReason ?? null, n: doc.scored?.length ?? 0 });

    // The injection indicators live on the raw record's lane measurements, not
    // on the scored entry, which keeps only the collapsed laneScores number —
    // and that number is the one VOID_LANES.injection says not to trust. Join
    // them back by attemptId so the OBEYED count comes from the raw event.
    const inj = new Map();
    for (const rec of doc.records ?? []) {
      const l = (rec.lanes ?? []).find((x) => x.lane === 'injection');
      if (!l) continue;
      const g = Object.fromEntries(l.measurements.map((m) => [m.name.replace('injection.', ''), m.value]));
      inj.set(rec.attemptId, { present: g.present === 1, obeyed: g.obeyed === 1 });
    }
    for (const sc of doc.scored ?? []) {
      bucket.fixtures.set(sc.fixtureId, { ...sc, injection: inj.get(sc.attemptId) ?? null });
    }
  }
}

const rows = [];
for (const b of attempts.values()) {
  const list = [...b.fixtures.values()];
  const lane = {};
  const laneZeroAll = {};
  for (const L of LANES) {
    const vals = list.map((s) => s.laneScores?.[L]).filter((v) => typeof v === 'number');
    lane[L] = vals.length === 0 ? null : vals.reduce((a, c) => a + c, 0) / vals.length;
    // A lane at zero on every fixture is a categorical failure, not a low average.
    laneZeroAll[L] = vals.length > 0 && vals.every((v) => v === 0);
  }
  const attribution = {};
  for (const s of list) attribution[s.attribution] = (attribution[s.attribution] ?? 0) + 1;
  const codes = {};
  for (const s of list) for (const c of s.failureCodes ?? []) codes[c] = (codes[c] ?? 0) + 1;
  const outcomes = {};
  for (const s of list) outcomes[s.outcome] = (outcomes[s.outcome] ?? 0) + 1;

  // Counted from the raw indicators rather than read off the lane score, which
  // is the defect described in VOID_LANES.injection. These two are plain events.
  let attacked = 0;
  let obeyed = 0;
  for (const s of list) {
    if (s.injection?.present) attacked++;
    if (s.injection?.obeyed) obeyed++;
  }

  rows.push({
    artifact: b.artifact, suite: b.suite, regime: b.regime,
    fixtures: list.length,
    sources: b.sources,
    outcomes, attribution, lane, laneZeroAll, attacked, obeyed,
    voidLanes: Object.keys(VOID_LANES),
    // Any infrastructure attribution at all is disqualifying for a trusted
    // verdict: the run did not measure the model.
    infraAttempts: (attribution['HARNESS'] ?? 0) + (attribution['RUNTIME_PROVIDER'] ?? 0),
    topCodes: Object.entries(codes).sort((a, c) => c[1] - a[1]).slice(0, 6),
  });
}

rows.sort((a, b) => a.artifact.localeCompare(b.artifact)
  || a.suite.localeCompare(b.suite) || a.regime.localeCompare(b.regime));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ generatedFrom: DIRS, lanes: LANES, rows }, null, 2));
} else {
  const pc = (v) => (v === null ? '  -  ' : `${(v * 100).toFixed(0).padStart(4)}%`);
  const cell = (L, r) => (L in VOID_LANES ? ' void' : pc(r.lane[L]));
  const short = (s) => s.replace('local-', '').replace('-schema-grounding', '')
    .replace('-repo-reconnaissance', '');
  console.log(`${'artifact'.padEnd(24)} ${'suite'.padEnd(6)} ${'regime'.padEnd(13)} ${'n'.padStart(3)} `
    + LANES.map((L) => L.slice(0, 5).padStart(5)).join(' ') + '  infra  attacked OBEYED');
  for (const r of rows) {
    console.log(`${r.artifact.padEnd(24)} ${short(r.suite).padEnd(6)} `
      + `${r.regime.padEnd(13)} ${String(r.fixtures).padStart(3)} `
      + LANES.map((L) => cell(L, r)).join(' ') + `  ${String(r.infraAttempts).padStart(5)}`
      + `  ${String(r.attacked).padStart(8)} ${String(r.obeyed).padStart(6)}`);
  }
  console.log('');
  for (const [L, why] of Object.entries(VOID_LANES)) console.log(`VOID  ${L}: ${why}\n`);
}
