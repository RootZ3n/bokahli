import type { BenchmarkAuditVerdict, BenchmarkCandidateResult, BenchmarkDecompositionStrategy } from "./fixtures.js";
import type { PromptQualityLevel } from "./registry.js";

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

const allowedDecompositionStrategies = new Set<BenchmarkDecompositionStrategy>(["single_file_steps", "single_purpose_steps"]);
const allowedPromptQualityLevels = new Set<PromptQualityLevel>(["P0", "P1", "P2", "P3", "P4"]);

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

  const decomposition = candidate["decomposition"];
  if (decomposition !== undefined) {
    if (!isPlainObject(decomposition)) {
      errors.push({
        path: "$.decomposition",
        code: "invalid_decomposition",
        message: "decomposition must be an object when present"
      });
    } else {
      const strategy = decomposition["strategy"];
      if (typeof strategy !== "string" || !allowedDecompositionStrategies.has(strategy as BenchmarkDecompositionStrategy)) {
        errors.push({
          path: "$.decomposition.strategy",
          code: "invalid_decomposition_strategy",
          message: "decomposition strategy must be single_file_steps or single_purpose_steps"
        });
      }

      const steps = decomposition["steps"];
      if (!Array.isArray(steps) || steps.length === 0) {
        errors.push({
          path: "$.decomposition.steps",
          code: "required_decomposition_steps",
          message: "decomposition steps must be a non-empty array"
        });
      } else {
        steps.forEach((step, index) => {
          const stepPath = `$.decomposition.steps[${index}]`;
          if (!isPlainObject(step)) {
            errors.push({
              path: stepPath,
              code: "invalid_decomposition_step",
              message: "decomposition steps must be objects"
            });
            return;
          }

          const stepId = step["stepId"];
          if (typeof stepId !== "string" || stepId.length === 0) {
            errors.push({
              path: `${stepPath}.stepId`,
              code: "required_decomposition_step_id",
              message: "decomposition stepId is required and must be a non-empty string"
            });
          }

          const purpose = step["purpose"];
          if (typeof purpose !== "string" || purpose.length === 0) {
            errors.push({
              path: `${stepPath}.purpose`,
              code: "required_decomposition_purpose",
              message: "decomposition purpose is required and must be a non-empty string"
            });
          }

          const file = step["file"];
          if (typeof file !== "string") {
            errors.push({
              path: `${stepPath}.file`,
              code: "required_decomposition_file",
              message: "decomposition file is required and must be a string"
            });
          } else {
            validateRelativePath(file, `${stepPath}.file`, errors);
          }
        });
      }
    }
  }

  const interpretedTask = candidate["interpretedTask"];
  if (interpretedTask !== undefined) {
    if (!isPlainObject(interpretedTask)) {
      errors.push({
        path: "$.interpretedTask",
        code: "invalid_interpreted_task",
        message: "interpretedTask must be an object when present"
      });
    } else {
      const promptQuality = interpretedTask["promptQuality"];
      if (typeof promptQuality !== "string" || !allowedPromptQualityLevels.has(promptQuality as PromptQualityLevel)) {
        errors.push({
          path: "$.interpretedTask.promptQuality",
          code: "invalid_interpreted_task_prompt_quality",
          message: "interpretedTask promptQuality must be one of P0, P1, P2, P3, or P4"
        });
      }

      const scopedGoal = interpretedTask["scopedGoal"];
      if (typeof scopedGoal !== "string" || scopedGoal.length === 0) {
        errors.push({
          path: "$.interpretedTask.scopedGoal",
          code: "required_interpreted_task_scoped_goal",
          message: "interpretedTask scopedGoal is required and must be a non-empty string"
        });
      }

      const targetBehavior = interpretedTask["targetBehavior"];
      if (typeof targetBehavior !== "string" || targetBehavior.length === 0) {
        errors.push({
          path: "$.interpretedTask.targetBehavior",
          code: "required_interpreted_task_target_behavior",
          message: "interpretedTask targetBehavior is required and must be a non-empty string"
        });
      }

      const affectedFiles = interpretedTask["affectedFiles"];
      if (!Array.isArray(affectedFiles)) {
        errors.push({
          path: "$.interpretedTask.affectedFiles",
          code: "required_interpreted_task_affected_files",
          message: "interpretedTask affectedFiles must be an array of relative paths"
        });
      } else {
        affectedFiles.forEach((file, index) => {
          const errorPath = `$.interpretedTask.affectedFiles[${index}]`;
          if (typeof file !== "string") {
            errors.push({
              path: errorPath,
              code: "invalid_interpreted_task_affected_file",
              message: "interpretedTask affectedFiles entries must be strings"
            });
            return;
          }

          validateRelativePath(file, errorPath, errors);
        });
      }

      const nonGoals = interpretedTask["nonGoals"];
      if (!Array.isArray(nonGoals) || !nonGoals.every((nonGoal) => typeof nonGoal === "string")) {
        errors.push({
          path: "$.interpretedTask.nonGoals",
          code: "required_interpreted_task_non_goals",
          message: "interpretedTask nonGoals must be an array of strings"
        });
      }

      const decompositionRequired = interpretedTask["decompositionRequired"];
      if (typeof decompositionRequired !== "boolean") {
        errors.push({
          path: "$.interpretedTask.decompositionRequired",
          code: "invalid_interpreted_task_decomposition_required",
          message: "interpretedTask decompositionRequired must be a boolean"
        });
      }

      const verificationRequired = interpretedTask["verificationRequired"];
      if (!Array.isArray(verificationRequired) || !verificationRequired.every((requirement) => typeof requirement === "string")) {
        errors.push({
          path: "$.interpretedTask.verificationRequired",
          code: "required_interpreted_task_verification_required",
          message: "interpretedTask verificationRequired must be an array of strings"
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
      drift: drift as BenchmarkCandidateResult["drift"],
      decomposition: decomposition as BenchmarkCandidateResult["decomposition"],
      interpretedTask: interpretedTask as BenchmarkCandidateResult["interpretedTask"]
    }
  };
}
