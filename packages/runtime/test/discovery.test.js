/**
 * Backend pid re-discovery.
 *
 * With the API and the runtime on independent lifecycles, the runtime restarts
 * under a new pid while the API keeps running. A pid learned once at startup is
 * then wrong, and a stale pid is worse than none: the GPU lease monitor sees our
 * own inference server as a competing consumer and turns every request into a
 * false capacity failure. Re-discovery has to work against a real /proc.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBackendPids } from '../dist/discovery.js';

const PORT = '18099';
const BASE_URL = `http://127.0.0.1:${PORT}`;

/** A process that is named llama-server and carries the port in its argv. */
async function spawnFakeBackend(dir, port) {
  const bin = join(dir, 'llama-server');
  await writeFile(bin, '#!/usr/bin/env bash\nsleep 60\n');
  await chmod(bin, 0o755);
  const child = spawn(bin, ['--host', '127.0.0.1', '--port', port], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 150));
  return child;
}

test('a restarted backend is found again under its new pid', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bokahli-discovery-'));

  const first = await spawnFakeBackend(dir, PORT);
  const found = await findBackendPids(BASE_URL);
  assert.ok(found.includes(first.pid), `expected pid ${first.pid} in [${found}]`);

  first.kill('SIGKILL');
  await new Promise((r) => first.once('exit', r));
  const gone = await findBackendPids(BASE_URL);
  assert.equal(gone.includes(first.pid), false, 'a dead backend must not stay adopted');

  const second = await spawnFakeBackend(dir, PORT);
  assert.notEqual(second.pid, first.pid, 'sanity: the restart really is a new pid');
  const rediscovered = await findBackendPids(BASE_URL);
  assert.ok(
    rediscovered.includes(second.pid),
    'the new pid must be adopted, or our own backend counts as a foreign GPU holder',
  );

  second.kill('SIGKILL');
  await new Promise((r) => second.once('exit', r));
});

test('a process on a different port is not mistaken for our backend', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bokahli-discovery-'));
  const other = await spawnFakeBackend(dir, '18100');
  const found = await findBackendPids(BASE_URL);
  assert.equal(found.includes(other.pid), false);
  other.kill('SIGKILL');
  await new Promise((r) => other.once('exit', r));
});
