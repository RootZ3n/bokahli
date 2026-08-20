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
  readonly usedMiB: number;
}

export interface PlacementProbeOptions {
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
    const usedMiB = Number((m ?? '').trim());
    if (Number.isFinite(pid) && Number.isFinite(usedMiB)) out.push({ pid, usedMiB });
  }
  return out;
}

export const DEFAULT_PLACEMENT_OPTIONS: PlacementProbeOptions = {
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
    apps = await o.queryComputeApps(o.timeoutMs);
  } catch (err) {
    return {
      ...base,
      method: 'unavailable',
      backendHoldsDevice: null,
      backendVramMiB: null,
      limitation:
        `driver compute-app table unreadable (${(err as Error).message}); ` +
        'placement is unknown, which is not the same as absent',
    };
  }

  const mine = apps.find((a) => a.pid === inputs.backendPid);
  if (mine === undefined) {
    return {
      ...base,
      method: 'nvidia-smi-compute-apps',
      backendHoldsDevice: false,
      backendVramMiB: null,
      limitation: null,
    };
  }

  return {
    ...base,
    method: 'nvidia-smi-compute-apps',
    backendHoldsDevice: true,
    backendVramMiB: mine.usedMiB,
    limitation: null,
  };
}
