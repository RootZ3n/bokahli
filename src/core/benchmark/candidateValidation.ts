import type { BenchmarkAuditVerdict, BenchmarkCandidateResult } from "./fixtures.js";

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

const allowedAuditVerdicts = new Set<BenchmarkAuditVerdict>([
  "CONTINUE",
  "RETRY_STEP",
  "REPACK_CONTEXT",
  "ASK_CONTEXT_KEEPER",
  "ESCALATE_MODEL",
  "ROLLBACK_LAST_STEP",
  "STOP_UNSAFE",
  "NEEDS_HUMAN"
]);

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

  const evidence = candidate["evidence"];
  if (evidence !== undefined) {
    if (!Array.isArray(evidence)) {
      errors.push({
        path: "$.evidence",
        code: "invalid_evidence",
        message: "evidence must be an array when present"
      });
    } else {
      evidence.forEach((entry, index) => {
        const entryPath = `$.evidence[${index}]`;
        if (!isPlainObject(entry)) {
          errors.push({
            path: entryPath,
            code: "invalid_evidence_entry",
            message: "evidence entries must be objects"
          });
          return;
        }

        const file = entry["file"];
        if (typeof file !== "string") {
          errors.push({
            path: `${entryPath}.file`,
            code: "required_evidence_file",
            message: "evidence file is required and must be a string"
          });
        } else {
          validateRelativePath(file, `${entryPath}.file`, errors);
        }

        const reason = entry["reason"];
        if (typeof reason !== "string" || reason.length === 0) {
          errors.push({
            path: `${entryPath}.reason`,
            code: "required_evidence_reason",
            message: "evidence reason is required and must be a non-empty string"
          });
        }

        const quote = entry["quote"];
        if (quote !== undefined && typeof quote !== "string") {
          errors.push({
            path: `${entryPath}.quote`,
            code: "invalid_evidence_quote",
            message: "evidence quote must be a string when present"
          });
        }
      });
    }
  }

  const audit = candidate["audit"];
  if (audit !== undefined) {
    if (!isPlainObject(audit)) {
      errors.push({
        path: "$.audit",
        code: "invalid_audit",
        message: "audit must be an object when present"
      });
    } else {
      const verdict = audit["verdict"];
      if (typeof verdict !== "string" || !allowedAuditVerdicts.has(verdict as BenchmarkAuditVerdict)) {
        errors.push({
          path: "$.audit.verdict",
          code: "invalid_audit_verdict",
          message: "audit verdict must be one of the allowed verdict strings"
        });
      }

      const reason = audit["reason"];
      if (typeof reason !== "string" || reason.length === 0) {
        errors.push({
          path: "$.audit.reason",
          code: "required_audit_reason",
          message: "audit reason is required and must be a non-empty string"
        });
      }

      const flaggedFiles = audit["flaggedFiles"];
      if (flaggedFiles !== undefined) {
        if (!Array.isArray(flaggedFiles)) {
          errors.push({
            path: "$.audit.flaggedFiles",
            code: "invalid_audit_flagged_files",
            message: "audit flaggedFiles must be an array of relative paths when present"
          });
        } else {
          flaggedFiles.forEach((file, index) => {
            const errorPath = `$.audit.flaggedFiles[${index}]`;
            if (typeof file !== "string") {
              errors.push({
                path: errorPath,
                code: "invalid_audit_flagged_file",
                message: "audit flaggedFiles entries must be strings"
              });
              return;
            }

            validateRelativePath(file, errorPath, errors);
          });
        }
      }
    }
  }

  const drift = candidate["drift"];
  if (drift !== undefined) {
    if (!isPlainObject(drift)) {
      errors.push({
        path: "$.drift",
        code: "invalid_drift",
        message: "drift must be an object when present"
      });
    } else {
      const detected = drift["detected"];
      if (typeof detected !== "boolean") {
        errors.push({
          path: "$.drift.detected",
          code: "invalid_drift_detected",
          message: "drift detected must be a boolean"
        });
      }

      const summary = drift["summary"];
      if (typeof summary !== "string" || summary.length === 0) {
        errors.push({
          path: "$.drift.summary",
          code: "required_drift_summary",
          message: "drift summary is required and must be a non-empty string"
        });
      }

      const expected = drift["expected"];
      if (expected !== undefined && typeof expected !== "string") {
        errors.push({
          path: "$.drift.expected",
          code: "invalid_drift_expected",
          message: "drift expected must be a string when present"
        });
      }

      const observed = drift["observed"];
      if (observed !== undefined && typeof observed !== "string") {
        errors.push({
          path: "$.drift.observed",
          code: "invalid_drift_observed",
          message: "drift observed must be a string when present"
        });
      }

      const evidenceFiles = drift["evidenceFiles"];
      if (!Array.isArray(evidenceFiles)) {
        errors.push({
          path: "$.drift.evidenceFiles",
          code: "required_drift_evidence_files",
          message: "drift evidenceFiles is required and must be an array of relative paths"
        });
      } else {
        evidenceFiles.forEach((file, index) => {
          const errorPath = `$.drift.evidenceFiles[${index}]`;
          if (typeof file !== "string") {
            errors.push({
              path: errorPath,
              code: "invalid_drift_evidence_file",
              message: "drift evidenceFiles entries must be strings"
            });
            return;
          }

          validateRelativePath(file, errorPath, errors);
        });
      }
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
      notes: notes as readonly string[] | undefined,
      evidence: evidence as BenchmarkCandidateResult["evidence"],
      audit: audit as BenchmarkCandidateResult["audit"],
      drift: drift as BenchmarkCandidateResult["drift"]
    }
  };
}
