/**
 * What the serving binary is, and which CUDA it actually uses.
 *
 * Two things here are easy to get wrong in a way that reads as strong evidence.
 *
 * **The digest.** `llama-server` on this host is 12,528 bytes — a stub. The
 * CUDA backend is 44 MB of `libggml-cuda`, and the inference code is in
 * `libllama` and `libllama-server-impl` beside it. Hashing the stub alone would
 * produce a digest that survives a complete rebuild of everything that does the
 * work, which is worse than no digest: it would look like proof and prove
 * nothing. So the digest is composite, over the stub and the build tree's own
 * shared objects, each contributing `basename:sha256` in sorted order.
 *
 * **The CUDA version.** `nvidia-smi` prints a CUDA version in its header. That
 * is the highest version the installed *driver* can support — a capability of
 * the driver, not a description of the process. On this host the driver
 * advertises 13.2 while the serving process has `libcudart.so.13.2.51` and
 * `libcublas.so.13.3.0.5` mapped. Reporting the header number as "the CUDA the
 * runtime uses" would be copying a marketing string into a stronger field, so
 * the two are separate fields with separate names.
 *
 * Binding either to the *running process* wants `/proc/<pid>/maps`, and that is
 * denied under the API's systemd sandbox — measured on this host, where
 * `cmdline` and `stat` are readable and `maps` and `exe` are not. So the strong
 * form is attempted and the fallback announces itself through
 * `imageDigestBinding` rather than passing silently as the strong one.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { RuntimeFacts } from '@bokahli/contracts';

const run = promisify(execFile);

/** A single object refuses to be hashed past this size; a build tree is not a model. */
const MAX_OBJECT_BYTES = 512 * 1024 * 1024;
/** Objects whose extension marks them as part of the serving image. */
const OBJECT_PATTERN = /\.so(\.\d+)*$/;

export interface HostFactsSources {
  readonly readProcMaps: (pid: number) => Promise<string>;
  readonly listDir: (dir: string) => Promise<readonly string[]>;
  readonly hashFile: (path: string) => Promise<string>;
  readonly fileSize: (path: string) => Promise<number>;
  readonly nvidiaSmi: (args: readonly string[]) => Promise<string>;
  readonly now: () => Date;
}

async function sha256File(path: string): Promise<string> {
  // Read-and-hash rather than stream: these are tens of MB, hashed once per
  // backend instance, and a stream here would add failure modes for no gain.
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}

export const REAL_HOST_SOURCES: HostFactsSources = {
  readProcMaps: (pid) => readFile(`/proc/${pid}/maps`, 'utf8'),
  listDir: (dir) => readdir(dir),
  hashFile: sha256File,
  fileSize: async (p) => (await stat(p)).size,
  nvidiaSmi: async (args) => (await run('nvidia-smi', [...args], { timeout: 4000 })).stdout,
  now: () => new Date(),
};

/**
 * The build-tree objects a process has actually mapped.
 *
 * Restricted to files under `treeRoot` so that system libraries — libc, the
 * driver's own `libcuda` — are excluded. Those are host facts, not identity of
 * the llama.cpp build, and folding them in would make the digest change on
 * every unrelated system update.
 */
function mappedTreeObjects(maps: string, treeRoot: string): readonly string[] {
  const found = new Set<string>();
  for (const line of maps.split('\n')) {
    const sp = line.indexOf('/');
    if (sp < 0) continue;
    const path = line.slice(sp).trim();
    if (path.startsWith(`${treeRoot}/`) || path === treeRoot) found.add(path);
  }
  return [...found].sort();
}

async function treeObjects(
  dir: string,
  sources: HostFactsSources,
): Promise<readonly string[]> {
  const names = await sources.listDir(dir);
  return names
    .filter((n) => OBJECT_PATTERN.test(n) || !n.includes('.'))
    .map((n) => join(dir, n))
    .sort();
}

interface ImageDigest {
  readonly digest: string | null;
  readonly binding: RuntimeFacts['imageDigestBinding'];
  readonly components: readonly string[];
  readonly limitation: string | null;
}

async function digestObjects(
  paths: readonly string[],
  sources: HostFactsSources,
): Promise<{ digest: string; components: readonly string[] } | null> {
  const lines: string[] = [];
  const components: string[] = [];
  // Sorted by basename so the digest does not depend on directory order, and
  // so two hosts with the same build at different paths agree.
  const byBase = [...paths].sort((a, b) => basename(a).localeCompare(basename(b)));
  for (const p of byBase) {
    try {
      if ((await sources.fileSize(p)) > MAX_OBJECT_BYTES) continue;
      const h = await sources.hashFile(p);
      // Basename only. The path is an internal detail and must not be
      // reconstructible from anything that reaches a response.
      lines.push(`${basename(p)}:${h}`);
      components.push(basename(p));
    } catch {
      continue; // an object we cannot read cannot contribute
    }
  }
  if (lines.length === 0) return null;
  return {
    digest: `sha256:${createHash('sha256')
      .update(`bokahli.runtime-image.v1\n${lines.join('\n')}`)
      .digest('hex')}`,
    components,
  };
}

async function resolveImageDigest(
  executablePath: string,
  backendPid: number | null,
  sources: HostFactsSources,
): Promise<ImageDigest> {
  const treeRoot = dirname(executablePath);

  // Strong form first: hash exactly what this process mapped.
  if (backendPid !== null) {
    try {
      const maps = await sources.readProcMaps(backendPid);
      const mapped = mappedTreeObjects(maps, treeRoot);
      if (mapped.length > 0) {
        const d = await digestObjects(mapped, sources);
        if (d !== null) {
          return {
            digest: d.digest,
            binding: 'process-mapped',
            components: d.components,
            limitation: null,
          };
        }
      }
    } catch {
      // Expected in production; the fallback says so rather than pretending.
    }
  }

  const objects = await treeObjects(treeRoot, sources).catch(() => [] as readonly string[]);
  const d = await digestObjects(objects, sources);
  if (d === null) {
    return {
      digest: null,
      binding: 'unavailable',
      components: [],
      limitation: 'no readable objects in the configured runtime build tree',
    };
  }
  return {
    digest: d.digest,
    binding: 'configured-tree',
    components: d.components,
    limitation:
      'digest covers the configured build tree, not the object list of the running ' +
      'process: /proc/<pid>/maps is denied under this service sandbox, so the digest ' +
      'proves what is on disk rather than what this process mapped',
  };
}

/** Which CUDA and driver libraries the process has loaded, by soname version. */
function cudaFromMaps(maps: string): {
  processCudaRuntime: string | null;
  cublasVersion: string | null;
  driverLib: string | null;
} {
  const pick = (re: RegExp): string | null => {
    const m = maps.match(re);
    return m?.[1] ?? null;
  };
  return {
    processCudaRuntime: pick(/libcudart\.so\.([0-9.]+)/),
    cublasVersion: pick(/libcublas\.so\.([0-9.]+)/),
    driverLib: pick(/libcuda\.so\.([0-9.]+)/),
  };
}

export interface HostFactsInputs {
  /** INTERNAL ONLY. Never serialised; only its basenames leave this module. */
  readonly executablePath: string;
  readonly backendPid: number | null;
  readonly build: string | null;
}

/**
 * Collect runtime facts. Never throws; unknowns stay null with a reason.
 */
export async function probeRuntimeFacts(
  inputs: HostFactsInputs,
  sources: HostFactsSources = REAL_HOST_SOURCES,
): Promise<RuntimeFacts> {
  const observedAt = sources.now().toISOString();
  const limitations: string[] = [];

  const image = await resolveImageDigest(inputs.executablePath, inputs.backendPid, sources);
  if (image.limitation !== null) limitations.push(image.limitation);

  let driverVersion: string | null = null;
  let driverSupportedCuda: string | null = null;
  try {
    driverVersion = (await sources.nvidiaSmi(['--query-gpu=driver_version', '--format=csv,noheader'])).trim() || null;
  } catch (err) {
    limitations.push(`driver version unavailable: ${(err as Error).message}`);
  }
  try {
    // The header line is the only place nvidia-smi prints the driver's maximum
    // supported CUDA. It is a capability of the driver and is named as one.
    const header = await sources.nvidiaSmi([]);
    driverSupportedCuda = header.match(/CUDA Version:\s*([0-9.]+)/)?.[1] ?? null;
  } catch {
    // Already covered by the driver-version limitation if that also failed.
  }

  let processCudaRuntime: string | null = null;
  let cublasVersion: string | null = null;
  if (inputs.backendPid !== null) {
    try {
      const maps = await sources.readProcMaps(inputs.backendPid);
      const c = cudaFromMaps(maps);
      processCudaRuntime = c.processCudaRuntime;
      cublasVersion = c.cublasVersion;
    } catch {
      limitations.push(
        'CUDA runtime in use by the backend is unavailable: /proc/<pid>/maps is denied ' +
          'under this service sandbox, so only the driver-supported version is known',
      );
    }
  }

  return {
    provenance: 'observed',
    observedAt,
    engine: 'llama.cpp',
    build: inputs.build,
    imageDigest: image.digest,
    imageDigestBinding: image.binding,
    imageComponents: image.components,
    driverVersion,
    driverSupportedCuda,
    processCudaRuntime,
    cublasVersion,
    limitation: limitations.length > 0 ? limitations.join('; ') : null,
  };
}
