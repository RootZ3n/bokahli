/**
 * Operational profiles: the exact, validated way a runtime may be started.
 *
 * WHY A PROFILE IS NOT A COMMAND LINE. The campaign that produced these numbers drove
 * llama-server through a shell script with interpolated flags, which is fine for a benchmark and
 * unacceptable for an authenticated activation route. A caller that can name a profile can start
 * a measured configuration; a caller that can pass flags can start anything, including a model
 * path that is not in the catalog and a placement nobody measured.
 *
 * So a profile is DATA, validated on load, and the argv is constructed from it here. There is no
 * field through which a raw flag string can arrive, and the constructor writes the whole argv, so
 * a knob it does not emit cannot be set by forgetting to forbid it.
 *
 * PLACEMENT IS REQUESTED, NEVER ASSUMED. `gpuLayers` is what will be asked for. What actually
 * landed on the device is read back from the process afterwards and compared. The two are kept in
 * separate fields for the whole of their lives because on this host they have genuinely differed:
 * ngl 999 fails outright, and the difference between "asked for 60" and "60 are resident" is the
 * difference between a profile and a hope.
 */

/** Cache types llama.cpp accepts for K/V. A closed set: anything else is refused, not passed through. */
export const CACHE_TYPES = ['f32', 'f16', 'bf16', 'q8_0', 'q5_1', 'q5_0', 'q4_1', 'q4_0'] as const;
export type CacheType = (typeof CACHE_TYPES)[number];

export const FLASH_ATTN = ['on', 'off', 'auto'] as const;
export type FlashAttn = (typeof FLASH_ATTN)[number];

export const REASONING = ['on', 'off', 'auto'] as const;
export type Reasoning = (typeof REASONING)[number];

/** Bounds. Deliberately narrow: these are the ranges this host has been measured across. */
const BOUNDS = {
  contextTokens: [512, 262144],
  gpuLayers: [0, 999],
  threads: [1, 22],        // 24 logical CPUs minus the two excluded for miscomputation
  threadsBatch: [1, 22],
  batchSize: [1, 8192],
  ubatchSize: [1, 8192],
  parallelSlots: [1, 8],
  minFreeVramMiB: [0, 24576],
} as const;

export interface OperationalProfile {
  readonly profileId: string;
  readonly modelId: string;
  /** The artifact this profile is bound to. A profile is meaningless without it. */
  readonly artifactDigest: string;
  readonly contextTokens: number;
  readonly gpuLayers: number;
  readonly cacheTypeK: CacheType;
  readonly cacheTypeV: CacheType;
  readonly threads: number;
  readonly threadsBatch: number;
  readonly batchSize: number | null;
  readonly ubatchSize: number | null;
  readonly parallelSlots: number;
  readonly flashAttn: FlashAttn;
  readonly reasoning: Reasoning;
  /**
   * Free VRAM required before this profile may be activated, from measurement.
   *
   * Activation compares this against live free VRAM and returns a typed capacity refusal when it
   * does not fit. It never reduces `gpuLayers` to make something fit: a silently smaller placement
   * is a different profile with different numbers, reported under a name that promises these ones.
   */
  readonly minFreeVramMiB: number;
  readonly intendedTaskClasses: readonly string[];
  readonly constrainedOutputRequired: boolean;
  readonly supervisedOnly: boolean;
  readonly autonomousPromotionAllowed: false;
  readonly note: string;
}

export class ProfileError extends Error {}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

function bounded(id: string, field: keyof typeof BOUNDS, v: unknown): number {
  const [lo, hi] = BOUNDS[field];
  if (!isInt(v) || v < lo || v > hi) {
    throw new ProfileError(`profile ${id}: ${field} must be an integer in [${lo}, ${hi}], got ${JSON.stringify(v)}`);
  }
  return v;
}

function enumOf<T extends readonly string[]>(id: string, field: string, allowed: T, v: unknown): T[number] {
  if (typeof v !== 'string' || !allowed.includes(v)) {
    throw new ProfileError(`profile ${id}: ${field} must be one of ${allowed.join('|')}, got ${JSON.stringify(v)}`);
  }
  return v as T[number];
}

const KNOWN_FIELDS = new Set([
  'profileId', 'modelId', 'artifactDigest', 'contextTokens', 'gpuLayers', 'cacheTypeK', 'cacheTypeV',
  'threads', 'threadsBatch', 'batchSize', 'ubatchSize', 'parallelSlots', 'flashAttn', 'reasoning',
  'minFreeVramMiB', 'intendedTaskClasses', 'constrainedOutputRequired', 'supervisedOnly',
  'autonomousPromotionAllowed', 'note',
]);

/**
 * Validate one profile.
 *
 * UNKNOWN FIELDS ARE REFUSED, not ignored. A profile carrying `extraFlags` or `modelPath` should
 * fail loudly at load rather than be silently dropped and leave whoever wrote it believing it took
 * effect.
 */
export function parseProfile(raw: unknown): OperationalProfile {
  if (typeof raw !== 'object' || raw === null) throw new ProfileError('profile must be an object');
  const o = raw as Record<string, unknown>;
  const id = typeof o.profileId === 'string' ? o.profileId : '<unnamed>';
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(id)) {
    throw new ProfileError(`profile ${JSON.stringify(id)}: profileId must be a stable path-free identifier`);
  }
  for (const k of Object.keys(o)) {
    if (!KNOWN_FIELDS.has(k)) throw new ProfileError(`profile ${id}: unknown field ${JSON.stringify(k)}`);
  }
  for (const req of KNOWN_FIELDS) {
    if (!(req in o)) throw new ProfileError(`profile ${id}: missing required field ${JSON.stringify(req)}`);
  }
  if (typeof o.modelId !== 'string' || o.modelId.length === 0) {
    throw new ProfileError(`profile ${id}: modelId is required`);
  }
  if (typeof o.artifactDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(o.artifactDigest)) {
    throw new ProfileError(`profile ${id}: artifactDigest must be sha256:<64 hex>`);
  }
  if (o.autonomousPromotionAllowed !== false) {
    throw new ProfileError(`profile ${id}: autonomousPromotionAllowed must be literally false`);
  }
  if (!Array.isArray(o.intendedTaskClasses) || o.intendedTaskClasses.some((t) => typeof t !== 'string')) {
    throw new ProfileError(`profile ${id}: intendedTaskClasses must be an array of strings`);
  }
  for (const b of ['constrainedOutputRequired', 'supervisedOnly'] as const) {
    if (typeof o[b] !== 'boolean') throw new ProfileError(`profile ${id}: ${b} must be a boolean`);
  }
  const optInt = (field: 'batchSize' | 'ubatchSize'): number | null =>
    o[field] === null ? null : bounded(id, field, o[field]);

  return Object.freeze({
    profileId: id,
    modelId: o.modelId,
    artifactDigest: o.artifactDigest,
    contextTokens: bounded(id, 'contextTokens', o.contextTokens),
    gpuLayers: bounded(id, 'gpuLayers', o.gpuLayers),
    cacheTypeK: enumOf(id, 'cacheTypeK', CACHE_TYPES, o.cacheTypeK),
    cacheTypeV: enumOf(id, 'cacheTypeV', CACHE_TYPES, o.cacheTypeV),
    threads: bounded(id, 'threads', o.threads),
    threadsBatch: bounded(id, 'threadsBatch', o.threadsBatch),
    batchSize: optInt('batchSize'),
    ubatchSize: optInt('ubatchSize'),
    parallelSlots: bounded(id, 'parallelSlots', o.parallelSlots),
    flashAttn: enumOf(id, 'flashAttn', FLASH_ATTN, o.flashAttn),
    reasoning: enumOf(id, 'reasoning', REASONING, o.reasoning),
    minFreeVramMiB: bounded(id, 'minFreeVramMiB', o.minFreeVramMiB),
    intendedTaskClasses: Object.freeze([...o.intendedTaskClasses] as string[]),
    constrainedOutputRequired: o.constrainedOutputRequired as boolean,
    supervisedOnly: o.supervisedOnly as boolean,
    autonomousPromotionAllowed: false,
    note: typeof o.note === 'string' ? o.note : '',
  });
}

/**
 * The environment a validated profile produces for the runtime launcher.
 *
 * Values only — never a flag string, never anything the shell will re-interpret. Every value here
 * has already passed a closed enum or an integer bound, so the launcher can quote them and stop
 * thinking about it.
 */
export function profileEnv(p: OperationalProfile, artifactPath: string, alias: string): Record<string, string> {
  const env: Record<string, string> = {
    BOKAHLI_MODEL_PATH: artifactPath,
    BOKAHLI_MODEL_ALIAS: alias,
    BOKAHLI_CTX: String(p.contextTokens),
    BOKAHLI_SLOTS: String(p.parallelSlots),
    BOKAHLI_GPU_LAYERS: String(p.gpuLayers),
    BOKAHLI_CACHE_TYPE_K: p.cacheTypeK,
    BOKAHLI_CACHE_TYPE_V: p.cacheTypeV,
    BOKAHLI_THREADS: String(p.threads),
    BOKAHLI_THREADS_BATCH: String(p.threadsBatch),
    BOKAHLI_FLASH_ATTN: p.flashAttn,
    BOKAHLI_REASONING: p.reasoning,
    // Dense model: there are no experts to place. `off` states that rather than leaving the
    // launcher's own default to decide, which is `all` and would emit --cpu-moe for a model that
    // has none.
    BOKAHLI_CPU_MOE: 'off',
    BOKAHLI_PROFILE_ID: p.profileId,
  };
  if (p.batchSize !== null) env.BOKAHLI_BATCH = String(p.batchSize);
  if (p.ubatchSize !== null) env.BOKAHLI_UBATCH = String(p.ubatchSize);
  return env;
}

/** Does this profile fit right now? Compared against live free VRAM, never against a guess. */
export function capacityVerdict(
  p: OperationalProfile,
  freeVramMiB: number,
): { readonly fits: true } | { readonly fits: false; readonly detail: string } {
  if (freeVramMiB >= p.minFreeVramMiB) return { fits: true };
  return {
    fits: false,
    detail:
      `${p.profileId} needs ${p.minFreeVramMiB} MiB of free VRAM and ${freeVramMiB} MiB is free. ` +
      `Refusing rather than reducing placement: a smaller gpuLayers is a different profile with ` +
      `different measured numbers, and reporting it under this name would make the catalog lie.`,
  };
}
