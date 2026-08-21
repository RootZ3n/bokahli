import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isTrustMode, type TrustMode } from './trust.js';

export interface BokahliConfig {
  /** Addresses to bind. 0.0.0.0 is rejected at startup, not merely discouraged. */
  readonly bindAddresses: readonly string[];
  readonly port: number;
  readonly catalogPath: string;
  readonly tokenPath: string;
  readonly publicDir: string;
  readonly maxConcurrent: number;
  readonly maxQueueDepth: number;
  readonly queueTimeoutMs: number;
  readonly maxRequestBytes: number;
  /** When false (default) prompt and completion text never enters the log. */
  readonly logPrompts: boolean;
  /** Verify the artifact digest against disk during startup. Adds ~7s per artifact. */
  readonly verifyDigestOnStart: boolean;
  readonly gpuForeignHolderThresholdMiB: number;
  /**
   * How the prompt-injection trust boundary behaves.
   *
   * `enforce` (the default) refuses evidence carrying a block-severity finding.
   * `audit` inspects and fences but never refuses. `off` skips inspection
   * entirely and still publishes a receipt saying so — a boundary that can be
   * disabled invisibly is a boundary nobody can audit.
   *
   * Deliberately configuration and not a request parameter. A caller that could
   * ask for `off` could ask for it in the same breath as sending the evidence
   * the boundary exists to inspect.
   */
  readonly velumMode: TrustMode;
  /**
   * Bytes of content that may be under prompt-injection inspection at once,
   * across every in-flight request.
   *
   * Inspection is synchronous, so scans do not overlap; what accumulates is
   * what each one leaves behind — the caller's raw evidence, the fenced
   * rendering and the transformation map, all retained until the response ends
   * so a citation stays resolvable. Eight megabytes covers the queue at its
   * configured depth and is small beside the heap.
   */
  readonly velumInFlightBytes: number;
  /**
   * Worker threads that inspect content, and the deadline for one job.
   *
   * Two by default. Inspection is synchronous, so it runs off the main thread
   * or it holds the process: a 1 MiB document costs ~2.6 s and a 4 MiB one
   * ~11.3 s, measured. Two is chosen against this machine's real concurrency —
   * one active inference and a shallow queue — and against the fact that the
   * pool refuses rather than queues, so more workers only move where the
   * refusal happens. It never grows under load.
   */
  readonly velumWorkers: number;
  readonly velumJobTimeoutMs: number;
}

export class ConfigError extends Error {}

/**
 * Parse the boundary's mode, refusing anything outside the three states.
 *
 * An unrecognised value is a startup failure, not a fallback to the default: a
 * typo in `BOKAHLI_VELUM_MODE` that silently means `enforce` is survivable, and
 * one that silently means `off` is not, and the parser cannot tell which one an
 * operator has just made.
 */
function parseTrustMode(raw: string | undefined): TrustMode {
  if (raw === undefined || raw === '') return 'enforce';
  if (isTrustMode(raw)) return raw;
  throw new ConfigError(
    `BOKAHLI_VELUM_MODE is ${JSON.stringify(raw)}; expected 'off', 'audit' or 'enforce'`,
  );
}

const FORBIDDEN_BINDS = new Set(['0.0.0.0', '::', '[::]', '*']);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BokahliConfig {
  const repoRoot = resolve(new URL('../../..', import.meta.url).pathname);
  const binds = (env['BOKAHLI_BIND'] ?? '127.0.0.1')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (binds.length === 0) throw new ConfigError('BOKAHLI_BIND resolved to no addresses');
  for (const b of binds) {
    if (FORBIDDEN_BINDS.has(b)) {
      throw new ConfigError(
        `refusing to bind ${b}. Bokahli may be exposed only on loopback and the ` +
          'Tailscale interface; wildcard binds are prohibited by policy.',
      );
    }
  }

  return {
    bindAddresses: binds,
    port: Number(env['BOKAHLI_PORT'] ?? 8080),
    catalogPath: env['BOKAHLI_CATALOG'] ?? resolve(repoRoot, 'catalog/artifacts.json'),
    tokenPath: env['BOKAHLI_TOKEN_PATH'] ?? resolve(homedir(), '.config/bokahli/token'),
    publicDir: env['BOKAHLI_PUBLIC_DIR'] ?? resolve(repoRoot, 'packages/server/public'),
    maxConcurrent: Number(env['BOKAHLI_MAX_CONCURRENT'] ?? 1),
    maxQueueDepth: Number(env['BOKAHLI_MAX_QUEUE_DEPTH'] ?? 8),
    queueTimeoutMs: Number(env['BOKAHLI_QUEUE_TIMEOUT_MS'] ?? 120_000),
    maxRequestBytes: Number(env['BOKAHLI_MAX_REQUEST_BYTES'] ?? 1_048_576),
    logPrompts: env['BOKAHLI_LOG_PROMPTS'] === '1',
    verifyDigestOnStart: env['BOKAHLI_VERIFY_DIGEST'] === '1',
    gpuForeignHolderThresholdMiB: Number(env['BOKAHLI_GPU_FOREIGN_THRESHOLD_MIB'] ?? 512),
    velumMode: parseTrustMode(env['BOKAHLI_VELUM_MODE']),
    velumInFlightBytes: Number(env['BOKAHLI_VELUM_INFLIGHT_BYTES'] ?? 8 * 1024 * 1024),
    velumWorkers: Number(env['BOKAHLI_VELUM_WORKERS'] ?? 2),
    // Generous against the measured 11.3 s worst case at the 4 MiB engine
    // limit, and finite, which is what matters: a scan that runs longer than
    // this has its worker terminated, because nothing else interrupts a
    // synchronous loop.
    velumJobTimeoutMs: Number(env['BOKAHLI_VELUM_JOB_TIMEOUT_MS'] ?? 30_000),
  };
}

/**
 * Load the bearer token, generating one on first run. The file is 0600 and the
 * token is never logged, echoed, or included in any response body.
 */
export async function loadOrCreateToken(tokenPath: string, env = process.env): Promise<string> {
  const fromEnv = env['BOKAHLI_TOKEN'];
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  if (fromEnv && fromEnv.length < 32) {
    throw new ConfigError('BOKAHLI_TOKEN must be at least 32 characters');
  }
  try {
    const existing = (await readFile(tokenPath, 'utf8')).trim();
    if (existing.length >= 32) return existing;
  } catch {
    // fall through to generation
  }
  const token = randomBytes(32).toString('base64url');
  await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
  await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
  await chmod(tokenPath, 0o600);
  return token;
}
