/**
 * The client contract is pinned here, and this test is the pin.
 *
 * ikbi, Hermes and the Trio are written against `bokahli.client/1`. They live in
 * other repositories, ship on their own cadence, and one of them runs on a
 * phone. When a member of `EscalateReason` gets renamed, nothing in this
 * repository fails — the clients fall through a switch statement, in
 * production, on a machine nobody is watching.
 *
 * So the surface is hashed and the hash is written down. Any change to it fails
 * this test, which is the point: the failure is not "you broke something", it is
 * "you changed something clients depend on, go and look at them". Updating the
 * literal below is a normal and expected part of a deliberate change. Updating
 * it *without* looking at the clients is the thing this exists to make
 * impossible to do by accident.
 *
 * The second half checks the frozen list against the live types, because a pin
 * that drifts away from reality is worse than no pin: it would keep passing
 * while describing a contract that no longer exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENT_CONTRACT_VERSION,
  CLIENT_CONTRACT_SURFACE,
  CLIENT_ESCALATE_REASONS,
  CLIENT_REFUSE_REASONS,
  CLIENT_ROUTE_MODES,
  CLIENT_OUTCOME_KINDS,
  clientContractDigest,
  clientContractCanonicalForm,
} from '../dist/client.js';

/**
 * Pinned 2026-08-21. Changing this literal is a deliberate act with homework
 * attached: bump CLIENT_CONTRACT_VERSION, then check ikbi, Hermes, Pehlichi,
 * Loony-Luna and Mad-Ptah for anything switching on what you changed.
 */
const PINNED_DIGEST =
  'sha256:fb8bf756a7e2bdfe28d05d188c8d8718695682430038e3e0d1e58a60feefd3c4';

test('the client-facing contract has not drifted', () => {
  assert.equal(
    clientContractDigest(),
    PINNED_DIGEST,
    'The client contract surface changed. This is not necessarily wrong — but it '
      + 'is not free. Bump CLIENT_CONTRACT_VERSION, update PINNED_DIGEST, and go '
      + 'look at every client that switches on what you changed. They are in other '
      + 'repositories and will not fail your build.',
  );
});

test('the version is part of what is hashed', () => {
  // Otherwise the version could be bumped without moving the digest, and the
  // two would drift apart while both looking maintained.
  assert.ok(clientContractCanonicalForm().includes(CLIENT_CONTRACT_VERSION));
});

test('the digest is a pure function of the surface', () => {
  assert.equal(clientContractDigest(), clientContractDigest());
});

// ---------------------------------------------------------------------------
// The pin must describe the contract that actually exists.

test('every escalation reason the router can emit is in the frozen list', async () => {
  // Read from the router's own source rather than a hand-kept copy: a new
  // reason added to the union must either appear here or be a deliberate
  // decision that clients cannot see it.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/routing.ts', import.meta.url), 'utf8');
  const union = src.slice(
    src.indexOf('export type EscalateReason'),
    src.indexOf(';', src.indexOf("| 'RUNTIME_UNHEALTHY'")),
  );
  const emitted = [...union.matchAll(/\|\s*'([A-Z_]+)'/g)].map((m) => m[1]);

  assert.ok(emitted.length > 0, 'failed to parse the EscalateReason union');
  for (const reason of emitted) {
    assert.ok(
      CLIENT_ESCALATE_REASONS.includes(reason),
      `EscalateReason.${reason} is not in CLIENT_ESCALATE_REASONS. A client `
        + 'cannot branch on a reason it has never been told about; it will fall '
        + 'through to a default that treats an actionable condition as fatal.',
    );
  }
  assert.equal(CLIENT_ESCALATE_REASONS.length, emitted.length,
    'the frozen list and the live union have diverged');
});

test('the distinctions clients act on are all preserved', () => {
  // Named individually because collapsing any of these pairs takes a decision
  // away from the caller, and each one is a decision with a different remedy.
  for (const r of ['REQUIREMENTS_UNMET', 'LOCAL_MODEL_SWAP_REQUIRED']) {
    assert.ok(CLIENT_ESCALATE_REASONS.includes(r),
      `${r} distinguishes "nothing installed can serve this" from "something can, `
        + 'and it is not loaded" — fall back to a provider, or ask for a swap.');
  }
  for (const r of ['NO_QUALIFIED_LOCAL_ROUTE', 'MODEL_NOT_QUALIFIED_FOR_TASK']) {
    assert.ok(CLIENT_ESCALATE_REASONS.includes(r),
      `${r} distinguishes "nothing is qualified" from "nothing is qualified for this"`);
  }
});

test('EXACT refusals are refusals, never escalations', () => {
  // An escalation invites the caller to go elsewhere. An EXACT request that
  // named an artifact and a digest cannot be honoured elsewhere, and answering
  // it with a substitute is the specific failure EXACT exists to prevent.
  for (const r of CLIENT_REFUSE_REASONS) {
    assert.ok(r.startsWith('EXACT_'));
    assert.ok(!CLIENT_ESCALATE_REASONS.includes(r),
      `${r} must not be reachable as an escalation`);
  }
});

test('the surface is frozen in a fixed order, not sorted', () => {
  // Sorting would hide a reordering, and an operator reading a diff should see
  // the same structure the digest saw.
  assert.deepEqual([...CLIENT_ROUTE_MODES], ['AUTO', 'PROFILE', 'EXACT']);
  assert.deepEqual([...CLIENT_OUTCOME_KINDS], ['ROUTED', 'ESCALATE', 'REFUSED']);
});

test('no prose is frozen', () => {
  // detail/note/authorityNote are expected to improve. Freezing them would stop
  // the explanations from ever getting better, and a client parsing them has
  // made a mistake this contract cannot prevent anyway.
  const form = clientContractCanonicalForm();
  for (const field of ['detail', 'note', 'authorityNote']) {
    assert.ok(!form.includes(`"${field}"`), `${field} is prose and must not be pinned`);
  }
  // But their containing objects are still named in responseFields, so a client
  // knows they exist.
  assert.ok(CLIENT_CONTRACT_SURFACE.responseFields.includes('route.reason'));
});
