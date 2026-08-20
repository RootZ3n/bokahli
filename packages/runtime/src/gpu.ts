import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GpuLeaseHolder, GpuSnapshot } from '@bokahli/contracts';

const run = promisify(execFile);

export interface GpuLeaseState {
  readonly snapshot: GpuSnapshot | null;
  /** Compute processes other than our backend that hold meaningful VRAM. */
  readonly foreignHolders: readonly GpuLeaseHolder[];
  /** True when Bokahli may proceed: no foreign holder above the threshold. */
  readonly leaseAvailable: boolean;
  readonly error: string | null;
}

export interface GpuMonitorOptions {
  /**
   * VRAM a foreign compute process must hold before it counts as a lease
   * holder. The KDE compositor and browsers register as compute apps with tens
   * of MiB; ComfyUI or a second inference server registers with GiB. Measured
   * desktop baseline on Mushin is ~785 MiB across all display processes.
   */
  readonly foreignHolderThresholdMiB: number;
  /** PIDs belonging to our own backend, exempt from lease checks. */
  readonly ownPids: readonly number[];
  readonly timeoutMs: number;
}

export const DEFAULT_GPU_OPTIONS: GpuMonitorOptions = {
  foreignHolderThresholdMiB: 512,
  ownPids: [],
  timeoutMs: 4000,
};

export type OwnPidResolver = () => Promise<readonly number[]>;

export class GpuMonitor {
  #opts: GpuMonitorOptions;
  #resolver: OwnPidResolver | null = null;

  constructor(opts: Partial<GpuMonitorOptions> = {}) {
    this.#opts = { ...DEFAULT_GPU_OPTIONS, ...opts };
  }

  setOwnPids(pids: readonly number[]): void {
    this.#opts = { ...this.#opts, ownPids: pids };
  }

  /**
   * Supply a way to re-discover our own backend pids.
   *
   * A startup-time snapshot goes stale the moment the backend restarts — and
   * `Restart=on-failure` restarts it without restarting us. A stale snapshot
   * makes our own inference server look like a competing GPU consumer, which
   * would turn every subsequent request into a false capacity failure. The
   * resolver runs only when a foreign holder is actually seen, so the common
   * path stays a single nvidia-smi read.
   */
  setOwnPidResolver(resolver: OwnPidResolver): void {
    this.#resolver = resolver;
  }

  async read(): Promise<GpuLeaseState> {
    try {
      const [snapshot, holders] = await Promise.all([this.#querySnapshot(), this.#queryApps()]);
      const isForeign = (h: GpuLeaseHolder): boolean =>
        !this.#opts.ownPids.includes(h.pid) &&
        h.usedMiB >= this.#opts.foreignHolderThresholdMiB;

      let foreign = holders.filter(isForeign);
      if (foreign.length > 0 && this.#resolver) {
        // Could be our own backend under a new pid. Re-resolve before
        // declaring contention.
        try {
          this.setOwnPids(await this.#resolver());
          foreign = holders.filter(isForeign);
        } catch {
          // Resolution failed; fall through with the stale set rather than
          // silently claiming the lease is free.
        }
      }
      return {
        snapshot,
        foreignHolders: foreign,
        leaseAvailable: foreign.length === 0,
        error: null,
      };
    } catch (err) {
      // Fail open on telemetry, closed on nothing: if we cannot read the GPU we
      // report the error but do not invent a lease conflict.
      return {
        snapshot: null,
        foreignHolders: [],
        leaseAvailable: true,
        error: (err as Error).message,
      };
    }
  }

  async #querySnapshot(): Promise<GpuSnapshot> {
    const { stdout } = await run(
      'nvidia-smi',
      [
        '--query-gpu=memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu',
        '--format=csv,noheader,nounits',
      ],
      { timeout: this.#opts.timeoutMs },
    );
    const parts = stdout.trim().split('\n')[0]?.split(',').map((s) => Number(s.trim())) ?? [];
    return {
      totalMiB: parts[0] ?? 0,
      usedMiB: parts[1] ?? 0,
      freeMiB: parts[2] ?? 0,
      utilisationPct: parts[3] ?? 0,
      temperatureC: parts[4] ?? 0,
    };
  }

  async #queryApps(): Promise<GpuLeaseHolder[]> {
    const { stdout } = await run(
      'nvidia-smi',
      ['--query-compute-apps=pid,used_memory,process_name', '--format=csv,noheader,nounits'],
      { timeout: this.#opts.timeoutMs },
    );
    const out: GpuLeaseHolder[] = [];
    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      const [pidRaw, memRaw, ...nameParts] = line.split(',');
      const pid = Number((pidRaw ?? '').trim());
      const usedMiB = Number((memRaw ?? '').trim());
      if (!Number.isFinite(pid) || !Number.isFinite(usedMiB)) continue;
      const full = nameParts.join(',').trim();
      out.push({ pid, usedMiB, processName: basename(full) });
    }
    return out;
  }
}

function basename(p: string): string {
  const cut = p.split(' ')[0] ?? p;
  const idx = cut.lastIndexOf('/');
  return idx >= 0 ? cut.slice(idx + 1) : cut;
}
