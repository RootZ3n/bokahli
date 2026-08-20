/**
 * Identity of the backend *process*, so a restart cannot pass for continuity.
 *
 * Build-level identity cannot see a restart that comes back on the same build,
 * and that restart matters: attempts either side of it ran against a freshly
 * loaded model, an empty KV cache, and possibly different device placement,
 * while reporting one identity. A qualification run that spanned it would
 * average two deployments and call the result one measurement.
 *
 * Three facts, and each is load-bearing:
 *
 *   pid                 — necessary, and on its own worthless. Pids are reused.
 *   kernelStartTicks    — field 22 of /proc/<pid>/stat, in clock ticks since
 *                         boot. This is what makes pid reuse detectable: a new
 *                         process on a recycled pid has a different start time.
 *                         It is also why wall-clock is not used — a clock
 *                         adjustment must not look like a restart.
 *   bootId              — makes the pair meaningful across reboots, where tick
 *                         counts restart from zero and could otherwise collide.
 *
 * All three are readable under the API's systemd sandbox. That was measured,
 * not assumed: `/proc/<pid>/stat` and `/proc/<pid>/cmdline` are readable there
 * while `/proc/<pid>/maps` and `/proc/<pid>/exe` are denied.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { BackendInstanceIdentity } from '@bokahli/contracts';

/** Kernel clock ticks per second. Fixed at 100 on Linux/x86-64 (USER_HZ). */
const USER_HZ = 100;

/** Field 22 of /proc/<pid>/stat, one-indexed as `proc(5)` numbers them. */
const STAT_FIELD_STARTTIME = 22;

export interface InstanceProbeSources {
  readonly readStat: (pid: number) => Promise<string>;
  readonly readBootId: () => Promise<string>;
  readonly readBtime: () => Promise<number>;
  readonly readCmdline: (pid: number) => Promise<string>;
  readonly now: () => Date;
}

export const REAL_SOURCES: InstanceProbeSources = {
  readStat: (pid) => readFile(`/proc/${pid}/stat`, 'utf8'),
  readBootId: () => readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
  readBtime: async () => {
    const text = await readFile('/proc/stat', 'utf8');
    const line = text.split('\n').find((l) => l.startsWith('btime '));
    const v = Number(line?.slice(6).trim());
    if (!Number.isFinite(v)) throw new Error('/proc/stat has no usable btime');
    return v;
  },
  readCmdline: (pid) => readFile(`/proc/${pid}/cmdline`, 'utf8'),
  now: () => new Date(),
};

/**
 * Parse field 22 out of a stat line.
 *
 * The comm field is parenthesised and may itself contain spaces and
 * parentheses, so splitting the whole line on whitespace is wrong for any
 * process whose name contains one. Everything after the final `)` is
 * unambiguous, which is why `proc(5)` documents parsing it that way.
 */
export function parseStartTicks(stat: string): number | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const rest = stat.slice(close + 2).trim().split(/\s+/);
  // After the ')' the next field is `state`, which is field 3. Field 22 is
  // therefore at index 22 - 3 = 19.
  const v = Number(rest[STAT_FIELD_STARTTIME - 3]);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Read the started-with GPU flags out of argv.
 *
 * Only these two values are extracted, and the argv itself is discarded. A raw
 * command line can carry an API key, a model path, or anything else an operator
 * put there, and none of that may reach a response — so this returns numbers
 * and booleans, never strings taken from the process.
 */
export function parseGpuFlags(cmdline: string): {
  requestedGpuLayers: number | null;
  cpuOffloadEnabled: boolean | null;
} {
  const argv = cmdline.split('\0').filter((a) => a.length > 0);
  if (argv.length === 0) return { requestedGpuLayers: null, cpuOffloadEnabled: null };

  let layers: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--n-gpu-layers' || a === '-ngl' || a === '--gpu-layers') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n)) layers = n;
    } else if (a !== undefined && /^(--n-gpu-layers|--gpu-layers)=/.test(a)) {
      const n = Number(a.slice(a.indexOf('=') + 1));
      if (Number.isFinite(n)) layers = n;
    }
  }
  const cpuMoe = argv.includes('--cpu-moe') || argv.includes('--n-cpu-moe');
  return { requestedGpuLayers: layers, cpuOffloadEnabled: cpuMoe };
}

/**
 * Establish the identity of one backend process.
 *
 * Never throws. Every source that fails contributes a reason and leaves its
 * field null, because a partial identity that says which part is missing is
 * usable and a thrown error at this layer would take the whole response with
 * it.
 */
export async function probeBackendInstance(
  pid: number | null,
  sources: InstanceProbeSources = REAL_SOURCES,
): Promise<BackendInstanceIdentity> {
  const observedAt = sources.now().toISOString();
  const reasons: string[] = [];

  if (pid === null) {
    return {
      provenance: 'observed',
      observedAt,
      pid: null,
      bootId: null,
      kernelStartTicks: null,
      startedAt: null,
      instanceId: null,
      unavailableReasons: ['backend pid could not be resolved'],
    };
  }

  let bootId: string | null = null;
  try {
    bootId = (await sources.readBootId()).trim() || null;
  } catch (err) {
    // Name, not message: a Node fs error message embeds the path it failed on,
    // and /proc paths are process detail that should not ride out in a response.
    reasons.push(`boot id unreadable (${(err as Error).name})`);
  }

  let ticks: number | null = null;
  try {
    ticks = parseStartTicks(await sources.readStat(pid));
    if (ticks === null) reasons.push('/proc/<pid>/stat did not yield a start time');
  } catch (err) {
    reasons.push(`process stat unreadable (${(err as Error).name})`);
  }

  let startedAt: string | null = null;
  if (ticks !== null) {
    try {
      const btime = await sources.readBtime();
      startedAt = new Date((btime + ticks / USER_HZ) * 1000).toISOString();
    } catch (err) {
      // The instant is a convenience; the ticks are the identity. Losing the
      // former must not invalidate the latter.
      reasons.push(`boot time unreadable, start instant not derived (${(err as Error).name})`);
    }
  }

  // All three or nothing. A hash over a partial set would be stable for the
  // wrong reasons — two different processes could share it — and a stable id
  // that does not identify is worse than an absent one.
  const instanceId =
    bootId !== null && ticks !== null
      ? createHash('sha256').update(`bokahli.backend-instance.v1\n${bootId}\n${pid}\n${ticks}`).digest('hex')
      : null;
  if (instanceId === null && reasons.length === 0) {
    reasons.push('insufficient facts to derive an instance id');
  }

  return {
    provenance: 'observed',
    observedAt,
    pid,
    bootId,
    kernelStartTicks: ticks,
    startedAt,
    instanceId,
    unavailableReasons: reasons,
  };
}

/**
 * The backend's executable path, taken from argv[0].
 *
 * Preferred over configuration because it is an observation of the process that
 * is actually running rather than a statement about the one that was meant to
 * be. `/proc/<pid>/exe` would be the canonical source and is denied under the
 * service sandbox; `cmdline` is readable there, measured on this host.
 *
 * INTERNAL ONLY. The path is used to locate objects to hash and never leaves
 * the process — only basenames appear in any response.
 */
export async function probeExecutablePath(
  pid: number | null,
  sources: InstanceProbeSources = REAL_SOURCES,
): Promise<string | null> {
  if (pid === null) return null;
  try {
    const argv0 = (await sources.readCmdline(pid)).split('\0')[0];
    // Must be an absolute path to a llama-server. A relative argv[0] cannot be
    // resolved from here without guessing at the process's working directory.
    if (argv0 === undefined || !argv0.startsWith('/') || !argv0.endsWith('llama-server')) return null;
    return argv0;
  } catch {
    return null;
  }
}

/** Read the GPU flags the backend was started with. Never throws. */
export async function probeGpuFlags(
  pid: number | null,
  sources: InstanceProbeSources = REAL_SOURCES,
): Promise<{ requestedGpuLayers: number | null; cpuOffloadEnabled: boolean | null }> {
  if (pid === null) return { requestedGpuLayers: null, cpuOffloadEnabled: null };
  try {
    return parseGpuFlags(await sources.readCmdline(pid));
  } catch {
    return { requestedGpuLayers: null, cpuOffloadEnabled: null };
  }
}
