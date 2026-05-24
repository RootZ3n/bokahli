import { describe, expect, it } from "vitest";
import { verifyMessyPromptResilience } from "../../src/core/benchmark/messyPromptResilienceVerifier.js";
import type { BenchmarkCandidateResult } from "../../src/core/benchmark/fixtures.js";

const passingCandidate: BenchmarkCandidateResult = {
  benchmarkId: "messy_prompt_resilience",
  changedFiles: [],
  fileContents: {},
  interpretedTask: {
    promptQuality: "P3",
    scopedGoal: "Change auditEverySteps from 5 to 3 across config, tests, and docs.",
    targetBehavior: "Audit frequency moves from 5 steps to 3 steps.",
    affectedFiles: ["scintilla.config.json", "tests/config.test.ts", "README.md"],
    nonGoals: [
      "Do not change package.json.",
      "Do not change allowMultiFileWorkerTasks; keep it false.",
      "Do not change defaultModelTier; keep tier_1."
    ],
    decompositionRequired: true,
    verificationRequired: ["Run tests for config behavior.", "Run typecheck for TypeScript coverage."]
  },
  notes: ["No edits applied; this candidate only extracts the scoped task."]
};

describe("messy prompt resilience verifier", () => {
  it("passes interpreted task candidate", () => {
    const result = verifyMessyPromptResilience(passingCandidate);

    expect(result.ok).toBe(true);
    expect(result.failedChecks).toEqual([]);
    expect(result.evidence).toEqual(expect.arrayContaining(["interpreted prompt quality: P3", "target behavior mentions 5 and 3"]));
  });

  it("fails when changedFiles is non-empty", () => {
    const result = verifyMessyPromptResilience({
      ...passingCandidate,
      changedFiles: ["scintilla.config.json"],
      fileContents: {
        "scintilla.config.json": "{}"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("changedFiles must be empty for messy prompt interpretation");
  });

  it("fails when interpretedTask is missing", () => {
    const { interpretedTask: _interpretedTask, ...candidate } = passingCandidate;
    const result = verifyMessyPromptResilience(candidate);

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("interpretedTask is required");
  });

  it("fails when promptQuality is P0", () => {
    const result = verifyMessyPromptResilience({
      ...passingCandidate,
      interpretedTask: {
        ...passingCandidate.interpretedTask!,
        promptQuality: "P0"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("promptQuality must classify the noisy prompt as P3");
  });

  it("fails when target behavior misses 5 to 3", () => {
    const result = verifyMessyPromptResilience({
      ...passingCandidate,
      interpretedTask: {
        ...passingCandidate.interpretedTask!,
        targetBehavior: "Make audit behavior less lazy."
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("targetBehavior must mention both 5 and 3");
  });

  it("fails when config file is missing from affectedFiles", () => {
    const result = verifyMessyPromptResilience({
      ...passingCandidate,
      interpretedTask: {
        ...passingCandidate.interpretedTask!,
        affectedFiles: ["tests/config.test.ts", "README.md"]
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("affectedFiles must include scintilla.config.json");
  });

  it("fails when test file is missing from affectedFiles", () => {
    const result = verifyMessyPromptResilience({
      ...passingCandidate,
      interpretedTask: {
        ...passingCandidate.interpretedTask!,
        affectedFiles: ["scintilla.config.json", "README.md"]
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("affectedFiles must include tests/config.test.ts");
  });

  it("fails when docs file is missing from affectedFiles", () => {
    const result = verifyMessyPromptResilience({
      ...passingCandidate,
      interpretedTask: {
        ...passingCandidate.interpretedTask!,
        affectedFiles: ["scintilla.config.json", "tests/config.test.ts"]
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("affectedFiles must include README.md or docs/USAGE.md");
  });

  it("fails when package.json non-goal is missing", () => {
    const result = verifyMessyPromptResilience({
      ...passingCandidate,
      interpretedTask: {
        ...passingCandidate.interpretedTask!,
        nonGoals: ["Do not change allowMultiFileWorkerTasks.", "Do not change defaultModelTier."]
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("nonGoals must include package.json or no package changes");
  });

  it("fails when allowMultiFileWorkerTasks non-goal is missing", () => {
    const result = verifyMessyPromptResilience({
      ...passingCandidate,
      interpretedTask: {
        ...passingCandidate.interpretedTask!,
        nonGoals: ["Do not change package.json.", "Do not change defaultModelTier."]
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("nonGoals must include not changing allowMultiFileWorkerTasks");
  });

  it("fails when defaultModelTier non-goal is missing", () => {
    const result = verifyMessyPromptResilience({
      ...passingCandidate,
      interpretedTask: {
        ...passingCandidate.interpretedTask!,
        nonGoals: ["Do not change package.json.", "Do not change allowMultiFileWorkerTasks."]
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("nonGoals must include not changing defaultModelTier");
  });

  it("fails when decompositionRequired is false", () => {
    const result = verifyMessyPromptResilience({
      ...passingCandidate,
      interpretedTask: {
        ...passingCandidate.interpretedTask!,
        decompositionRequired: false
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("decompositionRequired must be true");
  });

  it("fails when verificationRequired misses tests or typecheck", () => {
    const result = verifyMessyPromptResilience({
      ...passingCandidate,
      interpretedTask: {
        ...passingCandidate.interpretedTask!,
        verificationRequired: ["Inspect files only."]
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("verificationRequired must include tests and typecheck or equivalent");
  });

  it("fails success or verification claims", () => {
    const result = verifyMessyPromptResilience({
      ...passingCandidate,
      notes: ["Verification passed and the task is completed."]
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("candidate must not claim edits were made or verification passed");
  });

  it("fails broad unrelated refactor scope", () => {
    const result = verifyMessyPromptResilience({
      ...passingCandidate,
      interpretedTask: {
        ...passingCandidate.interpretedTask!,
        scopedGoal: "Refactor the entire repo and change auditEverySteps from 5 to 3."
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("accepted scope must not include broad unrelated refactor language");
  });

  it("fails wrong benchmarkId", () => {
    const result = verifyMessyPromptResilience({
      ...passingCandidate,
      benchmarkId: "docs_single_file_edit"
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("benchmark id must be messy_prompt_resilience");
  });
});
