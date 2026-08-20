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
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { RuntimeFacts } from '@bokahli/contracts';

const run = promisify(execFile);

/** A single object refuses to be hashed past this size; a build tree is not a model. */
const MAX_OBJECT_BYTES = 512 * 1024 * 1024;
/** Objects whose extension marks them as part of the serving image. */
const OBJECT_PATTERN = /\.so(\.[0-9]+)*$/;

/**
 * Version of the digest construction. Mixed into the preimage.
 *
 * v1 hashed whatever shared objects happened to be in the directory and did not
 * mix in the binding strength, so a `configured-tree` digest and a
 * `process-mapped` digest over the same files collided — the strength label
 * could be dropped and the value would not change.
 */
export const IMAGE_DIGEST_ALGORITHM = 'bokahli.runtime-image.v2' as const;

/**
 * The objects that define a llama.cpp serving image, by basename prefix.
 *
 * Explicit rather than "every .so in the directory". A build tree accumulates
 * unrelated things — `llama-cli`, `llama-bench`, a stale `.so` from a previous
 * build — and including them meant that running a benchmark once changed the
 * identity of the serving image without any of the serving code changing.
 */
const REQUIRED_PREFIXES = ['libggml-base', 'libggml-cpu', 'libggml', 'libllama'] as const;
const OPTIONAL_PREFIXES = ['libggml-cuda', 'libllama-common', 'libllama-server-impl', 'libmtmd'] as const;

function classify(base: string): 'required' | 'optional' | 'ignore' {
  if (!OBJECT_PATTERN.test(base)) return 'ignore';
  const stem = base.slice(0, base.indexOf('.so'));
  if ((REQUIRED_PREFIXES as readonly string[]).includes(stem)) return 'required';
  if ((OPTIONAL_PREFIXES as readonly string[]).includes(stem)) return 'optional';
  return 'ignore';
}

export interface HostFactsSources {
  readonly readProcMaps: (pid: number) => Promise<string>;
  readonly listDir: (dir: string) => Promise<readonly string[]>;
  readonly isSymlink: (path: string) => Promise<boolean>;
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
  isSymlink: async (p) => (await lstat(p)).isSymbolicLink(),
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
  executable: string,
  sources: HostFactsSources,
): Promise<readonly string[]> {
  const names = await sources.listDir(dir);
  const picked = names.filter((n) => classify(n) !== 'ignore').map((n) => join(dir, n));
  // The executable itself, by its exact path — not "any extensionless file",
  // which swept in every other binary the build produced.
  return [executable, ...picked].sort();
}

interface ImageDigest {
  readonly digest: string | null;
  readonly binding: RuntimeFacts['imageDigestBinding'];
  readonly components: readonly string[];
  readonly limitation: string | null;
}

interface DigestOutcome {
  readonly digest: string;
  readonly components: readonly string[];
  /** Required objects that could not be hashed. Non-empty means fail closed. */
  readonly unreadable: readonly string[];
}

async function digestObjects(
  paths: readonly string[],
  binding: RuntimeFacts['imageDigestBinding'],
  sources: HostFactsSources,
): Promise<DigestOutcome | null> {
  const lines: string[] = [];
  const components: string[] = [];
  const unreadable: string[] = [];
  // Sorted by basename so the digest does not depend on directory order, and
  // so two hosts with the same build at different paths agree. Deduplicated,
  // because a path alias would otherwise contribute the same content twice and
  // change the digest without changing the image.
  const seen = new Set<string>();
  const byBase = [...paths].sort((a, b) => basename(a).localeCompare(basename(b)));
  for (const p of byBase) {
    const base = basename(p);
    if (seen.has(base)) continue;
    seen.add(base);
    try {
      // A symlink is refused rather than followed. Following one lets a link
      // in the build tree point the digest at content that is not the content
      // the loader will map, which is a substitution the digest exists to catch.
      if (await sources.isSymlink(p)) {
        unreadable.push(base);
        continue;
      }
      if ((await sources.fileSize(p)) > MAX_OBJECT_BYTES) {
        unreadable.push(base);
        continue;
      }
      const h = await sources.hashFile(p);
      // Basename only. The path is an internal detail and must not be
      // reconstructible from anything that reaches a response.
      lines.push(`${base}:${h}`);
      components.push(base);
    } catch {
      unreadable.push(base);
    }
  }
  if (lines.length === 0) return null;
  return {
    // The binding is part of the preimage, so a weaker observation can never
    // produce a value indistinguishable from a stronger one.
    digest: `sha256:${createHash('sha256')
      .update(`${IMAGE_DIGEST_ALGORITHM}\nbinding=${binding}\n${lines.join('\n')}`)
      .digest('hex')}`,
    components,
    unreadable,
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
      const mapped = mappedTreeObjects(maps, treeRoot).filter(
        (pth) => pth === executablePath || classify(basename(pth)) !== 'ignore',
      );
      if (mapped.length > 0) {
        const d = await digestObjects(mapped, 'process-mapped', sources);
        if (d !== null && d.unreadable.length === 0) {
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

  const objects = await treeObjects(treeRoot, executablePath, sources).catch(
    () => [] as readonly string[],
  );
  const d = await digestObjects(objects, 'configured-tree', sources);
  if (d === null) {
    return {
      digest: null,
      binding: 'unavailable',
      components: [],
      limitation: 'no readable objects in the configured runtime build tree',
    };
  }

  // Fail closed on an incomplete set. A digest computed over a build tree that
  // is missing a required object is still a valid-looking hash, and a reader
  // has no way to tell it apart from one over a complete tree. Before this,
  // a missing libggml silently produced a different digest and called it fine.
  const missingRequired = REQUIRED_PREFIXES.filter(
    (pre) => !d.components.some((c) => c.startsWith(`${pre}.so`)),
  );
  if (missingRequired.length > 0 || d.unreadable.length > 0) {
    const onlyExe = d.components.length === 1;
    return {
      digest: onlyExe ? d.digest : null,
      binding: onlyExe ? 'executable-only' : 'unavailable',
      components: d.components,
      limitation:
        `runtime image incomplete: ${missingRequired.length > 0 ? `missing ${missingRequired.join(', ')}` : ''}` +
        `${missingRequired.length > 0 && d.unreadable.length > 0 ? '; ' : ''}` +
        `${d.unreadable.length > 0 ? `unreadable or symlinked: ${d.unreadable.join(', ')}` : ''}` +
        '. A digest over a partial image is indistinguishable from one over a whole one, ' +
        'so it is not offered as image identity.',
    };
  }

  return {
    digest: d.digest,
    binding: 'configured-tree',
    components: d.components,
    limitation:
      'digest covers the configured build tree, not the object list of the running ' +
      'process: /proc/<pid>/maps is denied under this service sandbox, so the digest ' +
      'proves what is on disk rather than what this process mapped. It is NOT proof ' +
      'of the libraries this process actually mapped.',
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
    imageDigestAlgorithm: image.digest === null ? null : IMAGE_DIGEST_ALGORITHM,
    imageComponents: image.components,
    driverVersion,
    driverSupportedCuda,
    processCudaRuntime,
    cublasVersion,
    limitation: limitations.length > 0 ? limitations.join('; ') : null,
  };
}
