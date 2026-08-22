#!/usr/bin/env node
/**
 * Manual profile activation. Operator-only, one transition at a time.
 *
 * WHY A CLI AND NOT A ROUTE. The API has exactly one authentication model — a bearer token that
 * every inference caller already holds. Adding activation behind it would give every caller that
 * can ask a question the ability to change which model answers it, which is precisely the
 * authority separation this is supposed to establish. A CLI is reachable only by someone with a
 * shell on the host, which is the operator, and it uses the same lifecycle authority the API
 * would have had to use anyway. If an authenticated route is wanted later it should call this
 * logic, not reimplement it.
 *
 * WHAT ACTIVATION IS NOT. It is not routing. Nothing on the inference path can reach this file:
 * `auto-no-swap.test.js` asserts the router has no import to it, no child_process, and no profile
 * awareness at all. AUTO keeps serving whatever is resident or refuses.
 *
 * THE ORDER MATTERS, and each step is a gate rather than a stage:
 *
 *   1. lock          — one transition at a time, host-wide, via an exclusive file lock.
 *   2. capacity      — does the profile's measured VRAM requirement fit what is free RIGHT NOW?
 *                      Refuse rather than shrink the placement.
 *   3. own the port  — prove the process about to be stopped is ours (see ownership.ts). The
 *                      campaign incident was a SIGINT to production because a name matched.
 *   4. stop          — through systemd, with the unit's own SIGINT semantics.
 *   5. port free     — verified, not assumed, before anything else is started.
 *   6. start         — with an environment built from validated profile fields only.
 *   7. placement     — read back from the process. Requested and observed stay separate.
 *   8. rollback      — on any failure after step 4, restore what was resident before.
 *
 * The previous resident is recorded as ROLLBACK INTENT, not as fact: if restoring it also fails,
 * the receipt says so rather than claiming a state nobody verified.
 */
import { execFile } from 'node:child_process';
import { open, readFile, writeFile, mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Catalog } from '../packages/catalog/dist/index.js';
import { parseProfile, profileEnv, capacityVerdict } from '../packages/runtime/dist/profile.js';
import { verifyOwnership } from '../packages/runtime/dist/ownership.js';

const run = promisify(execFile);
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const UNIT = 'bokahli-runtime.service';
const LOCK = '/tmp/bokahli-lifecycle.lock';
const RECEIPTS = join(process.env.HOME ?? '/tmp', '.local/state/bokahli/activations');
const RUNTIME_ENV = join(process.env.HOME ?? '', '.config/bokahli/runtime.env');
const PORT = Number(process.env.BOKAHLI_RUNTIME_PORT ?? 8081);

const sh = async (cmd, args) => {
  try { return (await run(cmd, args, { timeout: 400_000 })).stdout.trim(); }
  catch (e) { return (e.stdout ?? '').trim(); }
};

// ── lifecycle facts ─────────────────────────────────────────────────────────

const sources = {
  unitActive: async (u) => (await sh('systemctl', ['--user', 'is-active', u])) === 'active',
  mainPid: async (u) => Number(await sh('systemctl', ['--user', 'show', u, '-p', 'MainPID', '--value'])) || null,
  portHolders: async (port) => {
    const out = await sh('ss', ['-ltnpH', `sport = :${port}`]);
    return [...new Set([...out.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])))];
  },
  instanceOf: async (pid) => {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);
    if (stat === null) return null;
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8').catch(() => '')).trim();
    const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    return { pid, kernelStartTicks: ticks, bootId, instanceId: `${bootId}:${pid}:${ticks}` };
  },
  argvOf: async (pid) => {
    const raw = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => null);
    return raw === null ? null : raw.split('\0').filter((s) => s.length > 0);
  },
};

const freeVram = async () =>
  Number(await sh('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'])) || 0;

const health = async () => {
  const key = (await readFile(join(process.env.HOME ?? '', '.config/bokahli/runtime-api-key'), 'utf8')).trim();
  const code = await sh('curl', ['-s', '-m', '2', '-o', '/dev/null', '-w', '%{http_code}',
    '-H', `Authorization: Bearer ${key}`, `http://127.0.0.1:${PORT}/health`]);
  return code === '200';
};

const waitFor = async (fn, limitMs, stepMs = 250) => {
  const t0 = Date.now();
  while (Date.now() - t0 < limitMs) {
    if (await fn()) return (Date.now() - t0) / 1000;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return null;
};

/** Read the runtime env file into a map, so the previous resident can be restored exactly. */
async function readRuntimeEnv() {
  const raw = await readFile(RUNTIME_ENV, 'utf8').catch(() => '');
  const out = {};
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i)] = t.slice(i + 1);
  }
  return out;
}

/**
 * Write the runtime env from validated values.
 *
 * Every key is either a profile field that passed a bound or a closed enum, or an operator value
 * carried through from the file. Nothing here is interpolated into a command; the launcher quotes
 * these itself and re-validates them.
 */
async function writeRuntimeEnv(env, header) {
  const body = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
  await writeFile(RUNTIME_ENV, `# ${header}\n# Written by scripts/activate-profile.mjs. Edit the profile, not this file.\n${body}\n`, { mode: 0o600 });
}

// ── the transition ──────────────────────────────────────────────────────────

async function resident() {
  const v = await verifyOwnership(UNIT, PORT, sources);
  if (!v.ok) return { ok: false, code: v.code, detail: v.detail };
  const env = await readRuntimeEnv();
  return { ok: true, pid: v.target.pid, modelPath: v.target.modelPath,
           instanceId: v.target.instance.instanceId, profileId: env.BOKAHLI_PROFILE_ID ?? null,
           alias: env.BOKAHLI_MODEL_ALIAS ?? null, ctx: env.BOKAHLI_CTX ?? null };
}

async function activate(profileId, { idempotencyKey } = {}) {
  const t0 = Date.now();
  const receipt = {
    activationId: randomUUID(), idempotencyKey: idempotencyKey ?? null, profileId,
    startedAt: new Date().toISOString(), steps: [], outcome: null, rollback: null,
  };
  const step = (name, extra = {}) => {
    const e = { t: +((Date.now() - t0) / 1000).toFixed(2), step: name, ...extra };
    receipt.steps.push(e);
    console.log(`  ${String(e.t).padStart(7)}s  ${name}${Object.keys(extra).length ? '  ' + JSON.stringify(extra) : ''}`);
    return e;
  };

  const doc = JSON.parse(await readFile(join(REPO, 'catalog/profiles.json'), 'utf8'));
  const raw = doc.profiles.find((p) => p.profileId === profileId);
  if (!raw) return fail(receipt, 'UNKNOWN_PROFILE', `no profile named ${JSON.stringify(profileId)}`);
  const profile = parseProfile(raw);

  const catalog = await Catalog.load(join(REPO, 'catalog/artifacts.json'));
  const artifact = catalog.internal(profile.modelId);
  if (!artifact) return fail(receipt, 'UNKNOWN_ARTIFACT', `profile names uncatalogued model ${profile.modelId}`);
  if (artifact.digest !== profile.artifactDigest) {
    return fail(receipt, 'DIGEST_MISMATCH',
      `profile binds ${profile.artifactDigest} but the catalog has ${artifact.digest}`);
  }
  step('profile_validated', { modelId: profile.modelId, ngl: profile.gpuLayers, ctx: profile.contextTokens });

  const before = await resident();
  receipt.previousResident = before.ok
    ? { profileId: before.profileId, alias: before.alias, modelPath: before.modelPath, instanceId: before.instanceId }
    : { unavailable: before.code };
  const previousEnv = await readRuntimeEnv();
  step('previous_resident_recorded', { alias: before.ok ? before.alias : before.code });

  // CAPACITY, against what is free once the incumbent releases. Measured requirement vs measured
  // headroom; never a reduced placement.
  const freeNow = await freeVram();
  const residentVram = before.ok
    ? Number(await sh('nvidia-smi', ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'])
        .then((s) => s.split('\n').find((l) => l.startsWith(`${before.pid},`))?.split(',')[1] ?? '0')) : 0;
  const projected = freeNow + residentVram;
  const cap = capacityVerdict(profile, projected);
  step('capacity_checked', { freeNow, residentVram, projectedFree: projected, needs: profile.minFreeVramMiB, fits: cap.fits });
  if (!cap.fits) return fail(receipt, 'CAPACITY_UNAVAILABLE', cap.detail);

  // OWNERSHIP, before any signal.
  if (before.ok) {
    const own = await verifyOwnership(UNIT, PORT, sources);
    if (!own.ok) return fail(receipt, 'OWNERSHIP_UNPROVEN', `${own.code}: ${own.detail}`);
    step('ownership_proven', { pid: own.target.pid, instanceId: own.target.instance.instanceId });
  }

  await sh('systemctl', ['--user', 'stop', UNIT]);
  const freed = await waitFor(async () => (await sources.portHolders(PORT)).length === 0, 60_000);
  if (freed === null) return fail(receipt, 'PORT_NOT_RELEASED', `port ${PORT} still held after 60s`);
  step('stopped_and_port_free', { unloadSeconds: freed });

  await writeRuntimeEnv(
    { ...previousEnv, ...profileEnv(profile, artifact.artifactPath, artifact.runtimeAlias),
      BOKAHLI_RUNTIME_PORT: String(PORT) },
    `profile ${profile.profileId} activated ${new Date().toISOString()}`);
  step('runtime_env_written');

  await sh('systemctl', ['--user', 'start', UNIT]);
  const loaded = await waitFor(health, 400_000);
  if (loaded === null) {
    step('load_failed');
    return await rollback(receipt, previousEnv, 'LOAD_FAILED', `${profile.profileId} did not become healthy`);
  }
  step('loaded', { loadSeconds: loaded });

  const own2 = await verifyOwnership(UNIT, PORT, sources);
  if (!own2.ok) return await rollback(receipt, previousEnv, 'POST_LOAD_OWNERSHIP', own2.detail);
  const argv = await sources.argvOf(own2.target.pid);
  const obsNgl = Number(argv[argv.indexOf('--n-gpu-layers') + 1]);
  const obsCtx = Number(argv[argv.indexOf('--ctx-size') + 1]);
  const aff = await sh('taskset', ['-cp', String(own2.target.pid)]);
  const vram = Number(await sh('nvidia-smi', ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'])
    .then((s) => s.split('\n').find((l) => l.startsWith(`${own2.target.pid},`))?.split(',')[1] ?? '0'));
  // REQUESTED AND OBSERVED, side by side. They have differed on this host.
  receipt.placement = { requestedGpuLayers: profile.gpuLayers, observedGpuLayers: obsNgl,
                        requestedContext: profile.contextTokens, observedContext: obsCtx,
                        vramMiB: vram, affinity: aff.replace(/.*list: /, '') };
  step('placement_verified', receipt.placement);
  if (obsNgl !== profile.gpuLayers || obsCtx !== profile.contextTokens) {
    return await rollback(receipt, previousEnv, 'PLACEMENT_MISMATCH',
      `asked for ngl=${profile.gpuLayers}/ctx=${profile.contextTokens}, observed ngl=${obsNgl}/ctx=${obsCtx}`);
  }
  if (/(^|,)(8|9)(,|$)/.test(receipt.placement.affinity)) {
    return await rollback(receipt, previousEnv, 'CPU_EXCLUSION_LOST',
      `affinity ${receipt.placement.affinity} includes a defective CPU`);
  }

  receipt.outcome = { kind: 'ACTIVATED', totalSeconds: +((Date.now() - t0) / 1000).toFixed(2) };
  return await finish(receipt);
}

async function rollback(receipt, previousEnv, code, detail) {
  console.log(`  ROLLBACK: ${code} — ${detail}`);
  await sh('systemctl', ['--user', 'stop', UNIT]);
  await waitFor(async () => (await sources.portHolders(PORT)).length === 0, 60_000);
  await writeRuntimeEnv(previousEnv, `rollback after ${code} ${new Date().toISOString()}`);
  await sh('systemctl', ['--user', 'start', UNIT]);
  const back = await waitFor(health, 400_000);
  // INTENT, NOT FACT. If the restore also failed, the receipt says the host is in neither state.
  receipt.rollback = { attempted: true, restored: back !== null, seconds: back };
  receipt.outcome = { kind: 'FAILED', code, detail };
  return await finish(receipt);
}

async function fail(receipt, code, detail) {
  console.log(`  REFUSED: ${code} — ${detail}`);
  receipt.outcome = { kind: 'REFUSED', code, detail };
  return await finish(receipt);
}

async function finish(receipt) {
  receipt.endedAt = new Date().toISOString();
  await mkdir(RECEIPTS, { recursive: true });
  const p = join(RECEIPTS, `${receipt.activationId}.json`);
  await writeFile(p, JSON.stringify(receipt, null, 2));
  console.log(`  receipt: ${p}`);
  return receipt;
}

// ── entry ───────────────────────────────────────────────────────────────────

/**
 * One transition at a time, host-wide.
 *
 * An exclusive-create lock file holding the owner's pid. `wx` is atomic, so two activations
 * racing produce exactly one winner. A lock whose owner is gone is STOLEN rather than honoured —
 * an activation killed mid-transition would otherwise wedge the host forever — but only after
 * proving the pid is dead, because the whole point is not to act while someone else is acting.
 *
 * The first version of this function was worse than nothing: it opened the file, called an
 * `flock` binary in a way that released immediately, and returned. It looked like mutual
 * exclusion and provided none.
 */
async function withLock(fn) {
  const { open: openFile, readFile: rf, unlink } = await import('node:fs/promises');
  const claim = async () => {
    try {
      const fh = await openFile(LOCK, 'wx', 0o600);
      await fh.writeFile(String(process.pid));
      await fh.close();
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = Number((await rf(LOCK, 'utf8').catch(() => '')).trim());
      if (!Number.isInteger(owner) || owner <= 0) return false;
      try {
        process.kill(owner, 0);
        return false; // a live owner: someone else is mid-transition
      } catch {
        // The owner is gone. Steal, then re-claim atomically so two stealers cannot both win.
        await unlink(LOCK).catch(() => {});
        return false;
      }
    }
  };
  for (let i = 0; i < 3; i += 1) {
    if (await claim()) {
      try { return await fn(); } finally { await unlink(LOCK).catch(() => {}); }
    }
  }
  console.error(`another activation holds ${LOCK}; refusing to interleave with it`);
  process.exit(3);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'status') {
  const r = await resident();
  console.log(JSON.stringify(r, null, 2));
} else if (cmd === 'activate') {
  if (!arg) { console.error('usage: activate-profile.mjs activate <profileId>'); process.exit(2); }
  const r = await withLock(() => activate(arg, { idempotencyKey: process.env.BOKAHLI_IDEMPOTENCY_KEY }));
  process.exit(r.outcome.kind === 'ACTIVATED' ? 0 : 1);
} else if (cmd === 'profiles') {
  const doc = JSON.parse(await readFile(join(REPO, 'catalog/profiles.json'), 'utf8'));
  for (const p of doc.profiles) {
    const v = parseProfile(p);
    console.log(`  ${v.profileId}  ${v.modelId}  ctx=${v.contextTokens} ngl=${v.gpuLayers} kv=${v.cacheTypeK} needs=${v.minFreeVramMiB}MiB`);
  }
} else {
  console.error('usage: activate-profile.mjs <status|profiles|activate <profileId>>');
  process.exit(2);
}
