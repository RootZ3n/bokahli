import { readFile } from "node:fs/promises";
import path from "node:path";

export interface ContractExampleManifestTemplate {
  readonly id: string;
  readonly path: string;
  readonly taskType: string;
  readonly promptQuality?: string;
  readonly allowedFiles: readonly string[];
  readonly description: string;
}

export interface ContractExampleManifest {
  readonly version: 1;
  readonly generatedBy: string;
  readonly templates: readonly ContractExampleManifestTemplate[];
}

export interface ContractExampleManifestValidationError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type ContractExampleManifestValidationResult =
  | {
      readonly ok: true;
      readonly manifest: ContractExampleManifest;
    }
  | {
      readonly ok: false;
      readonly errors: readonly ContractExampleManifestValidationError[];
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

function pushError(errors: ContractExampleManifestValidationError[], errorPath: string, code: string, message: string): void {
  errors.push({
    path: errorPath,
    code,
    message
  });
}

function validateStringArray(
  errors: ContractExampleManifestValidationError[],
  value: unknown,
  errorPath: string,
  fieldName: string
): void {
  if (!Array.isArray(value)) {
    pushError(errors, errorPath, `required_${fieldName}`, `${fieldName} must be an array`);
    return;
  }

  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      pushError(errors, `${errorPath}[${index}]`, `invalid_${fieldName}_entry`, `${fieldName} entries must be non-empty strings`);
    } else if (!isSafeRelativePath(entry)) {
      pushError(errors, `${errorPath}[${index}]`, `unsafe_${fieldName}_entry`, `${fieldName} entries must be safe relative paths`);
    }
  });
}

export function validateContractExampleManifest(manifest: unknown): ContractExampleManifestValidationResult {
  const errors: ContractExampleManifestValidationError[] = [];

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

      const filePath = template["path"];
      if (typeof filePath !== "string") {
        pushError(errors, `${templatePath}.path`, "required_template_path", "template path must be a string");
      } else if (!isSafeRelativePath(filePath)) {
        pushError(errors, `${templatePath}.path`, "unsafe_template_path", "template path must be a safe relative path");
      }

      if (typeof template["taskType"] !== "string" || template["taskType"].length === 0) {
        pushError(errors, `${templatePath}.taskType`, "required_task_type", "taskType must be a non-empty string");
      }

      if (template["promptQuality"] !== undefined && (typeof template["promptQuality"] !== "string" || template["promptQuality"].length === 0)) {
        pushError(errors, `${templatePath}.promptQuality`, "invalid_prompt_quality", "promptQuality must be a non-empty string when present");
      }

      validateStringArray(errors, template["allowedFiles"], `${templatePath}.allowedFiles`, "allowedFiles");

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
    manifest: manifest as unknown as ContractExampleManifest
  };
}

export async function loadContractExampleManifest(root = process.cwd()): Promise<ContractExampleManifest> {
  const manifestPath = path.join(root, "examples/contracts/manifest.json");
  const rawManifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  const validation = validateContractExampleManifest(rawManifest);

  if (!validation.ok) {
    const messages = validation.errors.map((error) => `${error.code} ${error.path}: ${error.message}`).join("; ");
    throw new Error(`invalid contract example manifest: ${messages}`);
  }

  return validation.manifest;
}
