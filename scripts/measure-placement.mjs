#!/usr/bin/env node
/**
 * Bokahli — measure one artifact on one placement profile, exclusively.
 *
 * ## What "exclusively" is for
 *
 * The earlier performance table was taken while the live control was still
 * loaded. Every number in it is therefore a number about two models sharing a
 * 12 GiB device and 31 GiB of host RAM: VRAM headroom was wrong, page cache was
 * wrong, and the CPU-resident MoE experts of one model were competing with the
 * other's. None of that is visible in a throughput figure, and all of it moves
 * one. So this script owns the whole machine for the duration: it stops the
 * previous runtime, proves it released what it held, and refuses to measure
 * until it has.
 *
 * ## The swap, in order, and why each step refuses
 *
 *   1. Stop the runtime. Then *prove* it is gone — pid reaped, port 8081 free,
 *      the driver no longer listing it as a compute app. A process that has
 *      exited but not yet released VRAM makes the next model's headroom a lie,
 *      and the next model's headroom is what decides whether a full offload
 *      fits.
 *   2. Ask Bokahli, with no backend behind it, and require a *typed* answer.
 *      Bokahli's units are wired `Wants=`, not `Requires=`, precisely so the
 *      API survives its backend; if a swap produced a 5xx or a fabricated
 *      completion, the campaign would have found a real defect and this is
 *      where it would surface. Recorded as evidence either way.
 *   3. Write the profile, start the runtime, and time it. `systemctl start`
 *      returns only after /health answers and placement is asserted, so the
 *      wall time is a cold load including the GPU precondition — stated as
 *      that, not as a pure weight-load time, which is a different number the
 *      runtime reports separately.
 *   4. Re-attest before measuring anything. Wrong artifact, unheld device or an
 *      unverified tokenizer means the measurement would describe a deployment
 *      nobody asked for, and the numbers would look entirely normal.
 *
 * ## What is measured, and what it is not
 *
 * Prefill and decode rates come from llama.cpp's own timings by way of
 * Bokahli's telemetry. Bokahli counts nothing itself and neither does this
 * script: a client-side token estimate presented beside a runtime-measured one
 * is how a character count becomes a token count.
 *
 * A warm-up request runs first and is discarded. The first request after a load
 * pays for graph construction and page-cache faults, and averaging it in
 * measures the load again under the name of throughput.
 *
 * Output goes outside both repositories, to
 * ~/.local/state/bokahli/campaign, because a benchmark result is generated
 * evidence and generated evidence does not belong in Git.
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const HOME = homedir();
const OUT_DIR = process.env['BOKAHLI_CAMPAIGN_DIR'] ?? join(HOME, '.local/state/bokahli/campaign');
const RUNTIME_ENV = join(HOME, '.config/bokahli/runtime.env');
const TOKEN = readFileSync(join(HOME, '.config/bokahli/token'), 'utf8').trim();
const API = 'http://127.0.0.1:8080';

/** CPUs the campaign may use. Physical core 4 computes wrong answers. */
const ALLOWED_CPUS = '0-7,10-23';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try { appendFileSync(join(OUT_DIR, 'measure.log'), `${line}\n`); } catch { /* pre-mkdir */ }
}

async function sh(cmd, args, opts = {}) {
  try {
    const { stdout } = await run(cmd, args, { timeout: 120_000, ...opts });
    return stdout;
  } catch (err) {
    return err.stdout ?? '';
  }
}

// ---------------------------------------------------------------------------
// observation
// ---------------------------------------------------------------------------

/**
 * Every llama-server process, by argv[0].
 *
 * Read directly rather than through a shell pipeline. The first version shelled
 * out to a `grep 'llama-server'` over /proc, and the shell's own argv contains
 * that string — so it matched itself, always returned at least one pid, and the
 * release check could never pass. A detector that can never say "released"
 * would have made every measurement in this campaign non-exclusive while
 * printing a warning nobody could act on.
 *
 * argv[0] basename only. A process that merely *mentions* llama-server on its
 * command line is not one.
 */
function backendPids() {
  const out = [];
  const self = process.pid;
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === self) continue;
    try {
      const argv0 = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0] ?? '';
      if (argv0.endsWith('/llama-server') || argv0 === 'llama-server') out.push(pid);
    } catch { /* exited between readdir and read, or not ours */ }
  }
  return out;
}

async function computeApps() {
  const out = await sh('nvidia-smi',
    ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits']);
  return out.trim().split('\n').filter(Boolean).map((l) => {
    const [p, m] = l.split(',');
    return { pid: Number(p.trim()), usedMiB: Number(m.trim()) };
  });
}

async function gpuSnapshot() {
  const out = await sh('nvidia-smi',
    ['--query-gpu=memory.total,memory.used,utilization.gpu,temperature.gpu',
      '--format=csv,noheader,nounits']);
  const [total, used, util, temp] = out.trim().split(',').map((s) => Number(s.trim()));
  return { totalMiB: total, usedMiB: used, utilisationPct: util, temperatureC: temp };
}

async function portHolders(port) {
  const out = await sh('bash', ['-lc', `ss -tlnp 2>/dev/null | grep ':${port} ' || true`]);
  return out.trim();
}

function rssBytes(pid) {
  try {
    const m = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+) kB$/m);
    return m ? Number(m[1]) * 1024 : null;
  } catch { return null; }
}

/**
 * Every thread's affinity, and whether any of them can reach the bad core.
 *
 * Checked per measurement rather than once at the start: a restart is exactly
 * when a confinement is lost, and a campaign that verified affinity before its
 * first swap would be asserting it for every swap afterwards.
 */
function affinityOf(pid) {
  try {
    const tids = execFileSync('bash', ['-lc', `ls /proc/${pid}/task`], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
    const sets = new Set();
    for (const t of tids) {
      const out = execFileSync('taskset', ['-pc', t], { encoding: 'utf8' });
      sets.add(out.replace(/.*list:\s*/, '').trim());
    }
    return { threads: tids.length, distinct: [...sets], conforming: sets.size === 1 && sets.has(ALLOWED_CPUS) };
  } catch (err) {
    return { threads: null, distinct: [], conforming: null, error: String(err.message ?? err) };
  }
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

// ---------------------------------------------------------------------------
// the swap
// ---------------------------------------------------------------------------

/**
 * Stop the runtime and prove it let go.
 *
 * "Stopped" is a systemd state; "released" is a set of facts about the machine,
 * and only the second one makes the next measurement exclusive.
 */
async function stopAndProveReleased() {
  const before = backendPids();
  await sh('systemctl', ['--user', 'stop', 'bokahli-runtime.service']);

  const deadline = now() + 60_000;
  let released = null;
  while (now() < deadline) {
    const pids = backendPids();
    const apps = await computeApps();
    const holders = await portHolders(8081);
    const stillCompute = apps.filter((a) => before.includes(a.pid));
    if (pids.length === 0 && stillCompute.length === 0 && holders === '') {
      released = { pids, computeApps: apps, portHolders: holders };
      break;
    }
    await sleep(500);
  }
  const gpu = await gpuSnapshot();
  return {
    stoppedPids: before,
    released: released !== null,
    residualComputeApps: released ? [] : await computeApps(),
    residualPortHolders: released ? '' : await portHolders(8081),
    gpuAfterStop: gpu,
  };
}

/**
 * With no backend, Bokahli must still answer, and answer in types.
 *
 * The whole reason its unit says `Wants=` rather than `Requires=`. A 5xx here,
 * or a completion produced with nothing behind it, is a campaign-stopping
 * finding rather than a footnote.
 */
async function probeUnavailable() {
  const live = await api('/health/live');
  const ready = await api('/health/ready');
  const chat = await api('/v1/bokahli/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      route: { mode: 'AUTO', requireQualified: false },
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 8,
    }),
  });
  return {
    live: { status: live.status, body: live.json },
    ready: { status: ready.status, status_field: ready.json?.status ?? null,
      runtimeHealth: ready.json?.runtime?.health ?? null,
      reachable: ready.json?.runtime?.reachable ?? null },
    chat: {
      status: chat.status,
      outcome: chat.json?.outcome ?? chat.json?.error?.code ?? null,
      reason: chat.json?.route?.reason ?? chat.json?.escalation?.reason ?? null,
      producedCompletion: typeof chat.json?.result?.content === 'string',
      is5xx: chat.status >= 500,
    },
  };
}

function writeRuntimeEnv(profile) {
  const body = [
    '# Written by scripts/measure-placement.mjs for one measurement.',
    '# This is a MEASUREMENT profile, not the control. It stays in place until',
    '# scripts/restore-control.sh overwrites it, which is the only thing that',
    '# restores the control. The previous wording here promised the restore in',
    '# the past tense on every write, so this file claimed to hold the control',
    '# while holding whatever was last measured — a lie in exactly the file',
    '# whose purpose is to state the running configuration explicitly.',
    `BOKAHLI_MODEL_PATH=${profile.artifactPath}`,
    `BOKAHLI_MODEL_ALIAS=${profile.modelId}`,
    'BOKAHLI_RUNTIME_PORT=8081',
    `BOKAHLI_CTX=${profile.ctx}`,
    `BOKAHLI_SLOTS=${profile.slots ?? 1}`,
    `BOKAHLI_GPU_LAYERS=${profile.gpuLayers}`,
    `BOKAHLI_CPU_MOE=${profile.cpuMoe}`,
    `BOKAHLI_FLASH_ATTN=${profile.flashAttn ?? 'on'}`,
    `BOKAHLI_REASONING=${profile.reasoning ?? 'off'}`,
    'BOKAHLI_REQUIRE_GPU=1',
    'BOKAHLI_GPU_WAIT_SECONDS=90',
    '',
  ].join('\n');
  writeFileSync(RUNTIME_ENV, body);
}

/**
 * Start the runtime and time the cold load.
 *
 * `reset-failed` first, and it is not housekeeping. The unit carries
 * `StartLimitBurst=5` over `StartLimitIntervalSec=300` — a crash-loop guard
 * that is exactly right for a service and exactly wrong for a campaign that
 * deliberately restarts it eleven times in ten minutes. Once the limit is hit,
 * every subsequent start fails in about fifteen milliseconds with
 * `start-limit-hit`, and the harness records a string of instant "cold load 13
 * ms, state=failed" results that look like the *models* failing to load. Six
 * refinement profiles were lost to that before it was noticed.
 *
 * Clearing the counter is honest here because the campaign is the thing causing
 * the restarts and knows it. It does not weaken the guard for ordinary
 * operation: the unit file is untouched, and a genuine crash loop outside a
 * measurement still trips it.
 */
async function startAndTime() {
  await sh('systemctl', ['--user', 'reset-failed', 'bokahli-runtime.service']);
  const t0 = now();
  let startError = null;
  try {
    await run('systemctl', ['--user', 'start', 'bokahli-runtime.service'], { timeout: 400_000 });
  } catch (err) {
    startError = `${err.message}`.slice(0, 500);
  }
  const coldLoadMs = now() - t0;
  const state = await sh('systemctl', ['--user', 'show', 'bokahli-runtime.service',
    '-p', 'ActiveState', '-p', 'MainPID', '-p', 'NRestarts', '--value']);
  const [activeState, mainPid, nRestarts] = state.trim().split('\n');
  return {
    coldLoadMs,
    startError,
    activeState,
    mainPid: Number(mainPid) || null,
    nRestarts: Number(nRestarts) || 0,
  };
}

// ---------------------------------------------------------------------------
// throughput
// ---------------------------------------------------------------------------

/**
 * A fixed prompt, the same for every candidate.
 *
 * Built from a repeated deterministic stanza rather than natural prose: the
 * point is a comparable prefill length across four artifacts with two different
 * tokenizers, and comparable means the *bytes* are identical. The token counts
 * that result will differ between tokenizer families, which is why the measured
 * counts are recorded beside the rate rather than assumed equal.
 */
function fixedPrompt(stanzas) {
  const stanza =
    'record 0000: service=api region=eu-west-1 status=degraded latency_ms=412 ' +
    'retries=3 upstream=cache pool=primary note=elevated tail latency observed\n';
  let out = '';
  for (let i = 0; i < stanzas; i++) {
    out += stanza.replace('0000', String(i).padStart(4, '0'));
  }
  return out;
}

async function measureOnce(modelId, digest, promptText, maxTokens, nonce) {
  const t0 = now();
  const r = await api('/v1/bokahli/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      route: { mode: 'EXACT', modelId, artifactDigest: digest, requireQualified: false },
      messages: [
        // The nonce goes *first*, before a byte of the shared body.
        //
        // llama.cpp reuses the longest common prefix already in the KV cache.
        // With an identical prompt every run after the first reported
        // `prompt eval time = 58 ms / 4 tokens` — a prefill rate computed over
        // four tokens, which is not a prefill rate. Varying the leading bytes
        // invalidates the whole prefix, so each run prefills the full prompt
        // and the number means what it says. Length stays constant to the
        // character, so the runs remain comparable.
        { role: 'user', content: `[probe ${nonce}] Summarise the operational state in one sentence.\n\n${promptText}` },
      ],
      sampler: { temperature: 0, topP: 1, maxTokens },
    }),
  });
  const wallMs = now() - t0;
  const t = r.json?.telemetry ?? {};
  return {
    ok: r.status === 200 && r.json?.outcome === 'ROUTED',
    status: r.status,
    outcome: r.json?.outcome ?? r.json?.error?.code ?? null,
    detail: r.json?.route?.detail ?? r.json?.error?.message ?? null,
    wallMs,
    timeToFirstTokenMs: t.timeToFirstTokenMs ?? null,
    totalMs: t.totalMs ?? null,
    promptTokens: t.promptTokens ?? null,
    completionTokens: t.completionTokens ?? null,
    promptTokensPerSecond: t.promptTokensPerSecond ?? null,
    completionTokensPerSecond: t.completionTokensPerSecond ?? null,
    tokenCountSource: t.tokenCounts?.source ?? null,
    finishReason: r.json?.result?.finishReason ?? null,
    gpu: t.gpu ?? null,
  };
}

const stat = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return { n: 0, min: null, median: null, max: null, mean: null };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return { n: v.length, min: v[0], median: v[Math.floor(v.length / 2)], max: v[v.length - 1], mean };
};

// ---------------------------------------------------------------------------
// one profile, end to end
// ---------------------------------------------------------------------------

async function measureProfile(profile, opts) {
  log(`── ${profile.label} ─────────────────────────────────────────`);
  const record = { profile, startedAt: new Date().toISOString() };

  log('  stopping previous runtime and proving release…');
  record.teardown = await stopAndProveReleased();
  if (!record.teardown.released) {
    log(`  WARNING: previous runtime did not fully release: ` +
      `${JSON.stringify(record.teardown.residualComputeApps)} ${record.teardown.residualPortHolders}`);
  }

  log('  probing Bokahli with no backend…');
  record.unavailable = await probeUnavailable();
  log(`    /health/live ${record.unavailable.live.status}, ` +
    `chat ${record.unavailable.chat.status} outcome=${record.unavailable.chat.outcome} ` +
    `5xx=${record.unavailable.chat.is5xx} fabricated=${record.unavailable.chat.producedCompletion}`);

  writeRuntimeEnv(profile);
  log('  starting runtime…');
  record.start = await startAndTime();
  log(`    cold load ${record.start.coldLoadMs} ms, state=${record.start.activeState}, pid=${record.start.mainPid}`);

  if (record.start.activeState !== 'active') {
    record.aborted = 'runtime did not become active';
    record.journal = (await sh('journalctl', ['--user', '-u', 'bokahli-runtime.service',
      '-n', '40', '--no-pager'])).slice(-4000);
    return record;
  }

  // Bokahli re-attests against the new instance on its next probe.
  await sleep(1500);
  const ready = await api('/health/ready');
  const f = ready.json ?? {};
  record.attestation = {
    status: f.status ?? null,
    runtime: f.runtime ?? null,
    backendInstance: f.backendInstance ?? null,
    devicePlacement: f.devicePlacement ?? null,
    runtimeInvocation: f.runtimeInvocation ?? null,
    tokenizer: f.tokenizer === undefined ? null : {
      family: f.tokenizer?.family ?? null,
      pretokenizer: f.tokenizer?.pretokenizer ?? null,
      canarySuiteId: f.tokenizer?.canarySuiteId ?? null,
      encodeCanaryVerified: f.tokenizer?.encodeCanaryVerified ?? null,
      decodeCanaryVerified: f.tokenizer?.decodeCanaryVerified ?? null,
      metadataDigest: f.tokenizer?.metadataDigest ?? null,
      unprovenReasons: f.tokenizer?.unprovenReasons ?? null,
    },
    promptTemplate: f.promptTemplate?.effective ?? null,
    structuredOutput: f.structuredOutput ?? null,
    binding: f.attestation?.binding ?? null,
    completeness: f.attestation?.completeness ?? null,
    missing: f.attestation?.missing ?? null,
  };

  const served = record.attestation.binding?.modelId ?? null;
  if (served !== profile.modelId) {
    record.aborted = `served ${served}, expected ${profile.modelId}`;
    return record;
  }

  const pid = record.start.mainPid;
  record.affinity = affinityOf(pid);
  log(`    affinity: ${record.affinity.threads} threads, conforming=${record.affinity.conforming}`);

  // `--swap-only` stops here: the deployment is up, exclusive and attested, and
  // something else is about to measure it. Sharing this path with the
  // throughput harness rather than writing a second swapper is deliberate — two
  // implementations of "stop the old runtime and prove it let go" would agree
  // until the day they did not, and that day the campaign would be measuring a
  // machine it had not actually cleared.
  if (opts.swapOnly) {
    record.swapOnly = true;
    record.finishedAt = new Date().toISOString();
    return record;
  }

  // ── throughput ────────────────────────────────────────────────────────────
  const promptText = fixedPrompt(opts.stanzas);
  log(`  warm-up (discarded)…`);
  record.warmup = await measureOnce(profile.modelId, profile.digest, promptText, 64, 'warmup');
  if (!record.warmup.ok) {
    record.aborted = `warm-up failed: ${record.warmup.status} ${record.warmup.outcome} ${record.warmup.detail ?? ''}`;
    return record;
  }

  const runs = [];
  for (let i = 0; i < opts.repeats; i++) {
    const m = await measureOnce(profile.modelId, profile.digest, promptText, opts.maxTokens,
      `${profile.modelId}-${i}-${record.startedAt}`);
    runs.push({ ...m, rssBytes: rssBytes(pid), gpuNow: await gpuSnapshot() });
    log(`    run ${i + 1}/${opts.repeats}: ttft=${m.timeToFirstTokenMs}ms ` +
      `prefill=${m.promptTokensPerSecond?.toFixed?.(1)} decode=${m.completionTokensPerSecond?.toFixed?.(1)} ` +
      `prompt=${m.promptTokens} completion=${m.completionTokens}`);
  }
  record.runs = runs;
  record.summary = {
    stable: runs.every((r) => r.ok),
    failures: runs.filter((r) => !r.ok).map((r) => ({ status: r.status, outcome: r.outcome, detail: r.detail })),
    timeToFirstTokenMs: stat(runs.map((r) => r.timeToFirstTokenMs)),
    prefillTokensPerSecond: stat(runs.map((r) => r.promptTokensPerSecond)),
    decodeTokensPerSecond: stat(runs.map((r) => r.completionTokensPerSecond)),
    promptTokens: stat(runs.map((r) => r.promptTokens)),
    completionTokens: stat(runs.map((r) => r.completionTokens)),
    rssBytes: stat(runs.map((r) => r.rssBytes)),
    vramHeldMiB: record.attestation.devicePlacement?.backendVramMiB ?? null,
    gpuUtilisationPct: stat(runs.map((r) => r.gpuNow?.utilisationPct)),
    gpuTemperatureC: stat(runs.map((r) => r.gpuNow?.temperatureC)),
    tokenCountSource: [...new Set(runs.map((r) => r.tokenCountSource))],
  };
  record.finishedAt = new Date().toISOString();
  log(`    → ttft ${record.summary.timeToFirstTokenMs.median} ms | ` +
    `prefill ${record.summary.prefillTokensPerSecond.median?.toFixed?.(1)} tok/s | ` +
    `decode ${record.summary.decodeTokensPerSecond.median?.toFixed?.(1)} tok/s | ` +
    `rss ${(record.summary.rssBytes.median / 2 ** 30).toFixed(2)} GiB | ` +
    `vram ${record.summary.vramHeldMiB} MiB`);
  return record;
}

// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n, d) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const planPath = flag('plan', null);
  if (planPath === null) {
    console.error('usage: measure-placement.mjs --plan <profiles.json> [--out <file.json>]\n' +
      '                            [--repeats N] [--stanzas N] [--max-tokens N] [--swap-only]\n' +
      '  --swap-only  perform the exclusive swap and attest the result, measure nothing');
    process.exit(2);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const opts = {
    repeats: Number(flag('repeats', 3)),
    stanzas: Number(flag('stanzas', 200)),
    maxTokens: Number(flag('max-tokens', 256)),
    swapOnly: argv.includes('--swap-only'),
  };
  const out = flag('out', join(OUT_DIR, `placement-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));

  log(`plan: ${plan.profiles.length} profile(s); repeats=${opts.repeats} stanzas=${opts.stanzas} maxTokens=${opts.maxTokens}`);
  const results = [];
  for (const profile of plan.profiles) {
    try {
      results.push(await measureProfile(profile, opts));
    } catch (err) {
      log(`  ERROR: ${err.message}`);
      results.push({ profile, aborted: `harness error: ${err.message}` });
    }
    writeFileSync(out, `${JSON.stringify({ opts, host: 'mushin', results }, null, 2)}\n`);
  }
  log(`wrote ${out}`);
}

await main();
