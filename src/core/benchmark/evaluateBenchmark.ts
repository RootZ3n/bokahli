import { loadCandidateResultFromFile, loadCandidateResultFromJsonString, type CandidateLoadError } from "./candidateLoader.js";
import { runBenchmarkFixture, type BenchmarkFixtureRunnerOptions } from "./fixtureRunner.js";
import type { BenchmarkVerificationResult } from "./fixtures.js";

export interface BenchmarkEvaluationOptions {
  readonly fixtureRoot?: string;
  readonly allowedCandidateRoots?: readonly string[];
  readonly maxCandidateBytes?: number;
  readonly fixtureRunner?: BenchmarkFixtureRunnerOptions;
}

export interface BenchmarkEvaluationError {
  code: string;
  message: string;
  path?: string;
}

export type BenchmarkEvaluationResult =
  | {
      ok: true;
      benchmarkId: string;
      source: "string" | "file";
      verification: BenchmarkVerificationResult;
    }
  | {
      ok: false;
      benchmarkId: string;
      source: "string" | "file";
      stage: "load" | "validate" | "verify";
      errors: BenchmarkEvaluationError[];
      verification?: BenchmarkVerificationResult;
    };

function toEvaluationError(error: CandidateLoadError): BenchmarkEvaluationError {
  return {
    code: error.code,
    message: error.message,
    path: error.path
  };
}

function stageForLoadErrors(errors: readonly CandidateLoadError[]): "load" | "validate" {
  return errors.every((error) => error.code === "candidate_validation_error") ? "validate" : "load";
}

function verificationToErrors(verification: BenchmarkVerificationResult): BenchmarkEvaluationError[] {
  return verification.failedChecks.map((check) => ({
    code: "verification_failed",
    message: check
  }));
}

async function evaluateLoadedCandidate(
  benchmarkId: string,
  source: "string" | "file",
  candidate: unknown,
  options: BenchmarkEvaluationOptions
): Promise<BenchmarkEvaluationResult> {
  const verification = await runBenchmarkFixture(benchmarkId, candidate, {
    ...options.fixtureRunner,
    fixtureRoot: options.fixtureRoot ?? options.fixtureRunner?.fixtureRoot
  });

  if (!verification.ok) {
    return {
      ok: false,
      benchmarkId,
      source,
      stage: "verify",
      errors: verificationToErrors(verification),
      verification
    };
  }

  return {
    ok: true,
    benchmarkId,
    source,
    verification
  };
}

export async function evaluateBenchmarkCandidateFromJsonString(
  benchmarkId: string,
  json: string,
  options: BenchmarkEvaluationOptions = {}
): Promise<BenchmarkEvaluationResult> {
  const loadResult = loadCandidateResultFromJsonString(json);
  if (!loadResult.ok) {
    return {
      ok: false,
      benchmarkId,
      source: "string",
      stage: stageForLoadErrors(loadResult.errors),
      errors: loadResult.errors.map(toEvaluationError)
    };
  }

  return evaluateLoadedCandidate(benchmarkId, "string", loadResult.candidate, options);
}

export async function evaluateBenchmarkCandidateFromFile(
  benchmarkId: string,
  filePath: string,
  options: BenchmarkEvaluationOptions = {}
): Promise<BenchmarkEvaluationResult> {
  const loadResult = await loadCandidateResultFromFile(filePath, {
    allowedRoots: options.allowedCandidateRoots,
    maxBytes: options.maxCandidateBytes
  });
  if (!loadResult.ok) {
    return {
      ok: false,
      benchmarkId,
      source: "file",
      stage: stageForLoadErrors(loadResult.errors),
      errors: loadResult.errors.map(toEvaluationError)
    };
  }

  return evaluateLoadedCandidate(benchmarkId, "file", loadResult.candidate, options);
}
