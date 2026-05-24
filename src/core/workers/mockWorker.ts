import type { BenchmarkCandidateResult } from "../benchmark/fixtures.js";
import type { WorkerInput, WorkerResult, MockWorkerScenario } from "./types.js";

const knownScenarios = new Set<MockWorkerScenario>([
  "valid_docs_single_file_edit",
  "invalid_schema",
  "wrong_benchmark_id",
  "scope_violation_detected",
  "drift_detected",
  "messy_prompt_interpreted",
  "refusal_uncertain"
]);

export const mockWorkerScenarios = [...knownScenarios] as readonly MockWorkerScenario[];

function scenarioFor(input: WorkerInput): MockWorkerScenario | string {
  return input.scenario ?? "valid_docs_single_file_edit";
}

function firstAllowedFile(input: WorkerInput, fallback: string): string {
  return input.contract.allowedFiles[0] ?? input.contextPacket.constraints.allowedFiles[0] ?? fallback;
}

function benchmarkIdFor(input: WorkerInput, fallback: string): string {
  return input.contract.benchmarkId ?? input.contextPacket.task.benchmarkId ?? fallback;
}

function previewText(input: WorkerInput, filePath: string): string {
  return input.contextPacket.selectedPreviews.find((preview) => preview.path === filePath)?.text ?? "";
}

function docsCandidate(input: WorkerInput, benchmarkId = benchmarkIdFor(input, "docs_single_file_edit")): BenchmarkCandidateResult {
  const readmePath = input.contract.allowedFiles.includes("README.md") ? "README.md" : firstAllowedFile(input, "README.md");
  const original = previewText(input, readmePath);
  const readme = original.includes("npm run doctor")
    ? original
    : `${original.trimEnd()}\n\n## Usage\nRun the tool with the default command.\nRun npm run doctor before submitting changes.\n`;

  return {
    benchmarkId,
    changedFiles: [readmePath],
    fileContents: {
      [readmePath]: readme
    },
    notes: ["Mock worker produced deterministic docs edit candidate."]
  };
}

function scopeViolationCandidate(input: WorkerInput): BenchmarkCandidateResult {
  return {
    benchmarkId: benchmarkIdFor(input, "scope_violation_detection"),
    changedFiles: ["src/allowed.ts", "src/forbidden.ts"],
    fileContents: {
      "src/allowed.ts": "export const allowed = true;\n",
      "src/forbidden.ts": "export const forbidden = true;\n"
    },
    audit: {
      verdict: "ROLLBACK_LAST_STEP",
      reason: "src/forbidden.ts is out-of-scope because only src/allowed.ts was allowed.",
      flaggedFiles: ["src/forbidden.ts"]
    },
    notes: ["Mock worker detected unsafe scope expansion."]
  };
}

function driftCandidate(input: WorkerInput): BenchmarkCandidateResult {
  return {
    benchmarkId: benchmarkIdFor(input, "drift_detection"),
    changedFiles: [],
    fileContents: {},
    drift: {
      detected: true,
      summary: "Documentation and configuration disagree: docs say 5 steps while config/code show 3 steps.",
      expected: "5 steps documented",
      observed: "3 steps configured",
      evidenceFiles: ["README.md", "scintilla.config.json"]
    },
    evidence: [
      {
        file: "README.md",
        reason: "Documentation side of the audit frequency mismatch mentions 5."
      },
      {
        file: "scintilla.config.json",
        reason: "Configuration side of the audit frequency mismatch shows 3."
      }
    ],
    notes: ["Mock worker detected deterministic docs/config drift."]
  };
}

function messyPromptCandidate(input: WorkerInput): BenchmarkCandidateResult {
  return {
    benchmarkId: benchmarkIdFor(input, "messy_prompt_resilience"),
    changedFiles: [],
    fileContents: {},
    interpretedTask: {
      promptQuality: "P3",
      scopedGoal: "Change auditEverySteps from 5 to 3 across config, tests, and docs.",
      targetBehavior: "Update audit frequency from 5 to 3 without broad unrelated refactors.",
      affectedFiles: ["scintilla.config.json", "tests/config.test.ts", "README.md"],
      nonGoals: ["Do not change package.json.", "Do not enable allowMultiFileWorkerTasks.", "Do not change defaultModelTier."],
      decompositionRequired: true,
      verificationRequired: input.contract.verificationRequired ?? ["pnpm test", "pnpm typecheck"]
    },
    notes: ["Mock worker interpreted noisy prompt into scoped task metadata."]
  };
}

export function runMockWorker(input: WorkerInput): WorkerResult {
  const scenario = scenarioFor(input);

  if (!knownScenarios.has(scenario as MockWorkerScenario)) {
    return {
      ok: false,
      mode: "mock",
      scenario,
      reason: `Unknown mock worker scenario: ${scenario}`
    };
  }

  if (scenario === "refusal_uncertain") {
    return {
      ok: false,
      mode: "mock",
      scenario,
      reason: "Mock worker is uncertain and refuses to produce a candidate without clearer scope."
    };
  }

  if (scenario === "invalid_schema") {
    return {
      ok: false,
      mode: "mock",
      scenario,
      reason: "Mock worker intentionally produced malformed candidate-like data.",
      candidate: {
        benchmarkId: benchmarkIdFor(input, "docs_single_file_edit"),
        fileContents: {
          "README.md": "missing changedFiles on purpose"
        }
      }
    };
  }

  if (scenario === "wrong_benchmark_id") {
    return {
      ok: true,
      mode: "mock",
      scenario,
      candidate: docsCandidate(input, "wrong_benchmark_id")
    };
  }

  if (scenario === "scope_violation_detected") {
    return {
      ok: true,
      mode: "mock",
      scenario,
      candidate: scopeViolationCandidate(input)
    };
  }

  if (scenario === "drift_detected") {
    return {
      ok: true,
      mode: "mock",
      scenario,
      candidate: driftCandidate(input)
    };
  }

  if (scenario === "messy_prompt_interpreted") {
    return {
      ok: true,
      mode: "mock",
      scenario,
      candidate: messyPromptCandidate(input)
    };
  }

  return {
    ok: true,
    mode: "mock",
    scenario: "valid_docs_single_file_edit",
    candidate: docsCandidate(input)
  };
}
