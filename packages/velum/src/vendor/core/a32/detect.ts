/**
 * VENDORED FROM VELUM — DO NOT EDIT.
 *
 *   source: src/core/a32/detect.ts
 *   commit: 5f6738b1e9a6b6ae4e4d54c269f460323bb72254
 *   sync:   node scripts/sync-velum.mjs --sync
 *   verify: node scripts/sync-velum.mjs --check
 *
 * Edits here are erased by the next sync and fail `--check` before then. The
 * boundary that uses this engine is packages/server/src/trust.ts; the contract
 * it reports against is packages/contracts/src/velum.ts.
 */
/**
 * Velum — the A32 detector.
 * ============================================================
 * Runs the registry over normalized text with the Pike VM and reports findings
 * with spans projected back onto the caller's raw bytes.
 *
 * Ported from the operator-owned ABAIYA implementation
 * (`abaiya-policy/detect.rs`, `RootZ3n/abaiya` at `a471252`).
 *
 * Two rules the Rust original establishes and this port keeps:
 *
 *   - **Credential findings carry no span.** A span plus the source text is the
 *     secret. `spanAbsentReason` says why it is missing rather than leaving a
 *     null a reader has to interpret.
 *   - **Credentials are matched on raw text, injections on normalized text.**
 *     Leetspeak folding rewrites `0→o`; applied to a real key it corrupts it,
 *     and a corrupted key matches nothing and cannot be suppressed from logs.
 */
import { createHash } from "node:crypto";
import { decodeUtf8, type ByteSpan } from "../bytes.js";
import { Matcher, VM_LIMITS, type FindOptions } from "../pike/vm.js";
import {
  VelumFindingSet, isCredentialCategory, isVelumCategory, isVelumSeverity,
  type VelumCategory, type VelumFinding, type VelumSeverity,
} from "./categories.js";
import { A32_PATTERNS, DETECTOR_CONTRACT_VERSION, REGISTRY_VERSION, type PatternDefinition } from "./registry.js";
import { normalize, projectToRaw, type MappingFidelity, type NormalizedText } from "./normalize.js";

export const DETECTOR_VERSION = `velum.a32-detector/${DETECTOR_CONTRACT_VERSION}+${REGISTRY_VERSION}` as const;

/**
 * Default aggregate step ceiling for one `scan()`.
 *
 * Generous against the 4 MiB scan limit and the forty-five patterns of the
 * frozen registry — a clean pass over that much evidence measures in the low
 * hundreds of millions — and finite, which the previous arrangement was not.
 */
export const DEFAULT_MAX_TOTAL_STEPS = 500_000_000;

export interface VelumFindingRecord extends VelumFinding {
  /** Where the pattern matched in the text that was scanned. */
  readonly matchSpan: ByteSpan;
  /**
   * Where it points in the caller's raw bytes. Null for credential findings and
   * for material with no raw image.
   */
  readonly sourceSpan: ByteSpan | null;
  readonly spanAbsentReason: "credential-suppressed" | "derived-region" | "unmappable" | null;
  /** How the source span relates to the match. */
  readonly sourceFidelity: MappingFidelity | "unavailable";
  /** For derived material: which decoder produced it. */
  readonly derivedFrom: string | null;
  readonly detectorVersion: string;
  /**
   * Digest of the exact bytes this finding was found in.
   *
   * A finding used to name a span and nothing else, so nothing stopped one
   * document's finding from being resolved against another document's map:
   * `citationFor` accepted a span of 7..39 discovered in one file and happily
   * reported where 7..39 fell in an unrelated one, quoting the wrong text with
   * no error. A span is only meaningful against the bytes it was taken from,
   * and this is which bytes those were.
   */
  readonly contentSha256: string;
  /** Every finding from this engine is rule-based, not model-based. */
  readonly deterministic: true;
  /**
   * A short, evidence-safe description. Names the pattern and the category and
   * never quotes what matched — for credentials that is the secret, and for
   * injections it would put attacker text into logs.
   */
  readonly summary: string;
}

export class DetectorRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DetectorRegistryError";
  }
}

export interface Detection {
  readonly detectorVersion: string;
  readonly registryVersion: string;
  readonly contractVersion: string;
  readonly findings: VelumFindingSet;
  readonly records: readonly VelumFindingRecord[];
  readonly primaryCategory: VelumCategory;
  readonly peakSeverity: VelumSeverity | null;
  readonly normalization: NormalizedText;
  /** Total VM steps. Reported so cost is observable rather than assumed. */
  readonly steps: number;
  readonly wellFormedUtf8: boolean;
  /** Digest of the bytes scanned. Every record repeats it; see `contentSha256`. */
  readonly contentSha256: string;
}

export interface DetectorOptions {
  readonly patterns?: readonly PatternDefinition[];
  readonly maxFindingsPerPattern?: number;
  readonly vm?: FindOptions;
  /**
   * Ceiling on VM steps for a whole `scan()`, across every pattern.
   *
   * `vm.maxSteps` is per pattern, which is not a budget for the call: forty-five
   * patterns each granted two hundred million steps is a stated ceiling of nine
   * billion. This one is shared, and it is what bounds the work an attacker can
   * buy by sending a larger document.
   */
  readonly maxTotalSteps?: number;
}

interface CompiledPattern {
  readonly def: PatternDefinition;
  readonly matcher: Matcher;
}

/**
 * A compiled detector.
 *
 * Compilation happens once. Every pattern is compiled eagerly at construction
 * so a malformed registry is a startup failure rather than a request-time one.
 */
export class Detector {
  readonly patterns: readonly CompiledPattern[];
  readonly maxFindingsPerPattern: number;
  readonly vmOptions: FindOptions;

  readonly maxTotalSteps: number;

  private constructor(patterns: readonly CompiledPattern[], opts: DetectorOptions) {
    this.patterns = patterns;
    this.maxFindingsPerPattern = opts.maxFindingsPerPattern ?? 16;
    this.vmOptions = opts.vm ?? {};
    this.maxTotalSteps = opts.maxTotalSteps ?? DEFAULT_MAX_TOTAL_STEPS;
  }

  /**
   * Compile a detector, validating the registry first.
   *
   * A caller-supplied registry is checked against the same vocabulary the
   * frozen one satisfies: known category, known severity, non-empty unique id.
   * Without it an arbitrary string reached `VelumFindingSet` and, from there,
   * the policy layer — and the type annotation on `A32_PATTERNS` was no
   * protection, because it is a cast over values chosen at run time.
   */
  static create(opts: DetectorOptions = {}): Detector {
    const defs = opts.patterns ?? A32_PATTERNS;
    const seen = new Set<string>();
    for (const def of defs) {
      if (typeof def.id !== "string" || def.id.length === 0) {
        throw new DetectorRegistryError("a pattern has no identity");
      }
      if (seen.has(def.id)) throw new DetectorRegistryError(`duplicate pattern id: ${def.id}`);
      seen.add(def.id);
      if (!isVelumCategory(def.category) || def.category === "safe") {
        throw new DetectorRegistryError(`pattern ${def.id} has category ${JSON.stringify(def.category)}, which is not a finding category`);
      }
      if (!isVelumSeverity(def.severity)) {
        throw new DetectorRegistryError(`pattern ${def.id} has severity ${JSON.stringify(def.severity)}, which is outside the A32 vocabulary`);
      }
    }
    const compiled = defs.map((def) => ({ def, matcher: Matcher.compile(def.body, def.foldCase) }));
    return new Detector(compiled, opts);
  }

  /** The MVP detector: the frozen A32 registry. */
  static mvp(): Detector {
    return Detector.create();
  }

  scan(rawBytes: Uint8Array): Detection {
    const contentSha256 = `sha256:${createHash("sha256").update(rawBytes).digest("hex")}`;
    const raw = decodeUtf8(rawBytes);
    // Injections see the normalized text; credentials see the raw text, so a
    // fold cannot corrupt a secret out of recognition.
    const norm = normalize(rawBytes, { foldLeetspeak: true, decodeBase64: true, removeZeroWidth: true });
    const rawOnly = normalize(rawBytes, { foldLeetspeak: false, decodeBase64: false, removeZeroWidth: false });

    const records: VelumFindingRecord[] = [];
    const findings: VelumFinding[] = [];
    let steps = 0;

    for (const { def, matcher } of this.patterns) {
      const credential = isCredentialCategory(def.category);
      const target = credential ? rawOnly : norm;
      // The per-pattern ceiling is whichever is smaller: what the caller asked
      // for, and what is left of the whole scan's budget. Spending the
      // aggregate is a `MatchLimitExceeded`, which is the same typed refusal a
      // single runaway pattern produces.
      const remaining = this.maxTotalSteps - steps;
      const perPattern = Math.min(this.vmOptions.maxSteps ?? VM_LIMITS.maxSteps, remaining);
      const r = matcher.findAll(target.decoded, {
        limit: this.maxFindingsPerPattern,
        maxSteps: perPattern,
      });
      steps += r.stats.steps;
      if (r.matches.length === 0) continue;

      findings.push({ patternId: def.id, category: def.category, severity: def.severity });

      for (const m of r.matches) {
        const matchSpan: ByteSpan = { startByte: m.startByte, endByte: m.endByte };
        const projection = credential
          ? { raw: null, fidelity: "unavailable" as const, decoder: null }
          : projectToRaw(target, matchSpan);
        const spanAbsentReason = credential
          ? ("credential-suppressed" as const)
          : projection.raw === null
            ? ("unmappable" as const)
            : null;
        records.push({
          patternId: def.id,
          category: def.category,
          severity: def.severity,
          matchSpan,
          sourceSpan: credential ? null : projection.raw,
          spanAbsentReason,
          sourceFidelity: credential ? "unavailable" : projection.fidelity,
          derivedFrom: credential ? null : (projection.decoder ?? null),
          detectorVersion: DETECTOR_VERSION,
          contentSha256,
          deterministic: true,
          summary: `pattern ${def.id} (${def.category}, ${def.severity})`,
        });
      }
    }

    const set = VelumFindingSet.create(findings);
    if (typeof set === "string") {
      // Unreachable with the frozen registry — no pattern claims `safe` and ids
      // are unique — but a caller-supplied registry could. Failing loudly beats
      // reporting a set whose ordering rules were violated.
      throw new Error(`detector produced an invalid finding set: ${set}`);
    }

    return {
      detectorVersion: DETECTOR_VERSION,
      registryVersion: REGISTRY_VERSION,
      contractVersion: DETECTOR_CONTRACT_VERSION,
      findings: set,
      records: Object.freeze(records),
      primaryCategory: set.primaryCategory,
      peakSeverity: set.peakSeverity,
      normalization: norm,
      steps,
      wellFormedUtf8: raw.wellFormed,
      contentSha256,
    };
  }

  scanText(text: string): Detection {
    return this.scan(new TextEncoder().encode(text));
  }
}
