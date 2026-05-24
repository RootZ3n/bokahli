import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { validateBenchmarkCandidateResult } from "./candidateValidation.js";
import type { BenchmarkCandidateResult } from "./fixtures.js";

const defaultMaxBytes = 1024 * 1024;

export interface CandidateLoaderOptions {
  readonly supportedBenchmarkIds?: readonly string[];
  readonly maxBytes?: number;
  readonly allowedRoots?: readonly string[];
}

export interface CandidateLoadError {
  code: string;
  message: string;
  path?: string;
}

export type CandidateLoadResult =
  | {
      ok: true;
      candidate: BenchmarkCandidateResult;
      source: "string" | "file";
    }
  | {
      ok: false;
      source: "string" | "file";
      errors: CandidateLoadError[];
    };

function validationErrorToLoadError(error: { code: string; message: string; path: string }): CandidateLoadError {
  return {
    code: "candidate_validation_error",
    message: `${error.code}: ${error.message}`,
    path: error.path
  };
}

function isDisallowedUrl(input: string): boolean {
  return /^(https?|file):\/\//i.test(input);
}

function hasPathTraversal(input: string): boolean {
  return input.split(/[\\/]/).includes("..");
}

function isInsideRoot(filePath: string, root: string): boolean {
  const relativePath = path.relative(root, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function resolveAllowedFilePath(filePath: string, allowedRoots?: readonly string[]): string | CandidateLoadError {
  if (isDisallowedUrl(filePath)) {
    return {
      code: "url_not_allowed",
      message: "candidate result file path must be a local path, not a URL",
      path: filePath
    };
  }

  if (allowedRoots === undefined || allowedRoots.length === 0) {
    return path.resolve(filePath);
  }

  const normalizedRoots = allowedRoots.map((root) => path.resolve(root));
  if (hasPathTraversal(filePath)) {
    return {
      code: "file_outside_allowed_roots",
      message: "candidate result file path must not contain .. traversal when allowedRoots are configured",
      path: filePath
    };
  }

  const candidatePaths = path.isAbsolute(filePath) ? [path.resolve(filePath)] : normalizedRoots.map((root) => path.resolve(root, filePath));
  const resolvedPath = candidatePaths.find((candidatePath) => normalizedRoots.some((root) => isInsideRoot(candidatePath, root)));

  if (resolvedPath === undefined) {
    return {
      code: "file_outside_allowed_roots",
      message: "candidate result file path is outside allowedRoots",
      path: filePath
    };
  }

  return resolvedPath;
}

export function loadCandidateResultFromJsonString(json: string, options: CandidateLoaderOptions = {}): CandidateLoadResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      source: "string",
      errors: [
        {
          code: "json_parse_error",
          message
        }
      ]
    };
  }

  const validation = validateBenchmarkCandidateResult(parsed, {
    supportedBenchmarkIds: options.supportedBenchmarkIds
  });

  if (!validation.ok) {
    return {
      ok: false,
      source: "string",
      errors: validation.errors.map(validationErrorToLoadError)
    };
  }

  return {
    ok: true,
    source: "string",
    candidate: validation.candidate
  };
}

export async function loadCandidateResultFromFile(filePath: string, options: CandidateLoaderOptions = {}): Promise<CandidateLoadResult> {
  const resolvedPath = resolveAllowedFilePath(filePath, options.allowedRoots);
  if (typeof resolvedPath !== "string") {
    return {
      ok: false,
      source: "file",
      errors: [resolvedPath]
    };
  }

  let stats;
  try {
    stats = await lstat(resolvedPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    return {
      ok: false,
      source: "file",
      errors: [
        {
          code: nodeError.code === "ENOENT" ? "file_not_found" : "read_error",
          message: nodeError.message,
          path: filePath
        }
      ]
    };
  }

  if (stats.isSymbolicLink()) {
    return {
      ok: false,
      source: "file",
      errors: [
        {
          code: "file_is_symlink",
          message: "candidate result file must not be a symlink",
          path: filePath
        }
      ]
    };
  }

  if (stats.isDirectory()) {
    return {
      ok: false,
      source: "file",
      errors: [
        {
          code: "file_is_directory",
          message: "candidate result path must be a file, not a directory",
          path: filePath
        }
      ]
    };
  }

  const maxBytes = options.maxBytes ?? defaultMaxBytes;
  if (stats.size > maxBytes) {
    return {
      ok: false,
      source: "file",
      errors: [
        {
          code: "file_too_large",
          message: `candidate result file exceeds maxBytes (${maxBytes})`,
          path: filePath
        }
      ]
    };
  }

  let json: string;
  try {
    json = await readFile(resolvedPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      source: "file",
      errors: [
        {
          code: "read_error",
          message,
          path: filePath
        }
      ]
    };
  }

  const result = loadCandidateResultFromJsonString(json, options);
  return {
    ...result,
    source: "file"
  };
}
