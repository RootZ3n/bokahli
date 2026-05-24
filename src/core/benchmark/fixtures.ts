import type { BenchmarkId } from "./registry.js";

export interface BenchmarkCandidateResult {
  benchmarkId: string;
  changedFiles: readonly string[];
  fileContents: Readonly<Record<string, string>>;
  notes?: readonly string[];
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

export const benchmarkFixtures = [docsSingleFileEditFixture, configSingleFileEditFixture] as const satisfies readonly BenchmarkFixtureMetadata[];
