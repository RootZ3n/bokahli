import path from "node:path";
import type { TaskContract, TaskContractPromptQuality, TaskContractValidationError, TaskContractValidationResult } from "./types.js";

const promptQualities = new Set<TaskContractPromptQuality>(["P0", "P1", "P2", "P3", "P4"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasTraversal(relativePath: string): boolean {
  return relativePath.split(/[\\/]+/).includes("..");
}

function isSafeRelativePath(value: string): boolean {
  return value.length > 0 && !path.isAbsolute(value) && !hasTraversal(value);
}

function validateString(value: unknown, fieldPath: string, errors: TaskContractValidationError[]): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push({
      path: fieldPath,
      code: "invalid_string",
      message: `${fieldPath} must be a non-empty string`
    });
    return false;
  }

  return true;
}

function validateStringArray(value: unknown, fieldPath: string, errors: TaskContractValidationError[]): value is string[] {
  if (!Array.isArray(value)) {
    errors.push({
      path: fieldPath,
      code: "invalid_array",
      message: `${fieldPath} must be an array of strings`
    });
    return false;
  }

  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      errors.push({
        path: `${fieldPath}[${index}]`,
        code: "invalid_string",
        message: `${fieldPath}[${index}] must be a non-empty string`
      });
    }
  });

  return value.every((entry) => typeof entry === "string" && entry.trim().length > 0);
}

function validatePathArray(value: unknown, fieldPath: string, errors: TaskContractValidationError[]): value is string[] {
  if (!validateStringArray(value, fieldPath, errors)) {
    return false;
  }

  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (!isSafeRelativePath(entry)) {
      errors.push({
        path: `${fieldPath}[${index}]`,
        code: "unsafe_path",
        message: `${fieldPath}[${index}] must be a safe relative path without traversal`
      });
    }

    if (seen.has(entry)) {
      errors.push({
        path: `${fieldPath}[${index}]`,
        code: "duplicate_path",
        message: `${fieldPath}[${index}] duplicates another path`
      });
    }
    seen.add(entry);
  });

  return value.every(isSafeRelativePath);
}

export function validateTaskContract(contract: unknown): TaskContractValidationResult {
  const errors: TaskContractValidationError[] = [];

  if (!isPlainObject(contract)) {
    return {
      ok: false,
      errors: [
        {
          path: "$",
          code: "invalid_contract",
          message: "TaskContract must be an object"
        }
      ]
    };
  }

  if (contract.id !== undefined) {
    validateString(contract.id, "$.id", errors);
  }

  if (contract.benchmarkId !== undefined) {
    validateString(contract.benchmarkId, "$.benchmarkId", errors);
  }

  validateString(contract.taskType, "$.taskType", errors);
  validateString(contract.goal, "$.goal", errors);
  validatePathArray(contract.allowedFiles, "$.allowedFiles", errors);

  if (contract.promptQuality !== undefined && (typeof contract.promptQuality !== "string" || !promptQualities.has(contract.promptQuality as TaskContractPromptQuality))) {
    errors.push({
      path: "$.promptQuality",
      code: "invalid_prompt_quality",
      message: "$.promptQuality must be one of P0, P1, P2, P3, P4"
    });
  }

  if (contract.forbiddenFiles !== undefined) {
    validatePathArray(contract.forbiddenFiles, "$.forbiddenFiles", errors);
  }

  if (contract.verificationRequired !== undefined) {
    validateStringArray(contract.verificationRequired, "$.verificationRequired", errors);
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors
    };
  }

  return {
    ok: true,
    contract: {
      id: contract.id as string | undefined,
      benchmarkId: contract.benchmarkId as string | undefined,
      taskType: contract.taskType as string,
      promptQuality: contract.promptQuality as TaskContractPromptQuality | undefined,
      goal: contract.goal as string,
      allowedFiles: [...(contract.allowedFiles as string[])],
      forbiddenFiles: contract.forbiddenFiles === undefined ? undefined : [...(contract.forbiddenFiles as string[])],
      verificationRequired: contract.verificationRequired === undefined ? undefined : [...(contract.verificationRequired as string[])]
    }
  };
}
