import type { BenchmarkCandidateResult } from "../benchmark/fixtures.js";
import type { ContextPacket } from "../context/contextPacket.js";
import type { TaskContract } from "../contracts/types.js";

export type MockWorkerScenario =
  | "valid_docs_single_file_edit"
  | "invalid_schema"
  | "wrong_benchmark_id"
  | "scope_violation_detected"
  | "drift_detected"
  | "messy_prompt_interpreted"
  | "refusal_uncertain";

export type WorkerMode = "mock";

export interface WorkerInput {
  readonly contract: TaskContract;
  readonly contextPacket: ContextPacket;
  readonly scenario?: MockWorkerScenario | string;
}

export type WorkerResult =
  | {
      readonly ok: true;
      readonly mode: WorkerMode;
      readonly scenario: MockWorkerScenario;
      readonly candidate: BenchmarkCandidateResult;
    }
  | {
      readonly ok: false;
      readonly mode: WorkerMode;
      readonly scenario: MockWorkerScenario | string;
      readonly reason: string;
      readonly candidate?: unknown;
    };
