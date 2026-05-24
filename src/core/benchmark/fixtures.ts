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
  allowlistFiles: readonly string[];
  verifierId: string;
}

export const docsSingleFileEditFixture: BenchmarkFixtureMetadata = {
  benchmarkId: "docs_single_file_edit",
  fixturePath: "tests/fixtures/docs-single-file-edit",
  task: 'Update README.md so the Usage section mentions "npm run doctor".',
  allowlistFiles: ["README.md", "package.json"],
  verifierId: "docsSingleFileEditVerifier"
};

export const benchmarkFixtures = [docsSingleFileEditFixture] as const satisfies readonly BenchmarkFixtureMetadata[];
