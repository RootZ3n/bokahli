import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdmissionQueue } from '../dist/queue.js';

test('one slot admits one and queues the rest', async () => {
  const q = new AdmissionQueue({ maxConcurrent: 1, maxQueueDepth: 2, queueTimeoutMs: 5000 });
  const a = await q.acquire();
  assert.equal(a.admitted, true);
  assert.equal(q.active, 1);

  const bP = q.acquire();
  const cP = q.acquire();
  await new Promise((r) => setImmediate(r));
  assert.equal(q.depth, 2, 'both should be waiting');

  const dRejected = await q.acquire();
  assert.equal(dRejected.admitted, false);
  assert.equal(dRejected.reason, 'QUEUE_FULL');

  a.release();
  const b = await bP;
  assert.equal(b.admitted, true);
  assert.equal(q.active, 1, 'still exactly one active');
  b.release();
  const c = await cP;
  assert.equal(c.admitted, true);
  c.release();
  assert.equal(q.active, 0);
});

test('active never drifts negative when waiters have timed out', async () => {
  const q = new AdmissionQueue({ maxConcurrent: 1, maxQueueDepth: 4, queueTimeoutMs: 30 });
  const a = await q.acquire();
  const timedOut = await Promise.all([q.acquire(), q.acquire()]);
  for (const r of timedOut) {
    assert.equal(r.admitted, false);
    assert.equal(r.reason, 'QUEUE_TIMEOUT');
  }
  a.release();
  assert.equal(q.active, 0, 'releasing past settled waiters must free exactly one slot');

  // The queue must still admit correctly afterwards.
  const next = await q.acquire();
  assert.equal(next.admitted, true);
  assert.equal(q.active, 1);
  next.release();
  assert.equal(q.active, 0);
});

test('queue timeout is reported, not silently stalled', async () => {
  const q = new AdmissionQueue({ maxConcurrent: 1, maxQueueDepth: 2, queueTimeoutMs: 25 });
  const a = await q.acquire();
  const b = await q.acquire();
  assert.equal(b.admitted, false);
  assert.equal(b.reason, 'QUEUE_TIMEOUT');
  assert.equal(q.stats().totalTimedOut, 1);
  a.release();
});
