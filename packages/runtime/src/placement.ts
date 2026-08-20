/**
 * Whether *our backend* is on the GPU — a different question from whether the
 * GPU is busy.
 *
 * Phase 1 learned this the hard way. A llama-server that lost CUDA comes up
 * CPU-only, serves the correct artifact, reports the correct build, attests
 * perfectly, and runs at roughly a third of the decode rate. Whole-GPU
 * telemetry cannot see it: memory and utilisation reflect whatever else is on
 * the device, and a desktop compositor is enough to make the numbers look
 * alive. The only fact that answers the question is whether the driver lists
 * our exact pid as holding a compute allocation.
 *
 * That is the same check `scripts/assert-gpu-placement.sh` makes at service
 * start. Sharing the definition is deliberate: two process-detection
 * implementations will eventually disagree, and the day they do, one of them
 * will be the one deciding whether evidence is valid.
 *
 * `nvidia-smi --query-compute-apps` is used rather than `/proc/<pid>/fd`
 * because the descriptor list is unreadable inside the units' sandboxes —
 * measured on this host, not assumed. The driver answers the same question from
 * its own side and works there.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DevicePlacement } from '@bokahli/contracts';

const run = promisify(execFile);

export interface ComputeApp {
  readonly pid: number;
  /** Null when the driver reported something unparseable, e.g. MIG's [N/A]. */
  readonly usedMiB: number | null;
}

/**
 * VRAM a listing must clear to count as placement.
 *
 * The same 512 MiB `scripts/assert-gpu-placement.sh` has always required. A
 * process can appear in the driver's compute table holding a few MiB of
 * incidental allocation; the service assertion refuses that, and until this
 * audit the API accepted it — so the two could disagree about the same backend
 * while the API was the one deciding whether evidence counted.
 */
export const DEFAULT_PLACEMENT_FLOOR_MIB = 512;

export interface PlacementProbeOptions {
  readonly floorMiB: number;
  readonly timeoutMs: number;
  readonly now: () => Date;
  /** Injected for tests; the default shells out to nvidia-smi. */
  readonly queryComputeApps: (timeoutMs: number) => Promise<readonly ComputeApp[]>;
}

async function nvidiaComputeApps(timeoutMs: number): Promise<readonly ComputeApp[]> {
  const { stdout } = await run(
    'nvidia-smi',
    ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'],
    { timeout: timeoutMs },
  );
  const out: ComputeApp[] = [];
  for (const line of stdout.trim().split('\n')) {
    if (!line.trim()) continue;
    const [p, m] = line.split(',');
    const pid = Number((p ?? '').trim());
    if (!Number.isFinite(pid)) continue;
    // An unparseable memory column is kept with a null, not dropped. Dropping
    // the row removed our pid from the table and reported the backend as *not*
    // placed — turning "the driver would not say how much" into "the driver
    // says none", which is a false negative that fails a campaign for no reason.
    const raw = (m ?? '').trim();
    const n = Number(raw);
    out.push({ pid, usedMiB: Number.isFinite(n) ? n : null });
  }
  return out;
}

export const DEFAULT_PLACEMENT_OPTIONS: PlacementProbeOptions = {
  floorMiB: DEFAULT_PLACEMENT_FLOOR_MIB,
  timeoutMs: 4000,
  now: () => new Date(),
  queryComputeApps: nvidiaComputeApps,
};

export interface PlacementInputs {
  readonly backendPid: number | null;
  readonly requestedGpuLayers: number | null;
  readonly cpuOffloadEnabled: boolean | null;
}

/**
 * Measure placement for one backend pid.
 *
 * The distinction that matters is between *absent from the table* and *unable
 * to read the table*. The first is a real, load-bearing negative: the driver
 * answered and our process is not on the device. The second is ignorance, and
 * must not be reported as a negative — a failed nvidia-smi would otherwise
 * accuse a perfectly healthy GPU backend of running on the CPU.
 *
 * So a failed query yields `backendHoldsDevice: null` with a limitation, and an
 * answered query that omits our pid yields `false` with none.
 */
export async function probeDevicePlacement(
  inputs: PlacementInputs,
  opts: Partial<PlacementProbeOptions> = {},
): Promise<DevicePlacement> {
  const o = { ...DEFAULT_PLACEMENT_OPTIONS, ...opts };
  const observedAt = o.now().toISOString();
  const base = {
    provenance: 'observed' as const,
    observedAt,
    floorMiB: o.floorMiB,
    backendPid: inputs.backendPid,
    // Started-with flags. Requests, and labelled as such in the contract.
    requestedGpuLayers: inputs.requestedGpuLayers,
    cpuOffloadEnabled: inputs.cpuOffloadEnabled,
  };

  if (inputs.backendPid === null) {
    return {
      ...base,
      method: 'unavailable',
      backendHoldsDevice: null,
      backendVramMiB: null,
      limitation: 'backend pid unresolved; placement cannot be attributed to a process',
    };
  }

  let apps: readonly ComputeApp[];
  try {
    const raw = await o.queryComputeApps(o.timeoutMs);
    // Fail closed on a shape we do not recognise. Before this the code called
    // .find() on whatever came back, so malformed output threw out of the probe
    // and took the response with it instead of degrading to "unknown".
    if (!Array.isArray(raw)) throw new Error('driver returned a non-list compute-app table');
    apps = raw.filter(
      (a): a is ComputeApp =>
        a !== null && typeof a === 'object' &&
        typeof (a as ComputeApp).pid === 'number' && Number.isFinite((a as ComputeApp).pid),
    );
  } catch (err) {
    return {
      ...base,
      method: 'unavailable',
      backendHoldsDevice: null,
      backendVramMiB: null,
      limitation:
        `driver compute-app table unreadable (${(err as Error).name}); ` +
        'placement is unknown, which is not the same as absent',
    };
  }

  const rows = apps.filter((a) => a.pid === inputs.backendPid);

  if (rows.length === 0) {
    // The driver answered and our pid is not in it. A real, load-bearing
    // negative — distinct from the unreadable case above.
    return {
      ...base, method: 'nvidia-smi-compute-apps',
      backendHoldsDevice: false, backendVramMiB: null, limitation: null,
    };
  }

  if (rows.length > 1) {
    // One pid, several rows means several devices. Summing would overstate a
    // single-device allocation and picking one would be arbitrary; either way
    // the number would look measured. Say it is ambiguous instead.
    return {
      ...base, method: 'nvidia-smi-compute-apps',
      backendHoldsDevice: null, backendVramMiB: null,
      limitation:
        `driver lists ${rows.length} compute allocations for this pid (multiple devices); ` +
        'placement is ambiguous and is not attributed to one device',
    };
  }

  const mine = rows[0] as ComputeApp;
  if (mine.usedMiB === null) {
    return {
      ...base, method: 'nvidia-smi-compute-apps',
      backendHoldsDevice: null, backendVramMiB: null,
      limitation:
        'driver listed this pid but reported no parseable memory figure, so the ' +
        'allocation cannot be checked against the floor',
    };
  }

  if (mine.usedMiB < o.floorMiB) {
    // Listed, but holding less than a loaded model could possibly occupy. The
    // service assertion refuses this; so does the API, so both mean one thing
    // by "placed".
    return {
      ...base, method: 'nvidia-smi-compute-apps',
      backendHoldsDevice: false, backendVramMiB: mine.usedMiB,
      limitation:
        `driver lists this pid holding ${mine.usedMiB} MiB, below the ${o.floorMiB} MiB ` +
        'floor a loaded model requires',
    };
  }

  return {
    ...base, method: 'nvidia-smi-compute-apps',
    backendHoldsDevice: true, backendVramMiB: mine.usedMiB, limitation: null,
  };
}
