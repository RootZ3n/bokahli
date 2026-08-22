/**
 * Runtime ownership — the guard that would have prevented the campaign incident.
 *
 * During the Qwen3.8 placement campaign an experimental unit was started while the control
 * still held port 8081. The unit failed to bind; a process-name match found the CONTROL; and
 * SIGINT went to production, which was down for ninety seconds. Every test here is that
 * sequence, or a neighbour of it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyOwnership, modelPathOf, portOf } from '../dist/ownership.js';

const INSTANCE = { pid: 500, kernelStartTicks: 123456, bootId: 'boot-abc', instanceId: 'inst-1' };
const ARGV = ['/home/zen/llama.cpp/build/bin/llama-server', '--model', '/models/control.gguf', '--port', '8081'];

/** Sources describing a healthy, unambiguous runtime. Each test spoils exactly one fact. */
function sources(over = {}) {
  return {
    unitActive: async () => true,
    mainPid: async () => 500,
    portHolders: async () => [500],
    instanceOf: async () => INSTANCE,
    argvOf: async () => ARGV,
    ...over,
  };
}

test('ownership: a healthy runtime is owned, and reports what it is actually serving', async () => {
  const v = await verifyOwnership('bokahli-runtime.service', 8081, sources());
  assert.equal(v.ok, true);
  assert.equal(v.target.pid, 500);
  assert.equal(v.target.port, 8081);
  assert.equal(v.target.modelPath, '/models/control.gguf');
  assert.equal(v.target.instance.instanceId, 'inst-1');
});

test('ownership: THE CAMPAIGN MISTAKE — a failed unit whose port is held by production', async () => {
  // The experimental unit is "active" with a MainPID of its own, but the socket still belongs
  // to the control. A name match returned the control here and it got signalled.
  const v = await verifyOwnership('qwen38-swap.service', 8081, sources({
    mainPid: async () => 999,       // the experimental unit's pid
    portHolders: async () => [500], // the control still owns the socket
  }));
  assert.equal(v.ok, false);
  assert.equal(v.code, 'PID_MISMATCH');
  assert.match(v.detail, /MainPID is 999 but port 8081 is held by 500/);
  assert.match(v.detail, /refusing to signal either/);
});

test('ownership: the control is never named as a signal target by the wrong unit', async () => {
  const v = await verifyOwnership('qwen38-swap.service', 8081, sources({
    mainPid: async () => 999, portHolders: async () => [500],
  }));
  // The verdict carries no target at all — there is nothing for a caller to signal by accident.
  assert.equal(v.ok, false);
  assert.equal(v.target, undefined);
});

test('ownership: two listeners on one port is ambiguous, never resolved by preference', async () => {
  const v = await verifyOwnership('bokahli-runtime.service', 8081, sources({
    portHolders: async () => [500, 777],
  }));
  assert.equal(v.code, 'PORT_AMBIGUOUS');
  assert.match(v.detail, /refusing to guess/);
});

test('ownership: an active unit with no listener is refused, not waited on', async () => {
  // Mid-load is exactly when a signal does the most damage.
  const v = await verifyOwnership('bokahli-runtime.service', 8081, sources({ portHolders: async () => [] }));
  assert.equal(v.code, 'NO_PORT_LISTENER');
});

test('ownership: an inactive unit owns nothing', async () => {
  const v = await verifyOwnership('bokahli-runtime.service', 8081, sources({ unitActive: async () => false }));
  assert.equal(v.code, 'UNIT_NOT_ACTIVE');
});

test('ownership: no MainPID is a refusal', async () => {
  for (const mp of [null, 0, -1]) {
    const v = await verifyOwnership('u.service', 8081, sources({ mainPid: async () => mp }));
    assert.equal(v.code, 'NO_MAIN_PID', `MainPID ${mp} must refuse`);
  }
});

test('ownership: an unreadable instance identity refuses — a recycled pid must not pass', async () => {
  const v = await verifyOwnership('u.service', 8081, sources({ instanceOf: async () => null }));
  assert.equal(v.code, 'INSTANCE_UNREADABLE');
});

test('ownership: argv must independently confirm the port', async () => {
  // MainPID and the socket can agree while the process is serving something else entirely —
  // for instance after a port was reassigned in config but the old process never restarted.
  const v = await verifyOwnership('u.service', 8081, sources({
    argvOf: async () => ['llama-server', '--model', '/m.gguf', '--port', '9090'],
  }));
  assert.equal(v.code, 'ARGV_MISMATCH');
  assert.match(v.detail, /argv port 9090/);
});

test('ownership: argv with no --model is refused', async () => {
  const v = await verifyOwnership('u.service', 8081, sources({
    argvOf: async () => ['llama-server', '--port', '8081'],
  }));
  assert.equal(v.code, 'ARGV_MISMATCH');
});

test('ownership: unreadable argv is refused rather than assumed', async () => {
  const v = await verifyOwnership('u.service', 8081, sources({ argvOf: async () => null }));
  assert.equal(v.code, 'ARGV_MISMATCH');
});

test('ownership: no path through this function signals on a name match', () => {
  // Structural: the module never reads a process name or comm, so there is no field a name
  // could arrive through. This is the property the incident violated.
  // COMMENTS ARE STRIPPED FIRST. The module's own documentation names `pgrep` while
  // explaining why it must not be used, and a guard that reports the prose describing it
  // teaches people to delete the explanation.
  const src = readSource()
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  assert.ok(!/pgrep|process_name|\/proc\/\d+\/comm|readComm/.test(src),
    'ownership must not consult process names');
  assert.ok(/portHolders/.test(src) && /mainPid/.test(src) && /instanceOf/.test(src),
    'ownership must consult port, MainPID and instance identity');
});

test('argv helpers read what the kernel reports, not what we intended', () => {
  assert.equal(modelPathOf(ARGV), '/models/control.gguf');
  assert.equal(portOf(ARGV), 8081);
  assert.equal(portOf(['--port', 'notanumber']), null);
  assert.equal(portOf(['--port', '70000']), null, 'out-of-range port is not a port');
  assert.equal(portOf(['--port']), null, 'a flag with no value is not a port');
  assert.equal(modelPathOf(['--model']), null);
});

function readSource() {
  const p = fileURLToPath(new URL('../src/ownership.ts', import.meta.url));
  return readFileSync(p, 'utf8');
}
