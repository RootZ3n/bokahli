import type { BenchmarkCandidateResult } from "./fixtures.js";

export interface CandidateValidationError {
  path: string;
  code: string;
  message: string;
}

export type CandidateValidationResult =
  | {
      ok: true;
      candidate: BenchmarkCandidateResult;
    }
  | {
      ok: false;
      errors: CandidateValidationError[];
    };

export interface CandidateValidationOptions {
  supportedBenchmarkIds?: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isAbsolutePath(filePath: string): boolean {
  return filePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filePath);
}

function hasPathTraversal(filePath: string): boolean {
  return filePath.split(/[\\/]/).includes("..");
}

function validateRelativePath(path: string, errorPath: string, errors: CandidateValidationError[]): void {
  if (path.length === 0) {
    errors.push({
      path: errorPath,
      code: "empty_path",
      message: "path must be a non-empty relative path"
    });
  }

  if (isAbsolutePath(path)) {
    errors.push({
      path: errorPath,
      code: "absolute_path",
      message: "path must not be absolute"
    });
  }

  if (hasPathTraversal(path)) {
    errors.push({
      path: errorPath,
      code: "path_traversal",
      message: "path must not contain .. traversal"
    });
  }
}

export function validateBenchmarkCandidateResult(candidate: unknown, options: CandidateValidationOptions = {}): CandidateValidationResult {
  const errors: CandidateValidationError[] = [];

  if (!isPlainObject(candidate)) {
    return {
      ok: false,
      errors: [
        {
          path: "$",
          code: "invalid_type",
          message: "candidate must be an object"
        }
      ]
    };
  }

  const benchmarkId = candidate["benchmarkId"];
  if (typeof benchmarkId !== "string") {
    errors.push({
      path: "$.benchmarkId",
      code: "required_string",
      message: "benchmarkId is required and must be a string"
    });
  } else if (options.supportedBenchmarkIds !== undefined && !options.supportedBenchmarkIds.includes(benchmarkId)) {
    errors.push({
      path: "$.benchmarkId",
      code: "unsupported_benchmark",
      message: `benchmarkId is not supported: ${benchmarkId}`
    });
  }

  const changedFiles = candidate["changedFiles"];
  if (!Array.isArray(changedFiles)) {
    errors.push({
      path: "$.changedFiles",
      code: "required_string_array",
      message: "changedFiles is required and must be an array of strings"
    });
  } else {
    const seenChangedFiles = new Set<string>();
    changedFiles.forEach((file, index) => {
      const errorPath = `$.changedFiles[${index}]`;
      if (typeof file !== "string") {
        errors.push({
          path: errorPath,
          code: "invalid_path_type",
          message: "changedFiles entries must be strings"
        });
        return;
      }

      validateRelativePath(file, errorPath, errors);

      if (seenChangedFiles.has(file)) {
        errors.push({
          path: errorPath,
          code: "duplicate_path",
          message: `changedFiles contains duplicate entry: ${file}`
        });
      }
      seenChangedFiles.add(file);
    });
  }

  const fileContents = candidate["fileContents"];
  if (!isPlainObject(fileContents)) {
    errors.push({
      path: "$.fileContents",
      code: "required_file_contents",
      message: "fileContents is required and must be a plain object mapping paths to string contents"
    });
  } else {
    for (const [file, contents] of Object.entries(fileContents)) {
      const errorPath = `$.fileContents.${file}`;
      validateRelativePath(file, errorPath, errors);

      if (typeof contents !== "string") {
        errors.push({
          path: errorPath,
          code: "invalid_file_content",
          message: "fileContents values must be strings"
        });
      }
    }
  }

  if (Array.isArray(changedFiles) && isPlainObject(fileContents)) {
    for (const file of changedFiles) {
      if (typeof file === "string" && !(file in fileContents)) {
        errors.push({
          path: "$.fileContents",
          code: "missing_changed_file_content",
          message: `fileContents must include changed file content for ${file}`
        });
      }
    }
  }

  const notes = candidate["notes"];
  if (notes !== undefined) {
    if (!Array.isArray(notes) || !notes.every((note) => typeof note === "string")) {
      errors.push({
        path: "$.notes",
        code: "invalid_notes",
        message: "notes must be an array of strings when present"
      });
    }
  }

  const claims = candidate["claims"];
  if (claims !== undefined) {
    if (!Array.isArray(claims) || !claims.every((claim) => typeof claim === "string")) {
      errors.push({
        path: "$.claims",
        code: "invalid_claims",
        message: "claims must be an array of strings when present and are not verification evidence"
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    candidate: {
      benchmarkId: benchmarkId as string,
      changedFiles: changedFiles as readonly string[],
      fileContents: fileContents as Readonly<Record<string, string>>,
      notes: notes as readonly string[] | undefined
    }
  };
}
