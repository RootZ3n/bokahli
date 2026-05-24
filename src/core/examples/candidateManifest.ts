import { readFile } from "node:fs/promises";
import path from "node:path";

export type CandidateExampleExpectation = "pass" | "fail";

export interface CandidateExampleManifestTemplate {
  readonly id: string;
  readonly benchmarkId: string;
  readonly path: string;
  readonly expectedValidation: CandidateExampleExpectation;
  readonly expectedEvaluation: CandidateExampleExpectation;
  readonly description: string;
}

export interface CandidateExampleManifest {
  readonly version: 1;
  readonly generatedBy: string;
  readonly templates: readonly CandidateExampleManifestTemplate[];
}

export interface CandidateExampleManifestValidationError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type CandidateExampleManifestValidationResult =
  | {
      readonly ok: true;
      readonly manifest: CandidateExampleManifest;
    }
  | {
      readonly ok: false;
      readonly errors: readonly CandidateExampleManifestValidationError[];
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeRelativePath(value: string): boolean {
  return !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..") && value.length > 0;
}

function isExpectation(value: unknown): value is CandidateExampleExpectation {
  return value === "pass" || value === "fail";
}

function pushError(
  errors: CandidateExampleManifestValidationError[],
  errorPath: string,
  code: string,
  message: string
): void {
  errors.push({
    path: errorPath,
    code,
    message
  });
}

export function validateCandidateExampleManifest(manifest: unknown): CandidateExampleManifestValidationResult {
  const errors: CandidateExampleManifestValidationError[] = [];

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

  if (typeof manifest["generatedBy"] !== "string" || manifest["generatedBy"].length === 0) {
    pushError(errors, "$.generatedBy", "required_generated_by", "generatedBy must be a non-empty string");
  }

  const templates = manifest["templates"];
  const seenIds = new Set<string>();

  if (!Array.isArray(templates)) {
    pushError(errors, "$.templates", "required_templates", "templates must be an array");
  } else {
    templates.forEach((template, index) => {
      const templatePath = `$.templates[${index}]`;
      if (!isPlainObject(template)) {
        pushError(errors, templatePath, "invalid_template", "template must be an object");
        return;
      }

      const id = template["id"];
      if (typeof id !== "string" || id.length === 0) {
        pushError(errors, `${templatePath}.id`, "required_template_id", "template id must be a non-empty string");
      } else if (seenIds.has(id)) {
        pushError(errors, `${templatePath}.id`, "duplicate_template_id", `template id is duplicated: ${id}`);
      } else {
        seenIds.add(id);
      }

      const benchmarkId = template["benchmarkId"];
      if (typeof benchmarkId !== "string" || benchmarkId.length === 0) {
        pushError(errors, `${templatePath}.benchmarkId`, "required_benchmark_id", "benchmarkId must be a non-empty string");
      }

      const filePath = template["path"];
      if (typeof filePath !== "string") {
        pushError(errors, `${templatePath}.path`, "required_template_path", "template path must be a string");
      } else if (!isSafeRelativePath(filePath)) {
        pushError(errors, `${templatePath}.path`, "unsafe_template_path", "template path must be a safe relative path");
      }

      if (!isExpectation(template["expectedValidation"])) {
        pushError(errors, `${templatePath}.expectedValidation`, "invalid_expected_validation", "expectedValidation must be pass or fail");
      }

      if (!isExpectation(template["expectedEvaluation"])) {
        pushError(errors, `${templatePath}.expectedEvaluation`, "invalid_expected_evaluation", "expectedEvaluation must be pass or fail");
      }

      if (typeof template["description"] !== "string" || template["description"].length === 0) {
        pushError(errors, `${templatePath}.description`, "required_description", "description must be a non-empty string");
      }
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    manifest: manifest as unknown as CandidateExampleManifest
  };
}

export async function loadCandidateExampleManifest(root = process.cwd()): Promise<CandidateExampleManifest> {
  const manifestPath = path.join(root, "examples/candidates/manifest.json");
  const rawManifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  const validation = validateCandidateExampleManifest(rawManifest);

  if (!validation.ok) {
    const messages = validation.errors.map((error) => `${error.code} ${error.path}: ${error.message}`).join("; ");
    throw new Error(`invalid candidate example manifest: ${messages}`);
  }

  return validation.manifest;
}
