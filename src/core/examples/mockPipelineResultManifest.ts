import { readFile } from "node:fs/promises";
import path from "node:path";

export interface MockPipelineResultManifestEntry {
  readonly id: string;
  readonly path: string;
  readonly benchmarkId: string;
  readonly scenario: string;
  readonly expectedStatus: string;
  readonly description: string;
}

export interface MockPipelineResultManifest {
  readonly version: 1;
  readonly generatedBy: string;
  readonly results: readonly MockPipelineResultManifestEntry[];
}

export interface MockPipelineResultManifestValidationError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type MockPipelineResultManifestValidationResult =
  | {
      readonly ok: true;
      readonly manifest: MockPipelineResultManifest;
    }
  | {
      readonly ok: false;
      readonly errors: readonly MockPipelineResultManifestValidationError[];
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeRelativePath(value: string): boolean {
  return value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..");
}

function pushError(errors: MockPipelineResultManifestValidationError[], errorPath: string, code: string, message: string): void {
  errors.push({
    path: errorPath,
    code,
    message
  });
}

function validateRequiredString(
  errors: MockPipelineResultManifestValidationError[],
  value: unknown,
  errorPath: string,
  code: string,
  message: string
): value is string {
  if (typeof value !== "string" || value.length === 0) {
    pushError(errors, errorPath, code, message);
    return false;
  }

  return true;
}

export function validateMockPipelineResultManifest(manifest: unknown): MockPipelineResultManifestValidationResult {
  const errors: MockPipelineResultManifestValidationError[] = [];

  if (!isPlainObject(manifest)) {
    return {
      ok: false,
      errors: [
        {
          path: "$",
          code: "invalid_manifest",
          message: "manifest must be an object"
        }
      ]
    };
  }

  if (manifest["version"] !== 1) {
    pushError(errors, "$.version", "invalid_version", "manifest version must be 1");
  }

  validateRequiredString(errors, manifest["generatedBy"], "$.generatedBy", "required_generated_by", "generatedBy must be a non-empty string");

  const results = manifest["results"];
  const seenIds = new Set<string>();

  if (!Array.isArray(results)) {
    pushError(errors, "$.results", "required_results", "results must be an array");
  } else {
    results.forEach((entry, index) => {
      const entryPath = `$.results[${index}]`;
      if (!isPlainObject(entry)) {
        pushError(errors, entryPath, "invalid_result", "result entry must be an object");
        return;
      }

      const id = entry["id"];
      if (validateRequiredString(errors, id, `${entryPath}.id`, "required_result_id", "result id must be a non-empty string")) {
        if (seenIds.has(id)) {
          pushError(errors, `${entryPath}.id`, "duplicate_result_id", `result id is duplicated: ${id}`);
        } else {
          seenIds.add(id);
        }
      }

      const filePath = entry["path"];
      if (validateRequiredString(errors, filePath, `${entryPath}.path`, "required_result_path", "result path must be a string")) {
        if (!isSafeRelativePath(filePath)) {
          pushError(errors, `${entryPath}.path`, "unsafe_result_path", "result path must be a safe relative path");
        }
      }

      validateRequiredString(
        errors,
        entry["benchmarkId"],
        `${entryPath}.benchmarkId`,
        "required_benchmark_id",
        "benchmarkId must be a non-empty string"
      );
      validateRequiredString(errors, entry["scenario"], `${entryPath}.scenario`, "required_scenario", "scenario must be a non-empty string");
      validateRequiredString(
        errors,
        entry["expectedStatus"],
        `${entryPath}.expectedStatus`,
        "required_expected_status",
        "expectedStatus must be a non-empty string"
      );
      validateRequiredString(
        errors,
        entry["description"],
        `${entryPath}.description`,
        "required_description",
        "description must be a non-empty string"
      );
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    manifest: manifest as unknown as MockPipelineResultManifest
  };
}

export async function loadMockPipelineResultManifest(root = process.cwd()): Promise<MockPipelineResultManifest> {
  const manifestPath = path.join(root, "examples/mock-pipeline/manifest.json");
  const rawManifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  const validation = validateMockPipelineResultManifest(rawManifest);

  if (!validation.ok) {
    const messages = validation.errors.map((error) => `${error.code} ${error.path}: ${error.message}`).join("; ");
    throw new Error(`invalid mock-pipeline result manifest: ${messages}`);
  }

  return validation.manifest;
}
