export type TaskContractPromptQuality = "P0" | "P1" | "P2" | "P3" | "P4";

export interface TaskContract {
  readonly id?: string;
  readonly benchmarkId?: string;
  readonly taskType: string;
  readonly promptQuality?: TaskContractPromptQuality;
  readonly goal: string;
  readonly allowedFiles: readonly string[];
  readonly forbiddenFiles?: readonly string[];
  readonly verificationRequired?: readonly string[];
}

export interface TaskContractValidationError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type TaskContractValidationResult =
  | {
      readonly ok: true;
      readonly contract: TaskContract;
    }
  | {
      readonly ok: false;
      readonly errors: readonly TaskContractValidationError[];
    };
