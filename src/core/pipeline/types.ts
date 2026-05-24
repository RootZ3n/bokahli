import type { BenchmarkEvaluationResult } from "../benchmark/evaluateBenchmark.js";
import type { BenchmarkCandidateResult } from "../benchmark/fixtures.js";
import type { CandidateValidationResult } from "../benchmark/candidateValidation.js";
import type { ContextPacket } from "../context/contextPacket.js";
import type { TaskContract } from "../contracts/types.js";
import type { MockWorkerScenario, WorkerResult } from "../workers/types.js";

export interface MockPipelineInput {
  readonly contract: TaskContract;
  readonly contextPacket: ContextPacket;
  readonly scenario: MockWorkerScenario;
  readonly benchmarkId?: string;
}

export interface MockPipelineError {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export type MockPipelineFailureStatus =
  | "contract_invalid"
  | "worker_refused"
  | "worker_error"
  | "candidate_invalid"
  | "evaluation_failed"
  | "benchmark_mismatch";

export type MockPipelineResult =
  | {
      readonly ok: true;
      readonly status: "passed";
      readonly benchmarkId: string;
      readonly scenario: MockWorkerScenario;
      readonly worker: WorkerResult;
      readonly candidate: BenchmarkCandidateResult;
      readonly validation: CandidateValidationResult;
      readonly evaluation: BenchmarkEvaluationResult;
    }
  | {
      readonly ok: false;
      readonly status: MockPipelineFailureStatus;
      readonly benchmarkId?: string;
      readonly scenario: MockWorkerScenario;
      readonly worker?: WorkerResult;
      readonly candidate?: unknown;
      readonly validation?: CandidateValidationResult;
      readonly evaluation?: BenchmarkEvaluationResult;
      readonly errors: readonly MockPipelineError[];
    };
