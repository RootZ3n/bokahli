/**
 * Operational profiles.
 *
 * A profile is the difference between "start this measured configuration" and "start whatever
 * these flags say". Every test here is an attempt to smuggle the second past the first.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseProfile, profileEnv, capacityVerdict, ProfileError, CACHE_TYPES } from '../dist/profile.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const DOC = JSON.parse(readFileSync(REPO + 'catalog/profiles.json', 'utf8'));

const GOOD = {
  profileId: 'p-test', modelId: 'm', artifactDigest: 'sha256:' + 'a'.repeat(64),
  contextTokens: 8192, gpuLayers: 60, cacheTypeK: 'q4_0', cacheTypeV: 'q4_0',
  threads: 8, threadsBatch: 16, batchSize: null, ubatchSize: null, parallelSlots: 1,
  flashAttn: 'on', reasoning: 'off', minFreeVramMiB: 11349,
  intendedTaskClasses: ['test_log_triage'], constrainedOutputRequired: true,
  supervisedOnly: true, autonomousPromotionAllowed: false, note: '',
};

test('profiles: both shipped profiles parse', () => {
  const ids = DOC.profiles.map((p) => parseProfile(p).profileId);
  assert.deepEqual(ids, ['qwen38-27b-interactive', 'qwen38-27b-analysis']);
});

test('profiles: both are bound to the IQ3 artifact digest, and only that one', () => {
  const IQ3 = 'sha256:3b058d6548f216f06ccaf8c6caf8019db23a8ec5a973ec6e84b525255a0ea481';
  for (const raw of DOC.profiles) {
    const p = parseProfile(raw);
    assert.equal(p.artifactDigest, IQ3, `${p.profileId} must bind the IQ3 artifact`);
    assert.equal(p.modelId, 'qwen38-27b.iq3-xxs');
  }
});

test('profiles: NO profile exists for Q4_K_M', () => {
  // It is catalogued because it is installed, not because it is a candidate.
  const Q4 = 'sha256:e103abf9d914d1d7b2f2592f055f2759a71195c350a01c135f71aaae86bca52b';
  assert.ok(!DOC.profiles.some((p) => p.artifactDigest === Q4 || p.modelId.includes('q4-k-m')));
});

test('profiles: no 32K profile exists', () => {
  for (const raw of DOC.profiles) {
    assert.ok(parseProfile(raw).contextTokens <= 16384,
      `${raw.profileId} exceeds the measured contexts`);
  }
});

test('profiles: every shipped profile is supervised, constrained and non-promoting', () => {
  for (const raw of DOC.profiles) {
    const p = parseProfile(raw);
    assert.equal(p.supervisedOnly, true);
    assert.equal(p.constrainedOutputRequired, true, 'unconstrained output is not validated for this model');
    assert.equal(p.autonomousPromotionAllowed, false);
  }
});

// ── refusals ────────────────────────────────────────────────────────────────

test('profiles: an unknown field is REFUSED, not ignored', () => {
  // `extraFlags` silently dropped would leave whoever wrote it believing it applied.
  assert.throws(() => parseProfile({ ...GOOD, extraFlags: '--verbose' }), /unknown field "extraFlags"/);
  assert.throws(() => parseProfile({ ...GOOD, modelPath: '/etc/passwd' }), /unknown field "modelPath"/);
});

test('profiles: a missing required field is refused', () => {
  for (const k of ['modelId', 'artifactDigest', 'contextTokens', 'gpuLayers', 'cacheTypeK', 'threads']) {
    const bad = { ...GOOD }; delete bad[k];
    assert.throws(() => parseProfile(bad), new RegExp(`missing required field "${k}"`), `${k} must be required`);
  }
});

test('profiles: cache types are a CLOSED enum', () => {
  for (const t of CACHE_TYPES) {
    assert.doesNotThrow(() => parseProfile({ ...GOOD, cacheTypeK: t, cacheTypeV: t }));
  }
  for (const bad of ['q3_0', 'int8', 'F16', '', 'q4_0; rm -rf /']) {
    assert.throws(() => parseProfile({ ...GOOD, cacheTypeK: bad }), /cacheTypeK must be one of/);
  }
});

test('profiles: integers are bounded, and a string that looks like one is not an integer', () => {
  assert.throws(() => parseProfile({ ...GOOD, threads: 23 }), /threads must be an integer in \[1, 22\]/);
  assert.throws(() => parseProfile({ ...GOOD, threads: 0 }), /threads/);
  assert.throws(() => parseProfile({ ...GOOD, threads: '8' }), /threads/);
  assert.throws(() => parseProfile({ ...GOOD, threads: 8.5 }), /threads/);
  assert.throws(() => parseProfile({ ...GOOD, contextTokens: 262145 }), /contextTokens/);
  assert.throws(() => parseProfile({ ...GOOD, gpuLayers: 1000 }), /gpuLayers/);
});

test('profiles: threads are capped at 22 — CPUs 8 and 9 are not this unit to spend', () => {
  assert.doesNotThrow(() => parseProfile({ ...GOOD, threads: 22, threadsBatch: 22 }));
  assert.throws(() => parseProfile({ ...GOOD, threads: 24 }), /\[1, 22\]/);
});

test('profiles: autonomousPromotionAllowed must be literally false', () => {
  for (const v of [true, 'false', 0, null, undefined]) {
    assert.throws(() => parseProfile({ ...GOOD, autonomousPromotionAllowed: v }),
      /autonomousPromotionAllowed must be literally false/);
  }
});

test('profiles: a malformed artifact digest is refused', () => {
  for (const d of ['sha256:short', 'abc', 'sha1:' + 'a'.repeat(40), 'sha256:' + 'A'.repeat(64)]) {
    assert.throws(() => parseProfile({ ...GOOD, artifactDigest: d }), /artifactDigest must be sha256/);
  }
});

test('profiles: a path-like profileId is refused', () => {
  for (const id of ['../escape', '/abs', 'Has Space', 'UPPER']) {
    assert.throws(() => parseProfile({ ...GOOD, profileId: id }), /path-free identifier/);
  }
});

// ── the emitted environment ─────────────────────────────────────────────────

test('env: values only — nothing that a shell would re-interpret', () => {
  const env = profileEnv(parseProfile(GOOD), '/models/x.gguf', 'alias');
  for (const [k, v] of Object.entries(env)) {
    assert.equal(typeof v, 'string', `${k} must be a string`);
    assert.ok(!/^-|[;&|`$()<>]/.test(v), `${k}=${v} looks like a flag or shell metacharacter`);
  }
});

test('env: a dense profile never asks for MoE placement', () => {
  // The launcher's own default is `all`, which would emit --cpu-moe for a model with no experts.
  assert.equal(profileEnv(parseProfile(GOOD), '/m.gguf', 'a').BOKAHLI_CPU_MOE, 'off');
});

test('env: optional batch fields are absent when null, not empty', () => {
  const env = profileEnv(parseProfile(GOOD), '/m.gguf', 'a');
  assert.ok(!('BOKAHLI_BATCH' in env));
  assert.ok(!('BOKAHLI_UBATCH' in env));
  const withBatch = profileEnv(parseProfile({ ...GOOD, batchSize: 2048, ubatchSize: 512 }), '/m.gguf', 'a');
  assert.equal(withBatch.BOKAHLI_BATCH, '2048');
  assert.equal(withBatch.BOKAHLI_UBATCH, '512');
});

// ── capacity ────────────────────────────────────────────────────────────────

test('capacity: a profile that fits, fits', () => {
  assert.deepEqual(capacityVerdict(parseProfile(GOOD), 11400), { fits: true });
  assert.deepEqual(capacityVerdict(parseProfile(GOOD), 11349), { fits: true }, 'exactly enough is enough');
});

test('capacity: insufficient VRAM REFUSES rather than shrinking the placement', () => {
  const v = capacityVerdict(parseProfile(GOOD), 8870);
  assert.equal(v.fits, false);
  assert.match(v.detail, /needs 11349 MiB .* 8870 MiB is free/);
  assert.match(v.detail, /Refusing rather than reducing placement/);
  assert.match(v.detail, /make the catalog lie/);
});

test('capacity: the control resident is exactly the case that must refuse', () => {
  // 8870 MiB free is what this host reports with the Q2_K control loaded. Activating an
  // interactive profile on top of it must be a typed capacity refusal, not a smaller ngl.
  for (const raw of DOC.profiles) {
    const v = capacityVerdict(parseProfile(raw), 8870);
    assert.equal(v.fits, false, `${raw.profileId} must not claim to fit beside the control`);
  }
});

test('capacity: both shipped profiles fit the measured 11356 MiB free', () => {
  for (const raw of DOC.profiles) {
    assert.equal(capacityVerdict(parseProfile(raw), 11356).fits, true,
      `${raw.profileId} must fit the exclusive measurement it was taken from`);
  }
});
