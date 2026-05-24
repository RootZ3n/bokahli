import { lstat, readFile } from "node:fs/promises";
import { validateTaskContract } from "./validator.js";
import type { TaskContract, TaskContractValidationError } from "./types.js";

export class TaskContractLoadError extends Error {
  readonly errors: readonly TaskContractValidationError[];

  constructor(message: string, errors: readonly TaskContractValidationError[]) {
    super(message);
    this.name = "TaskContractLoadError";
    this.errors = errors;
  }
}

export async function loadTaskContractFromFile(filePath: string): Promise<TaskContract> {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TaskContractLoadError("Task contract file could not be inspected", [
      {
        path: filePath,
        code: "contract_file_error",
        message
      }
    ]);
  }

  if (stats.isSymbolicLink()) {
    throw new TaskContractLoadError("Task contract file must not be a symlink", [
      {
        path: filePath,
        code: "contract_file_symlink",
        message: "Task contract file must not be a symlink"
      }
    ]);
  }

  if (!stats.isFile()) {
    throw new TaskContractLoadError("Task contract path must be a file", [
      {
        path: filePath,
        code: "contract_file_not_file",
        message: "Task contract path must be a file"
      }
    ]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TaskContractLoadError("Task contract JSON could not be parsed", [
      {
        path: filePath,
        code: "contract_json_error",
        message
      }
    ]);
  }

  const validation = validateTaskContract(parsed);
  if (!validation.ok) {
    throw new TaskContractLoadError("Task contract failed validation", validation.errors);
  }

  return validation.contract;
}
