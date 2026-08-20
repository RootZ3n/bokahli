import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

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
}

export class ConfigError extends Error {}

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
