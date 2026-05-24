export {
  evaluateBenchmarkCandidateFromFile,
  evaluateBenchmarkCandidateFromJsonString,
  type BenchmarkEvaluationError,
  type BenchmarkEvaluationOptions,
  type BenchmarkEvaluationResult
} from "./core/benchmark/evaluateBenchmark.js";
export { verifyConfigSingleFileEdit } from "./core/benchmark/configSingleFileEditVerifier.js";
export { verifyContextRetrievalOnly } from "./core/benchmark/contextRetrievalOnlyVerifier.js";
export { verifyDriftDetection } from "./core/benchmark/driftDetectionVerifier.js";
export { verifyFailingTestSingleFileFix } from "./core/benchmark/failingTestSingleFileFixVerifier.js";
export { verifyMessyPromptResilience } from "./core/benchmark/messyPromptResilienceVerifier.js";
export { verifyScopeViolationDetection } from "./core/benchmark/scopeViolationDetectionVerifier.js";
export { verifyThreeFileChainConfigTestDocs } from "./core/benchmark/threeFileChainConfigTestDocsVerifier.js";
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
  getExecutableBenchmarkSummary,
  listExecutableBenchmarks,
  type ExecutableBenchmarkSummary
} from "./core/benchmark/summary.js";
export {
  benchmarkFixtures,
  configSingleFileEditFixture,
  contextRetrievalOnlyFixture,
  driftDetectionFixture,
  docsSingleFileEditFixture,
  failingTestSingleFileFixFixture,
  messyPromptResilienceFixture,
  scopeViolationDetectionFixture,
  threeFileChainConfigTestDocsFixture,
  type BenchmarkAuditVerdict,
  type BenchmarkCandidateAudit,
  type BenchmarkCandidateDecomposition,
  type BenchmarkCandidateDecompositionStep,
  type BenchmarkCandidateDrift,
  type BenchmarkCandidateEvidence,
  type BenchmarkCandidateInterpretedTask,
  type BenchmarkDecompositionStrategy,
  type BenchmarkCandidateResult,
  type BenchmarkFixtureMetadata,
  type BenchmarkVerificationResult
} from "./core/benchmark/fixtures.js";
export { benchmarkRegistry, getBenchmarkById, type BenchmarkId, type BenchmarkDefinition } from "./core/benchmark/registry.js";
export {
  loadCandidateExampleManifest,
  validateCandidateExampleManifest,
  type CandidateExampleExpectation,
  type CandidateExampleManifest,
  type CandidateExampleManifestTemplate,
  type CandidateExampleManifestValidationError,
  type CandidateExampleManifestValidationResult
} from "./core/examples/candidateManifest.js";
export {
  loadContextPacketExampleManifest,
  validateContextPacketExampleManifest,
  type ContextPacketExampleManifest,
  type ContextPacketExampleManifestTemplate,
  type ContextPacketExampleManifestValidationError,
  type ContextPacketExampleManifestValidationResult
} from "./core/examples/contextPacketManifest.js";
export { repoScannerIgnoredDirs, repoScannerIncludedExtensions, scanRepoContext } from "./core/context/repoScanner.js";
export {
  buildRepoContextMap,
  type RepoContextFileSummary,
  type RepoContextMap,
  type RepoIgnoredContextSummary
} from "./core/context/repoMap.js";
export {
  previewRepoFiles,
  type FilePreview,
  type FilePreviewOptions,
  type FilePreviewResult,
  type FilePreviewSkip
} from "./core/context/filePreview.js";
export {
  buildContextPacket,
  buildContextPacketFromContract,
  TaskContractPacketValidationError,
  type ContextPacket,
  type ContextPacketFromContractInput,
  type ContextPacketInput,
  type ContextPacketPromptQuality,
  type ContextPacketTask
} from "./core/context/contextPacket.js";
export {
  loadTaskContractFromFile,
  TaskContractLoadError
} from "./core/contracts/loader.js";
export {
  validateTaskContract
} from "./core/contracts/validator.js";
export {
  type TaskContract,
  type TaskContractPromptQuality,
  type TaskContractValidationError,
  type TaskContractValidationResult
} from "./core/contracts/types.js";
export {
  type RepoContextFileEntry,
  type RepoContextSnapshot,
  type RepoContextWarning,
  type RepoPackageManager
} from "./core/context/repoSnapshot.js";
