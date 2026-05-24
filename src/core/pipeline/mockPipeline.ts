import { validateBenchmarkCandidateResult } from "../benchmark/candidateValidation.js";
import type { BenchmarkEvaluationError, BenchmarkEvaluationResult } from "../benchmark/evaluateBenchmark.js";
import type { BenchmarkVerificationResult } from "../benchmark/fixtures.js";
import { runBenchmarkFixture } from "../benchmark/fixtureRunner.js";
import { benchmarkRegistry } from "../benchmark/registry.js";
import { validateTaskContract } from "../contracts/validator.js";
import { runMockWorker } from "../workers/mockWorker.js";
import type { WorkerResult } from "../workers/types.js";
import type { MockPipelineError, MockPipelineInput, MockPipelineResult } from "./types.js";

function contractErrorsToPipelineErrors(errors: readonly MockPipelineError[]): MockPipelineError[] {
  return errors.map((error) => ({
    code: error.code,
    message: error.message,
    path: error.path
  }));
}

function safeCandidateBenchmarkId(candidate: unknown): string | undefined {
  if (typeof candidate !== "object" || candidate === null) {
    return undefined;
  }

  const benchmarkId = (candidate as { benchmarkId?: unknown }).benchmarkId;
  return typeof benchmarkId === "string" ? benchmarkId : undefined;
}

function candidateFromWorker(worker: WorkerResult): unknown | undefined {
  return worker.ok ? worker.candidate : worker.candidate;
}

function verificationToErrors(verification: BenchmarkVerificationResult): BenchmarkEvaluationError[] {
  return verification.failedChecks.map((check) => ({
    code: "verification_failed",
    message: check
  }));
}

function verificationToEvaluationResult(benchmarkId: string, verification: BenchmarkVerificationResult): BenchmarkEvaluationResult {
  if (verification.ok) {
    return {
      ok: true,
      benchmarkId,
      source: "string",
      verification
    };
  }

  return {
    ok: false,
    benchmarkId,
    source: "string",
    stage: "verify",
    errors: verificationToErrors(verification),
    verification
  };
}

function pipelineErrorsFromEvaluation(evaluation: BenchmarkEvaluationResult): MockPipelineError[] {
  if (evaluation.ok) {
    return [];
  }

  return evaluation.errors.map((error) => ({
    code: error.code,
    message: error.message,
    path: error.path
  }));
}

export async function runMockPipeline(input: MockPipelineInput): Promise<MockPipelineResult> {
  const contractValidation = validateTaskContract(input.contract);
  if (!contractValidation.ok) {
    return {
      ok: false,
      status: "contract_invalid",
      benchmarkId: input.benchmarkId ?? input.contract.benchmarkId,
      scenario: input.scenario,
      errors: contractErrorsToPipelineErrors(contractValidation.errors)
    };
  }

  const contract = contractValidation.contract;
  const worker = runMockWorker({
    contract,
    contextPacket: input.contextPacket,
    scenario: input.scenario
  });
  const candidate = candidateFromWorker(worker);

  if (candidate === undefined) {
    return {
      ok: false,
      status: worker.ok ? "worker_error" : "worker_refused",
      benchmarkId: input.benchmarkId ?? contract.benchmarkId,
      scenario: input.scenario,
      worker,
      errors: [
        {
          code: worker.ok ? "worker_missing_candidate" : "worker_refused",
          message: worker.ok ? "Mock worker did not emit a candidate" : worker.reason
        }
      ]
    };
  }

  const requestedBenchmarkId = input.benchmarkId ?? contract.benchmarkId;
  const emittedBenchmarkId = safeCandidateBenchmarkId(candidate);
  if (requestedBenchmarkId !== undefined && emittedBenchmarkId !== undefined && emittedBenchmarkId !== requestedBenchmarkId) {
    return {
      ok: false,
      status: "benchmark_mismatch",
      benchmarkId: requestedBenchmarkId,
      scenario: input.scenario,
      worker,
      candidate,
      errors: [
        {
          code: "benchmark_id_mismatch",
          message: `candidate benchmarkId ${emittedBenchmarkId} does not match requested benchmarkId ${requestedBenchmarkId}`,
          path: "$.benchmarkId"
        }
      ]
    };
  }

  const validation = validateBenchmarkCandidateResult(candidate, {
    supportedBenchmarkIds: benchmarkRegistry.map((benchmark) => benchmark.id)
  });

  if (!validation.ok) {
    return {
      ok: false,
      status: "candidate_invalid",
      benchmarkId: requestedBenchmarkId ?? safeCandidateBenchmarkId(candidate),
      scenario: input.scenario,
      worker,
      candidate,
      validation,
      errors: validation.errors.map((error) => ({
        code: error.code,
        message: error.message,
        path: error.path
      }))
    };
  }

  const benchmarkId = requestedBenchmarkId ?? validation.candidate.benchmarkId;
  if (benchmarkId === undefined) {
    return {
      ok: false,
      status: "benchmark_mismatch",
      scenario: input.scenario,
      worker,
      candidate: validation.candidate,
      validation,
      errors: [
        {
          code: "benchmark_id_missing",
          message: "Unable to determine benchmarkId from input, candidate, or contract"
        }
      ]
    };
  }

  if (validation.candidate.benchmarkId !== benchmarkId) {
    return {
      ok: false,
      status: "benchmark_mismatch",
      benchmarkId,
      scenario: input.scenario,
      worker,
      candidate: validation.candidate,
      validation,
      errors: [
        {
          code: "benchmark_id_mismatch",
          message: `candidate benchmarkId ${validation.candidate.benchmarkId} does not match requested benchmarkId ${benchmarkId}`,
          path: "$.benchmarkId"
        }
      ]
    };
  }

  const verification = await runBenchmarkFixture(benchmarkId, validation.candidate);
  const evaluation = verificationToEvaluationResult(benchmarkId, verification);

  if (!evaluation.ok) {
    return {
      ok: false,
      status: "evaluation_failed",
      benchmarkId,
      scenario: input.scenario,
      worker,
      candidate: validation.candidate,
      validation,
      evaluation,
      errors: pipelineErrorsFromEvaluation(evaluation)
    };
  }

  return {
    ok: true,
    status: "passed",
    benchmarkId,
    scenario: input.scenario,
    worker,
    candidate: validation.candidate,
    validation,
    evaluation
  };
}
