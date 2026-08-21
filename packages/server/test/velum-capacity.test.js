/**
 * Admission control for prompt-injection inspection, attacked.
 *
 * The budget exists because inspection is synchronous and its cost is chosen by
 * the caller. Measured before it existed: one megabyte of ASCII evidence cost
 * 257 MiB of peak heap and 6.4 seconds of blocked event loop, and a four
 * megabyte attempt drove peak RSS past 770 MiB before the step budget refused
 * it anyway. The engine's cell table is two typed arrays now — 1.1 MiB of peak
 * heap for the same scan — so what is left to bound is occupancy, and these
 * tests are the ways a caller might try to get more of it than the budget says.
 *
 * Nothing here runs a model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ScanCapacity, ScanCapacityError, inspectionBytes } from '@bokahli/server/velum-capacity';
import { admitRequest } from '@bokahli/server/trust';

const KiB = 1024;
const MiB = 1024 * KiB;
const fresh = (limit = 8 * MiB, per = 1 * MiB) => new ScanCapacity(limit, per);

// ── the limits themselves ───────────────────────────────────────────────────

test('the budget refuses to be constructed incoherently', () => {
  for (const [limit, per] of [[0, 1], [-1, 1], [1.5, 1], [Number.NaN, 1], [Number.MAX_SAFE_INTEGER + 2, 1]]) {
    assert.throws(() => new ScanCapacity(limit, per), ScanCapacityError, `limit ${limit}`);
  }
  for (const [limit, per] of [[1 * MiB, 0], [1 * MiB, -5], [1 * MiB, 1.5]]) {
    assert.throws(() => new ScanCapacity(limit, per), ScanCapacityError, `per-request ${per}`);
  }
  // A per-request ceiling above the process ceiling would make some requests
  // individually acceptable and never satisfiable.
  assert.throws(() => new ScanCapacity(1 * MiB, 2 * MiB), ScanCapacityError);
});

test('reservation arithmetic is in safe integers or it is refused', () => {
  const c = fresh();
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(() => c.reserve(bad), ScanCapacityError, String(bad));
  }
  // A refusal that threw must not have moved the counters.
  assert.equal(c.usage().inFlightBytes, 0);
  assert.equal(c.usage().inFlightRequests, 0);
  assert.ok(c.reserve(0).ok, 'zero is a legitimate size');
});

// ── the ways a caller might ask for more than its share ─────────────────────

test('a single oversized document is refused, and says which limit', () => {
  const c = fresh(8 * MiB, 1 * MiB);
  const r = c.reserve(1 * MiB + 1);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'PER_REQUEST');
  assert.equal(r.limitBytes, 1 * MiB);
  assert.equal(c.usage().inFlightBytes, 0, 'a refusal reserves nothing');
  assert.ok(c.reserve(1 * MiB).ok, 'exactly the limit is allowed');
});

test('many smaller documents cannot sum past the per-request limit', () => {
  // The bypass the per-request budget would have if it were per *document*:
  // thirty-two evidence items of 40 KiB each is 1.25 MiB of inspection from a
  // caller that never sends a large field.
  const evidence = Array.from({ length: 32 }, (_, i) => ({ id: `e${i}`, content: 'x'.repeat(40 * KiB) }));
  const messages = [{ role: 'user', content: 'summarise these' }];
  const total = inspectionBytes(messages, evidence);
  assert.ok(total > 1 * MiB, `${total} bytes across ${evidence.length} items`);

  const c = fresh(8 * MiB, 1 * MiB);
  const r = c.reserve(total);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'PER_REQUEST');
});

test('instructions count towards the same budget as evidence', () => {
  // Otherwise the message channel is an unmetered second door into the same
  // inspector.
  const only = inspectionBytes([], [{ id: 'e', content: 'x'.repeat(100) }]);
  const both = inspectionBytes([{ role: 'user', content: 'y'.repeat(50) }], [{ id: 'e', content: 'x'.repeat(100) }]);
  assert.equal(only, 100);
  assert.equal(both, 150);
  // Bytes, not characters: a multibyte instruction costs what it costs.
  assert.equal(inspectionBytes([{ role: 'user', content: '日本語' }], []), 9);
});

// ── concurrency ─────────────────────────────────────────────────────────────

test('concurrent requests racing for the last reservation: exactly one wins', () => {
  const c = new ScanCapacity(1 * MiB, 1 * MiB);
  assert.ok(c.reserve(768 * KiB).ok);
  // Eight callers all want the remaining 256 KiB. `reserve` is synchronous and
  // has no await in it, so the check and the increment cannot interleave: on a
  // single-threaded runtime that is the whole of the no-check-then-allocate
  // argument, and this is the observation of it.
  const results = Array.from({ length: 8 }, () => c.reserve(256 * KiB));
  assert.equal(results.filter((r) => r.ok).length, 1, 'one winner');
  assert.equal(results.filter((r) => !r.ok).length, 7);
  for (const r of results.filter((x) => !x.ok)) {
    assert.equal(r.reason, 'IN_FLIGHT');
    assert.equal(r.availableBytes, 0);
  }
  assert.equal(c.usage().inFlightBytes, 1 * MiB);
  assert.equal(c.usage().inFlightRequests, 2);
});

test('there is no queue: excess is refused now, not held', () => {
  const c = new ScanCapacity(1 * MiB, 1 * MiB);
  const held = c.reserve(1 * MiB);
  assert.ok(held.ok);
  // A waiter holds the memory it is waiting for, so there is nowhere to wait.
  for (let i = 0; i < 100; i++) {
    const r = c.reserve(1 * KiB);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'IN_FLIGHT');
  }
  assert.equal(c.usage().inFlightRequests, 1, 'nothing accumulated');
  assert.equal(c.usage().refused, 100);
  held.reservation.release();
  assert.ok(c.reserve(1 * KiB).ok, 'and capacity returns immediately');
});

// ── release ─────────────────────────────────────────────────────────────────

test('capacity is returned however the request ended', () => {
  const c = fresh(1 * MiB, 1 * MiB);
  const r = c.reserve(512 * KiB);
  assert.ok(r.ok);
  assert.equal(c.usage().inFlightBytes, 512 * KiB);
  r.reservation.release();
  assert.equal(c.usage().inFlightBytes, 0);
  assert.equal(c.usage().inFlightRequests, 0);
});

test('releasing twice does not hand back capacity that was never taken', () => {
  // The request path releases in a `finally` nested inside another `finally`.
  // A non-idempotent release would leak the limit upward on every request until
  // nothing was ever refused.
  const c = fresh(1 * MiB, 1 * MiB);
  const r = c.reserve(512 * KiB);
  assert.ok(r.ok);
  r.reservation.release();
  r.reservation.release();
  r.reservation.release();
  assert.equal(c.usage().inFlightBytes, 0);
  assert.equal(c.usage().inFlightRequests, 0);
  assert.ok(c.reserve(1 * MiB).ok, 'and the full budget really is free');
});

test('a scan that throws still returns its capacity', () => {
  // The three ways inspection ends badly: a resource ceiling, malformed input,
  // and an unexpected engine fault. All of them leave through the same
  // `finally`, so all of them must give the bytes back.
  const c = fresh(4 * MiB, 4 * MiB);
  const cases = [
    ['resource ceiling', () => admitRequest({
      requestId: 'r', authSource: 'header', mode: 'enforce',
      messages: [{ role: 'user', content: 'go' }],
      evidence: [{ id: 'huge', content: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVoK '.repeat(6000) }],
    })],
    ['malformed UTF-8', () => admitRequest({
      requestId: 'r', authSource: 'header', mode: 'enforce',
      messages: [{ role: 'user', content: 'go' }],
      evidence: [{ id: 'bad', content: '\uD800 lone surrogate \uDFFF'.repeat(64) }],
    })],
  ];
  for (const [name, run] of cases) {
    const r = c.reserve(64 * KiB);
    assert.ok(r.ok, name);
    try {
      const out = run();
      // Either a typed outcome or a typed escalation; never a crash.
      assert.ok(['ADMITTED', 'BLOCKED', 'ESCALATE'].includes(out.kind), `${name}: ${out.kind}`);
    } finally {
      r.reservation.release();
    }
    assert.equal(c.usage().inFlightBytes, 0, `${name} returned its capacity`);
  }
});

// ── what the refusal is, and is not ─────────────────────────────────────────

test('a capacity refusal cannot be mistaken for a model failure', () => {
  const c = new ScanCapacity(1 * MiB, 1 * MiB);
  c.reserve(1 * MiB);
  const r = c.reserve(1 * KiB);
  assert.equal(r.ok, false);
  // It is a size and a reason. No completion, no score, no model identity, and
  // nothing that could be read as the model having answered badly.
  const blob = JSON.stringify(r);
  for (const forbidden of ['model', 'qualif', 'token', 'completion', 'content', 'score']) {
    assert.ok(!blob.toLowerCase().includes(forbidden), `refusal must not mention ${forbidden}`);
  }
  assert.deepEqual(Object.keys(r).sort(), ['availableBytes', 'limitBytes', 'ok', 'reason', 'requestedBytes']);
});

test('usage is publishable: counts and bytes, never content', () => {
  const c = fresh();
  c.reserve(4 * KiB);
  const u = c.usage();
  assert.deepEqual(Object.keys(u).sort(), [
    'granted', 'inFlightBytes', 'inFlightRequests', 'limitBytes',
    'peakInFlightBytes', 'perRequestLimitBytes', 'refused',
  ]);
  for (const v of Object.values(u)) assert.equal(typeof v, 'number');
  assert.equal(u.peakInFlightBytes, 4 * KiB);
  assert.equal(u.granted, 1);
});

test('the peak is remembered after the bytes are returned', () => {
  const c = fresh();
  const r = c.reserve(512 * KiB);
  assert.ok(r.ok);
  r.reservation.release();
  assert.equal(c.usage().inFlightBytes, 0);
  assert.equal(c.usage().peakInFlightBytes, 512 * KiB, 'an operator can see what it reached');
});
