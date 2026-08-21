/**
 * VENDORED FROM VELUM — DO NOT EDIT.
 *
 *   source: src/core/a32/categories.ts
 *   commit: 5f6738b1e9a6b6ae4e4d54c269f460323bb72254
 *   sync:   node scripts/sync-velum.mjs --sync
 *   verify: node scripts/sync-velum.mjs --check
 *
 * Edits here are erased by the next sync and fail `--check` before then. The
 * boundary that uses this engine is packages/server/src/trust.ts; the contract
 * it reports against is packages/contracts/src/velum.ts.
 */
/**
 * Velum — the A32 four-layer separation.
 * ============================================================
 * Ported from the operator-owned ABAIYA implementation (`abaiya-types/velum.rs`
 * and `abaiya-types/policy.rs`, `RootZ3n/abaiya` at `a471252`) under the
 * operator's reuse and MIT-publication authorization.
 *
 * A32's central move, and the reason this file exists rather than one enum:
 *
 * | Layer | Question | Type |
 * |---|---|---|
 * | A | what did the detector find? | `VelumCategory` |
 * | B | what did policy decide? | `PolicyDecision` |
 * | C | what transformation was applied? | `TransformationApplied` |
 * | D | where may the content go? | `ExportBoundary` |
 *
 * Collapsing them is the failure this vocabulary was written to prevent. A
 * finding is *evidence*; a decision is what someone did about it; a
 * transformation is what happened to the bytes; a boundary is where they may
 * travel. A single `allow | block` enum answers none of those questions and is
 * read as answering all four.
 */

/** Layer A — what the detector found. Six values, frozen against the corpus. */
export type VelumCategory =
  /** The absence of findings. Never appears *inside* a finding. */
  | "safe"
  /** API keys, tokens, private keys, OAuth secrets. */
  | "credential"
  /** Generic instruction-injection text. */
  | "prompt-injection"
  /** An attempt to replace the model's operating instructions. */
  | "instruction-override"
  /** An attempt to alter the model's memory, identity, or values. */
  | "memory-manipulation"
  /** An attempt to probe or escape policy boundaries. */
  | "boundary-probe";

export const VELUM_CATEGORIES: readonly VelumCategory[] = Object.freeze([
  "safe", "credential", "prompt-injection", "instruction-override",
  "memory-manipulation", "boundary-probe",
]);

export const POSITIVE_CATEGORIES: readonly VelumCategory[] = Object.freeze([
  "credential", "prompt-injection", "instruction-override",
  "memory-manipulation", "boundary-probe",
]);

export function isPositiveCategory(c: VelumCategory): boolean {
  return c !== "safe";
}

export function isCredentialCategory(c: VelumCategory): boolean {
  return c === "credential";
}

/** The pattern's severity hint. Not a decision — see `PolicyDecision`. */
export type VelumSeverity = "warn" | "review" | "block";

export const VELUM_SEVERITIES: readonly VelumSeverity[] = Object.freeze(["warn", "review", "block"]);

export function isVelumCategory(c: unknown): c is VelumCategory {
  return typeof c === "string" && (VELUM_CATEGORIES as readonly string[]).includes(c);
}

export function isVelumSeverity(s: unknown): s is VelumSeverity {
  return typeof s === "string" && (VELUM_SEVERITIES as readonly string[]).includes(s);
}

/**
 * Strongest first.
 *
 * Throws on a value outside the vocabulary rather than ranking it. The previous
 * form was `s === "block" ? 0 : s === "review" ? 1 : 2`, which gave every
 * unrecognised severity the *weakest* rank — so a caller-supplied pattern
 * marked `catastrophic` sorted below `warn`, became the peak severity of the
 * set, and mapped to `allow`. A vocabulary this small has no room for a
 * default; `VelumFindingSet.create` rejects unknown values before anything
 * reaches here, and this is the assertion that keeps that true.
 */
function severityRank(s: VelumSeverity): number {
  switch (s) {
    case "block": return 0;
    case "review": return 1;
    case "warn": return 2;
    default: {
      const bad: never = s;
      throw new TypeError(`severity outside the A32 vocabulary: ${JSON.stringify(bad)}`);
    }
  }
}

/**
 * Equal-severity tie order among injection categories (A32 Decision 3.4).
 *
 * `memory-manipulation > instruction-override > boundary-probe >
 * prompt-injection`. Credential never reaches this comparison — it outranks
 * every injection finding one step earlier — and `safe` is not a finding.
 */
function tieRank(c: VelumCategory): number {
  switch (c) {
    case "memory-manipulation": return 0;
    case "instruction-override": return 1;
    case "boundary-probe": return 2;
    case "prompt-injection": return 3;
    // `credential` never reaches this comparison — it outranks every injection
    // one step earlier — and `safe` is not a finding. Both are in the
    // vocabulary, so both are named; anything else is a caller error.
    case "credential":
    case "safe":
      return 4;
    default: {
      const bad: never = c;
      throw new TypeError(`category outside the A32 vocabulary: ${JSON.stringify(bad)}`);
    }
  }
}

/** Layer B — what policy decided. Ascending severity. */
export type PolicyDecision = "allow" | "warn" | "review" | "block";

/** Layer C — what was done to the bytes on the way to the model. */
export type TransformationApplied =
  /** Nothing. The model sees the caller's bytes. */
  | "unchanged"
  /** Wrapped in fence markers with escapes; nothing deleted. */
  | "fenced"
  /** A span was replaced by a marker. Never applied to evidence by Bokahli. */
  | "redacted";

/** Layer D — where the content may go. */
export type ExportBoundary = "internal" | "model" | "external";

/**
 * A finding: pattern identity, category, severity — and nothing that could hold
 * a matched value.
 *
 * The span lives on `VelumFindingRecord` in `detect.ts`, where it can be
 * suppressed per-category. That split is deliberate: an injection finding needs
 * a span so an operator can see which line was hostile, and a credential
 * finding must not have one, because a span plus the source text *is* the
 * secret.
 */
export interface VelumFinding {
  readonly patternId: string;
  readonly category: VelumCategory;
  readonly severity: VelumSeverity;
}

export type FindingSetFailure =
  | "safe-is-not-a-finding"
  | "missing-pattern-identity"
  | "duplicate-pattern"
  | "unknown-category"
  | "unknown-severity";

/**
 * Canonical ordering key.
 *
 * Ascending by this key puts the primary finding first: credentials outrank
 * injections, then strongest severity, then the equal-severity tie order, then
 * pattern identity. Because it is a total order over the finding's own fields,
 * two callers who discovered the same findings in different orders produce
 * byte-identical sets and the same primary category.
 */
function selectionKey(f: VelumFinding): [number, number, number, string] {
  return [isCredentialCategory(f.category) ? 0 : 1, severityRank(f.severity), tieRank(f.category), f.patternId];
}

function compareKeys(a: VelumFinding, b: VelumFinding): number {
  const ka = selectionKey(a);
  const kb = selectionKey(b);
  for (let i = 0; i < 3; i++) {
    const d = (ka[i] as number) - (kb[i] as number);
    if (d !== 0) return d;
  }
  // Code-unit order, not `localeCompare`. Collation is a property of the host:
  // the default collator orders `override_003 < override-003 < Override-003`,
  // and code-unit order does not. "Two callers who discovered the same findings
  // in different orders produce byte-identical sets" is a claim about this
  // comparison, and it was only true on hosts that happened to agree.
  const a3 = ka[3] as string;
  const b3 = kb[3] as string;
  return a3 < b3 ? -1 : a3 > b3 ? 1 : 0;
}

/** An ordered, deduplicated finding set. Input order is discarded. */
export class VelumFindingSet {
  readonly findings: readonly VelumFinding[];

  private constructor(findings: readonly VelumFinding[]) {
    this.findings = findings;
  }

  /**
   * Build a set, or say why not.
   *
   * The vocabulary is checked here, at the only door into a finding set. It was
   * not checked at all before: `create` looked at `safe` and at the pattern id
   * and let every other value through, so a detector constructed with
   * caller-supplied patterns could produce a finding whose category and
   * severity were arbitrary strings. Nothing downstream noticed — the ranking
   * functions gave the unknown severity the weakest rank and the policy layer
   * mapped it to `allow` — so the strongest-sounding finding in the system was
   * the one that did nothing. Six categories and three severities: an input
   * outside them is a caller error, not a weak signal.
   */
  static create(findings: readonly VelumFinding[]): VelumFindingSet | FindingSetFailure {
    const seen = new Set<string>();
    for (const f of findings) {
      if (typeof f.patternId !== "string" || f.patternId.length === 0) {
        return "missing-pattern-identity";
      }
      if (!isVelumCategory(f.category)) return "unknown-category";
      if (!isVelumSeverity(f.severity)) return "unknown-severity";
      if (f.category === "safe") return "safe-is-not-a-finding";
      if (seen.has(f.patternId)) return "duplicate-pattern";
      seen.add(f.patternId);
    }
    return new VelumFindingSet(Object.freeze([...findings].sort(compareKeys)));
  }

  static empty(): VelumFindingSet {
    return new VelumFindingSet(Object.freeze([]));
  }

  get isEmpty(): boolean {
    return this.findings.length === 0;
  }

  /**
   * The single category a wire field must carry when it can hold only one.
   *
   * Derived mechanically from the ordering, never chosen. The complete set is
   * always preserved alongside it (A32 Decision 3): a primary category is a
   * projection for a narrow field, not a summary that replaces the evidence.
   */
  get primaryCategory(): VelumCategory {
    return this.findings[0]?.category ?? "safe";
  }

  /** The strongest severity present, or null when there are no findings. */
  get peakSeverity(): VelumSeverity | null {
    let best: VelumSeverity | null = null;
    for (const f of this.findings) {
      if (best === null || severityRank(f.severity) < severityRank(best)) best = f.severity;
    }
    return best;
  }
}
