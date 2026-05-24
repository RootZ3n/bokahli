import type { BenchmarkCandidateDecompositionStep, BenchmarkCandidateResult, BenchmarkVerificationResult } from "./fixtures.js";

const benchmarkId = "three_file_chain_config_test_docs";
const expectedFiles = ["README.md", "scintilla.config.json", "tests/config.test.ts"] as const;
const expectedFileSet = new Set<string>(expectedFiles);

function hasClaimWithoutDiffEvidence(candidate: BenchmarkCandidateResult): boolean {
  const notes = candidate.notes ?? [];
  const claimsSuccess = notes.some((note) => /success|done|completed|fixed|tests? pass/i.test(note));
  const hasDiffEvidence = notes.some((note) => /diff|changedFiles|README\.md|scintilla\.config\.json|tests\/config\.test\.ts|evidence/i.test(note));

  return claimsSuccess && !hasDiffEvidence;
}

function purposeMatches(file: string, purpose: string): boolean {
  if (file === "scintilla.config.json") return /config|auditEverySteps|setting/i.test(purpose);
  if (file === "tests/config.test.ts") return /test|expect|assert/i.test(purpose);
  if (file === "README.md") return /docs?|readme|documentation/i.test(purpose);
  return false;
}

function countStepFiles(steps: readonly BenchmarkCandidateDecompositionStep[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const step of steps) {
    counts.set(step.file, (counts.get(step.file) ?? 0) + 1);
  }
  return counts;
}

export function verifyThreeFileChainConfigTestDocs(candidate: BenchmarkCandidateResult): BenchmarkVerificationResult {
  const passedChecks: string[] = [];
  const failedChecks: string[] = [];
  const evidence: string[] = [];

  if (candidate.benchmarkId === benchmarkId) {
    passedChecks.push("benchmark id matches three_file_chain_config_test_docs");
  } else {
    failedChecks.push(`benchmark id must be ${benchmarkId}`);
  }

  const changedFileSet = new Set(candidate.changedFiles);
  const hasExactlyExpectedFiles = candidate.changedFiles.length === expectedFiles.length && expectedFiles.every((file) => changedFileSet.has(file));
  if (hasExactlyExpectedFiles) {
    passedChecks.push("changedFiles contains exactly config, test, and docs files");
    evidence.push("changedFiles exactly README.md, scintilla.config.json, tests/config.test.ts");
  } else {
    failedChecks.push("changedFiles must contain exactly README.md, scintilla.config.json, and tests/config.test.ts");
  }

  if (!changedFileSet.has("package.json")) {
    passedChecks.push("package.json is not changed");
  } else {
    failedChecks.push("changedFiles must not include package.json");
  }

  const unrelatedFiles = candidate.changedFiles.filter((file) => !expectedFileSet.has(file));
  if (unrelatedFiles.length === 0) {
    passedChecks.push("candidate has no unrelated changed files");
  } else {
    failedChecks.push(`candidate includes unrelated changed files: ${unrelatedFiles.join(", ")}`);
  }

  for (const file of expectedFiles) {
    if (candidate.fileContents[file] !== undefined) {
      passedChecks.push(`fileContents includes ${file}`);
    } else {
      failedChecks.push(`fileContents must include ${file}`);
    }
  }

  const configContent = candidate.fileContents["scintilla.config.json"];
  let parsedConfig: unknown;
  if (configContent !== undefined) {
    try {
      parsedConfig = JSON.parse(configContent);
      passedChecks.push("scintilla.config.json parses");
      evidence.push("config JSON parsed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedChecks.push("scintilla.config.json must be parseable JSON");
      evidence.push(`config parse error: ${message}`);
    }
  }

  if (typeof parsedConfig === "object" && parsedConfig !== null && !Array.isArray(parsedConfig)) {
    const config = parsedConfig as Record<string, unknown>;
    if (config["auditEverySteps"] === 3) {
      passedChecks.push("config auditEverySteps is 3");
      evidence.push("config auditEverySteps === 3");
    } else {
      failedChecks.push("config auditEverySteps must be 3");
    }

    if (config["allowMultiFileWorkerTasks"] === false) {
      passedChecks.push("config allowMultiFileWorkerTasks remains false");
    } else {
      failedChecks.push("config allowMultiFileWorkerTasks must remain false");
    }

    if (config["defaultModelTier"] === "tier_1") {
      passedChecks.push("config defaultModelTier remains tier_1");
    } else {
      failedChecks.push("config defaultModelTier must remain tier_1");
    }
  }

  const testContent = candidate.fileContents["tests/config.test.ts"] ?? "";
  if (/auditEverySteps[^]*toBe\(\s*3\s*\)|auditEverySteps[^]*toEqual\(\s*3\s*\)/.test(testContent)) {
    passedChecks.push("tests/config.test.ts expects auditEverySteps 3");
    evidence.push("test expects auditEverySteps 3");
  } else {
    failedChecks.push("tests/config.test.ts must expect auditEverySteps to be 3");
  }

  if (/auditEverySteps[^]*toBe\(\s*5\s*\)|auditEverySteps[^]*toEqual\(\s*5\s*\)/.test(testContent)) {
    failedChecks.push("tests/config.test.ts must not still expect auditEverySteps 5");
  } else {
    passedChecks.push("tests/config.test.ts no longer expects auditEverySteps 5");
  }

  const readmeContent = candidate.fileContents["README.md"] ?? "";
  if (/3\s+steps|every\s+3/i.test(readmeContent)) {
    passedChecks.push("README documents every 3 steps");
    evidence.push("README mentions 3 steps");
  } else {
    failedChecks.push("README.md must document every 3 steps");
  }

  if (/5\s+steps|every\s+5/i.test(readmeContent)) {
    failedChecks.push("README.md must not still claim every 5 steps as current behavior");
  } else {
    passedChecks.push("README no longer claims every 5 steps");
  }

  const decomposition = candidate.decomposition;
  if (decomposition !== undefined) {
    passedChecks.push("decomposition is present");
    evidence.push(`decomposition strategy: ${decomposition.strategy}`);
  } else {
    failedChecks.push("decomposition is required");
  }

  if (decomposition !== undefined) {
    if (decomposition.strategy === "single_file_steps" || decomposition.strategy === "single_purpose_steps") {
      passedChecks.push("decomposition strategy is accepted");
    } else {
      failedChecks.push("decomposition strategy must be single_file_steps or single_purpose_steps");
    }

    const counts = countStepFiles(decomposition.steps);
    const hasOneStepPerFile = expectedFiles.every((file) => counts.get(file) === 1) && decomposition.steps.length === expectedFiles.length;
    if (hasOneStepPerFile) {
      passedChecks.push("decomposition has one step for each changed file");
      evidence.push("decomposition covers config, test, and docs separately");
    } else {
      failedChecks.push("decomposition must have exactly one step for each changed file");
    }

    for (const step of decomposition.steps) {
      if (purposeMatches(step.file, step.purpose)) {
        passedChecks.push(`decomposition purpose matches ${step.file}`);
      } else {
        failedChecks.push(`decomposition purpose must match file role for ${step.file}`);
      }
    }
  }

  if (hasClaimWithoutDiffEvidence(candidate)) {
    failedChecks.push("candidate notes claim success without diff evidence");
  } else {
    passedChecks.push("candidate does not rely on success claims without diff evidence");
  }

  return {
    ok: failedChecks.length === 0,
    benchmarkId,
    passedChecks,
    failedChecks,
    evidence
  };
}
