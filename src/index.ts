export {
  evaluateBenchmarkCandidateFromFile,
  evaluateBenchmarkCandidateFromJsonString,
  type BenchmarkEvaluationError,
  type BenchmarkEvaluationOptions,
  type BenchmarkEvaluationResult
} from "./core/benchmark/evaluateBenchmark.js";
export { verifyConfigSingleFileEdit } from "./core/benchmark/configSingleFileEditVerifier.js";
export { verifyContextRetrievalOnly } from "./core/benchmark/contextRetrievalOnlyVerifier.js";
export { verifyScopeViolationDetection } from "./core/benchmark/scopeViolationDetectionVerifier.js";
export {
  loadCandidateResultFromFile,
  loadCandidateResultFromJsonString,
  type CandidateLoadError,
  type CandidateLoaderOptions,
  type CandidateLoadResult
} from "./core/benchmark/candidateLoader.js";
export {
  validateBenchmarkCandidateResult,
  type CandidateValidationError,
  type CandidateValidationOptions,
  type CandidateValidationResult
} from "./core/benchmark/candidateValidation.js";
export { runBenchmarkFixture, type BenchmarkFixtureRunnerOptions, type BenchmarkVerifier, type LoadedBenchmarkFixture } from "./core/benchmark/fixtureRunner.js";
export {
  benchmarkFixtures,
  configSingleFileEditFixture,
  contextRetrievalOnlyFixture,
  docsSingleFileEditFixture,
  scopeViolationDetectionFixture,
  type BenchmarkAuditVerdict,
  type BenchmarkCandidateAudit,
  type BenchmarkCandidateEvidence,
  type BenchmarkCandidateResult,
  type BenchmarkFixtureMetadata,
  type BenchmarkVerificationResult
} from "./core/benchmark/fixtures.js";
export { benchmarkRegistry, getBenchmarkById, type BenchmarkId, type BenchmarkDefinition } from "./core/benchmark/registry.js";
