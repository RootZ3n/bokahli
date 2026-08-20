/**
 * Typed task classes.
 *
 * A task class is a versioned pair of contracts — what a caller may send, and
 * what a model must return — plus the rules that decide whether a returned
 * answer is *grounded*. Qualification is keyed to a task class and its contract
 * version (see qualification.ts), so changing either of these shapes
 * invalidates every verdict earned under the old one. That is the point:
 * evidence for answering one question shape is not evidence for another.
 *
 * Two properties are load-bearing in both task classes here:
 *
 *   - **Citations are into supplied input, and nothing else.** Every claim must
 *     point at a span of text the caller handed over. A citation that cannot be
 *     resolved is a contract violation, not a stylistic lapse.
 *   - **Observed fact and inference are different fields.** A model may say
 *     "line 41 says ECONNREFUSED" and it may say "the service was probably not
 *     listening", but it may not present the second as the first.
 *
 * Bokahli gains no filesystem, shell, or repository access from any of this.
 * `repo_reconnaissance` operates on an evidence packet the caller assembles and
 * sends; Bokahli reads what it is given and nothing else.
 */

export const TASK_CLASSES = ['test_log_triage', 'repo_reconnaissance'] as const;
export type TaskClass = (typeof TASK_CLASSES)[number];

export function isTaskClass(value: unknown): value is TaskClass {
  return typeof value === 'string' && (TASK_CLASSES as readonly string[]).includes(value);
}

export const TEST_LOG_TRIAGE_CONTRACT_VERSION = '1.0.0' as const;
export const REPO_RECONNAISSANCE_CONTRACT_VERSION = '1.0.0' as const;

export const TASK_CLASS_CONTRACT_VERSIONS: Readonly<Record<TaskClass, string>> = Object.freeze({
  test_log_triage: TEST_LOG_TRIAGE_CONTRACT_VERSION,
  repo_reconnaissance: REPO_RECONNAISSANCE_CONTRACT_VERSION,
});

/**
 * Budgets a caller may impose. Bounds are part of the contract because an
 * unbounded input is not a task, it is a hope.
 */
export interface TaskBudgets {
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  readonly deadlineMs: number;
}

/** Hard input ceilings. A request above these is rejected, not truncated. */
export const MAX_LOG_BYTES = 1_048_576;
export const MAX_LOG_LINES = 20_000;
export const MAX_PACKET_BYTES = 4_194_304;
export const MAX_PACKET_FILES = 512;

// ---------------------------------------------------------------------------
// Shared output vocabulary
// ---------------------------------------------------------------------------

/**
 * How a task attempt ended.
 *
 * ABSTAINED is a first-class success of a kind: a model that says "the supplied
 * log does not contain enough to localise this" has answered correctly, and
 * scoring must be able to tell that apart from a wrong answer. ESCALATE is the
 * model declining for a stated, typed reason.
 */
export type TaskOutcome = 'ANSWERED' | 'ABSTAINED' | 'ESCALATE';

export type TaskAbstentionReason =
  | 'INSUFFICIENT_EVIDENCE'
  | 'AMBIGUOUS_INPUT'
  | 'OUT_OF_SCOPE'
  | 'BUDGET_EXCEEDED';

export interface TaskAbstention {
  readonly reason: TaskAbstentionReason;
  readonly detail: string;
  /** What the caller could supply to make the task answerable. */
  readonly wouldNeed: readonly string[];
}

export type TaskEscalationReason =
  | 'CAPABILITY_UNSUPPORTED'
  | 'INPUT_EXCEEDS_BUDGET'
  | 'CONTRACT_VERSION_UNSUPPORTED'
  | 'RUNTIME_UNHEALTHY';

export interface TaskEscalation {
  readonly reason: TaskEscalationReason;
  readonly detail: string;
  readonly retryableLocal: boolean;
}

/**
 * A citation into the caller's own input.
 *
 * `quote` is optional but checked when present: if the model quotes text, the
 * text must actually be there. Lines are 1-based and inclusive, matching how
 * every log viewer and editor a human will cross-check against numbers them.
 */
export interface Citation {
  /** Present for repo_reconnaissance; null for a single-document log. */
  readonly path: string | null;
  readonly startLine: number;
  readonly endLine: number;
  readonly quote: string | null;
}

/**
 * A statement the model asserts is directly present in the input, with the
 * citation that shows it.
 */
export interface ObservedFact {
  readonly statement: string;
  readonly citations: readonly Citation[];
}

/**
 * A statement the model derived rather than read. Kept structurally separate
 * from ObservedFact so a consumer cannot mistake one for the other, and so a
 * scorer can grade them differently.
 */
export interface Inference {
  readonly statement: string;
  /** The observed facts this rests on. */
  readonly basedOn: readonly Citation[];
  /** 0..1, or null when the model declines to quantify. */
  readonly confidence: number | null;
}

/** What the model actually looked at, and what it did not. */
export interface CoverageReport {
  readonly truncated: boolean;
  /** Ranges present in the input that were not considered. */
  readonly omitted: readonly { readonly path: string | null; readonly startLine: number; readonly endLine: number; readonly reason: string }[];
  readonly note: string | null;
}

// ---------------------------------------------------------------------------
// test_log_triage
// ---------------------------------------------------------------------------

export interface TestLogSource {
  /** e.g. "vitest", "pytest", "cargo test". */
  readonly tool: string | null;
  readonly command: string | null;
  readonly exitCode: number | null;
  readonly capturedAt: string | null;
}

export interface TestLogTriageRequest {
  readonly taskClass: 'test_log_triage';
  readonly contractVersion: string;
  /** Output schema version the caller requires. Refused if unsupported. */
  readonly outputSchemaVersion: string;
  /** The log itself. Bounded by MAX_LOG_BYTES / MAX_LOG_LINES. */
  readonly logText: string;
  readonly source: TestLogSource | null;
  readonly budgets: TaskBudgets;
}

export type FailureClassification =
  | 'ASSERTION_FAILURE'
  | 'ERROR_OR_EXCEPTION'
  | 'TIMEOUT'
  | 'BUILD_OR_COMPILE_FAILURE'
  | 'DEPENDENCY_OR_IMPORT_FAILURE'
  | 'ENVIRONMENT_OR_CONFIG'
  | 'FLAKE_OR_NONDETERMINISM'
  | 'INFRASTRUCTURE'
  | 'UNCLASSIFIED';

export type DiagnosticActionKind =
  | 'RERUN'
  | 'INSPECT_FILE'
  | 'INSPECT_CONFIG'
  | 'COLLECT_MORE_LOGS'
  | 'CHECK_DEPENDENCY'
  | 'CHECK_ENVIRONMENT'
  | 'BISECT'
  | 'NONE';

export interface SuggestedDiagnosticAction {
  readonly kind: DiagnosticActionKind;
  readonly detail: string;
  /** Why this action, grounded in what was observed. */
  readonly rationale: string;
}

export interface FailureGroup {
  readonly groupId: string;
  readonly classification: FailureClassification;
  /** At least one. A group with no citation is not grounded and is rejected. */
  readonly citations: readonly Citation[];
  /** What the log says. */
  readonly observed: readonly ObservedFact[];
  /** What the model concludes from it. Null when it will not guess. */
  readonly probableCause: Inference | null;
  readonly suggestedAction: SuggestedDiagnosticAction | null;
  /** Tests or cases this group covers, as named in the log. */
  readonly affectedTests: readonly string[];
  readonly confidence: number | null;
}

export interface TestLogTriageResult {
  readonly taskClass: 'test_log_triage';
  readonly contractVersion: string;
  readonly outputSchemaVersion: string;
  readonly outcome: TaskOutcome;
  readonly failureGroups: readonly FailureGroup[];
  readonly coverage: CoverageReport;
  readonly abstention: TaskAbstention | null;
  readonly escalation: TaskEscalation | null;
}

// ---------------------------------------------------------------------------
// repo_reconnaissance
// ---------------------------------------------------------------------------

/**
 * One file's worth of supplied evidence.
 *
 * Excerpts carry their own line offsets so a citation into an excerpt maps back
 * to the real file. `contentSha256` lets a caller prove later which revision it
 * showed; Bokahli records it and does not fetch anything to check it.
 */
export interface EvidenceFile {
  readonly path: string;
  readonly contentSha256: string | null;
  /** Total lines in the real file, which may exceed what was supplied. */
  readonly totalLines: number | null;
  readonly excerpts: readonly {
    readonly startLine: number;
    readonly endLine: number;
    readonly text: string;
  }[];
}

/**
 * A bounded, caller-assembled view of a repository.
 *
 * This is the whole world for a repo_reconnaissance task. Bokahli does not read
 * the filesystem, resolve paths, follow imports, or fetch anything not in here.
 * `allowedPaths` is an explicit allowlist and a citation outside it is a
 * violation even if the packet happens to contain the file.
 */
export interface RepoEvidencePacket {
  readonly packetId: string;
  /** Canonical hash of the packet, for audit. Bokahli verifies if supplied. */
  readonly packetHash: string | null;
  readonly repoRef: string | null;
  readonly commit: string | null;
  readonly files: readonly EvidenceFile[];
  readonly allowedPaths: readonly string[];
  readonly truncated: boolean;
  /** Paths deliberately withheld, and why. */
  readonly omittedPaths: readonly { readonly path: string; readonly reason: string }[];
}

export interface RepoReconnaissanceRequest {
  readonly taskClass: 'repo_reconnaissance';
  readonly contractVersion: string;
  readonly outputSchemaVersion: string;
  readonly question: string;
  readonly packet: RepoEvidencePacket;
  readonly budgets: TaskBudgets;
}

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'constant'
  | 'variable'
  | 'module'
  | 'route'
  | 'config_key'
  | 'other';

export interface RelevantFile {
  readonly path: string;
  readonly whyRelevant: string;
  readonly citations: readonly Citation[];
}

export interface RelevantSymbol {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly path: string;
  readonly citations: readonly Citation[];
}

export type RelationshipKind =
  | 'imports'
  | 'exports'
  | 'calls'
  | 'implements'
  | 'extends'
  | 'configures'
  | 'tests'
  | 'depends_on';

/**
 * A relationship between two parts of the packet.
 *
 * `basis` says whether the model *saw* the relationship in the supplied text or
 * *deduced* it. An import statement in an excerpt is OBSERVED; "this probably
 * calls the auth middleware" is INFERRED, and must not be dressed as the first.
 */
export interface RelationshipFinding {
  readonly from: string;
  readonly to: string;
  readonly kind: RelationshipKind;
  readonly basis: 'OBSERVED' | 'INFERRED';
  readonly citations: readonly Citation[];
}

export interface RepoReconnaissanceResult {
  readonly taskClass: 'repo_reconnaissance';
  readonly contractVersion: string;
  readonly outputSchemaVersion: string;
  readonly outcome: TaskOutcome;
  readonly answer: string | null;
  readonly relevantFiles: readonly RelevantFile[];
  readonly relevantSymbols: readonly RelevantSymbol[];
  readonly relationships: readonly RelationshipFinding[];
  readonly observed: readonly ObservedFact[];
  readonly inferences: readonly Inference[];
  readonly coverage: RepoCoverageReport;
  readonly abstention: TaskAbstention | null;
  readonly escalation: TaskEscalation | null;
}

export interface RepoCoverageReport extends CoverageReport {
  readonly filesInPacket: number;
  readonly filesExamined: number;
  /** Context the model judged relevant but was not given. */
  readonly omittedContext: readonly string[];
}

// ---------------------------------------------------------------------------
// Grounding violations
// ---------------------------------------------------------------------------

export type GroundingViolationCode =
  /** A group, finding, or answer carries no citation at all. */
  | 'CITATION_MISSING'
  /** Cited line range is outside the supplied input. */
  | 'CITATION_OUT_OF_RANGE'
  /** Cited path is not in the packet. */
  | 'CITATION_UNKNOWN_PATH'
  /** Cited path is in the packet but outside allowedPaths. */
  | 'CITATION_PATH_NOT_ALLOWED'
  /** The quoted text is not what the cited span says. */
  | 'CITATION_QUOTE_MISMATCH'
  /** startLine > endLine, or a non-positive line number. */
  | 'CITATION_MALFORMED'
  /** An inference was presented in a field reserved for observed fact. */
  | 'INFERENCE_PRESENTED_AS_FACT'
  /** Declared outcome does not match the content, e.g. ANSWERED with nothing. */
  | 'OUTCOME_INCONSISTENT'
  /** Contract or output schema version is not one this build implements. */
  | 'CONTRACT_VERSION_UNSUPPORTED'
  /** Required field missing or of the wrong type. */
  | 'MALFORMED_RESULT'
  /** Input exceeded a declared bound. */
  | 'INPUT_BOUND_EXCEEDED';

export interface GroundingViolation {
  readonly code: GroundingViolationCode;
  readonly detail: string;
  readonly field: string | null;
  readonly citation: Citation | null;
}

export type TaskValidation =
  | { readonly valid: true; readonly violations: readonly [] }
  | { readonly valid: false; readonly violations: readonly GroundingViolation[] };
