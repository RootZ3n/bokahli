import type { BenchmarkId } from "./registry.js";

export interface BenchmarkCandidateResult {
  benchmarkId: string;
  changedFiles: readonly string[];
  fileContents: Readonly<Record<string, string>>;
  notes?: readonly string[];
  evidence?: readonly BenchmarkCandidateEvidence[];
  audit?: BenchmarkCandidateAudit;
}

export interface BenchmarkCandidateEvidence {
  file: string;
  quote?: string;
  reason: string;
}

export type BenchmarkAuditVerdict =
  | "CONTINUE"
  | "RETRY_STEP"
  | "REPACK_CONTEXT"
  | "ASK_CONTEXT_KEEPER"
  | "ESCALATE_MODEL"
  | "ROLLBACK_LAST_STEP"
  | "STOP_UNSAFE"
  | "NEEDS_HUMAN";

export interface BenchmarkCandidateAudit {
  verdict: BenchmarkAuditVerdict;
  reason: string;
  flaggedFiles?: readonly string[];
}

export interface BenchmarkVerificationResult {
  ok: boolean;
  benchmarkId: string;
  passedChecks: string[];
  failedChecks: string[];
  evidence: string[];
}

export interface BenchmarkFixtureMetadata {
  benchmarkId: BenchmarkId;
  fixturePath: string;
  task: string;
  allowedFiles: readonly string[];
  verifierId: string;
}

export const docsSingleFileEditFixture: BenchmarkFixtureMetadata = {
  benchmarkId: "docs_single_file_edit",
  fixturePath: "tests/fixtures/docs-single-file-edit",
  task: 'Update README.md so the Usage section mentions "npm run doctor".',
  allowedFiles: ["README.md", "package.json"],
  verifierId: "docsSingleFileEditVerifier"
};

export const configSingleFileEditFixture: BenchmarkFixtureMetadata = {
  benchmarkId: "config_single_file_edit",
  fixturePath: "tests/fixtures/config-single-file-edit",
  task:
    "Update scintilla.config.json so auditEverySteps is 3 while allowMultiFileWorkerTasks remains false and defaultModelTier remains tier_1.",
  allowedFiles: ["README.md", "package.json", "scintilla.config.json"],
  verifierId: "configSingleFileEditVerifier"
};

export const contextRetrievalOnlyFixture: BenchmarkFixtureMetadata = {
  benchmarkId: "context_retrieval_only",
  fixturePath: "tests/fixtures/context-retrieval-only",
  task: "Identify which files explain the repo context keeper and the drift detection function without changing files.",
  allowedFiles: ["README.md", "docs/ARCHITECTURE.md", "package.json", "src/audit/drift.ts", "src/context/repoMap.ts"],
  verifierId: "contextRetrievalOnlyVerifier"
};

export const scopeViolationDetectionFixture: BenchmarkFixtureMetadata = {
  benchmarkId: "scope_violation_detection",
  fixturePath: "tests/fixtures/scope-violation-detection",
  task: "Audit a candidate change set where only src/allowed.ts is in scope and src/forbidden.ts is out of scope.",
  allowedFiles: ["README.md", "package.json", "src/allowed.ts", "src/forbidden.ts"],
  verifierId: "scopeViolationDetectionVerifier"
};

export const benchmarkFixtures = [
  docsSingleFileEditFixture,
  configSingleFileEditFixture,
  contextRetrievalOnlyFixture,
  scopeViolationDetectionFixture
] as const satisfies readonly BenchmarkFixtureMetadata[];
