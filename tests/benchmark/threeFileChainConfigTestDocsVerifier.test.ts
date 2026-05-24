import { describe, expect, it } from "vitest";
import { verifyThreeFileChainConfigTestDocs } from "../../src/core/benchmark/threeFileChainConfigTestDocsVerifier.js";
import type { BenchmarkCandidateResult } from "../../src/core/benchmark/fixtures.js";

const configContent = JSON.stringify(
  {
    auditEverySteps: 3,
    allowMultiFileWorkerTasks: false,
    defaultModelTier: "tier_1"
  },
  null,
  2
);

const testContent = `import config from "../scintilla.config.json";
import { describe, expect, it } from "vitest";

describe("config", () => {
  it("audits every 3 steps", () => {
    expect(config.auditEverySteps).toBe(3);
  });

  it("does not allow multi-file worker tasks", () => {
    expect(config.allowMultiFileWorkerTasks).toBe(false);
  });
});
`;

const readmeContent = "# Three File Chain Fixture\n\nAudits run every 3 steps.\n";

const passingCandidate: BenchmarkCandidateResult = {
  benchmarkId: "three_file_chain_config_test_docs",
  changedFiles: ["README.md", "scintilla.config.json", "tests/config.test.ts"],
  fileContents: {
    "README.md": readmeContent,
    "scintilla.config.json": configContent,
    "tests/config.test.ts": testContent
  },
  decomposition: {
    strategy: "single_file_steps",
    steps: [
      { stepId: "config", purpose: "config update auditEverySteps", file: "scintilla.config.json" },
      { stepId: "test", purpose: "test update expected audit frequency", file: "tests/config.test.ts" },
      { stepId: "docs", purpose: "docs update README audit frequency", file: "README.md" }
    ]
  },
  notes: ["Diff evidence: README.md, scintilla.config.json, and tests/config.test.ts changed."]
};

describe("three-file chain config/test/docs verifier", () => {
  it("passes coordinated three-file candidate with decomposition", () => {
    const result = verifyThreeFileChainConfigTestDocs(passingCandidate);

    expect(result.ok).toBe(true);
    expect(result.failedChecks).toEqual([]);
    expect(result.evidence).toEqual(expect.arrayContaining(["config auditEverySteps === 3", "decomposition covers config, test, and docs separately"]));
  });

  it("fails when only config changed", () => {
    const result = verifyThreeFileChainConfigTestDocs({
      ...passingCandidate,
      changedFiles: ["scintilla.config.json"],
      fileContents: {
        "scintilla.config.json": configContent
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("changedFiles must contain exactly README.md, scintilla.config.json, and tests/config.test.ts");
  });

  it("fails when config and docs change without test", () => {
    const result = verifyThreeFileChainConfigTestDocs({
      ...passingCandidate,
      changedFiles: ["README.md", "scintilla.config.json"],
      fileContents: {
        "README.md": readmeContent,
        "scintilla.config.json": configContent
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("fileContents must include tests/config.test.ts");
  });

  it("fails when test no longer expects auditEverySteps", () => {
    const result = verifyThreeFileChainConfigTestDocs({
      ...passingCandidate,
      fileContents: {
        ...passingCandidate.fileContents,
        "tests/config.test.ts": "expect(config.allowMultiFileWorkerTasks).toBe(false);"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("tests/config.test.ts must expect auditEverySteps to be 3");
  });

  it("fails when README still says 5", () => {
    const result = verifyThreeFileChainConfigTestDocs({
      ...passingCandidate,
      fileContents: {
        ...passingCandidate.fileContents,
        "README.md": "Audits run every 5 steps."
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("README.md must document every 3 steps");
    expect(result.failedChecks).toContain("README.md must not still claim every 5 steps as current behavior");
  });

  it("fails when config changes defaultModelTier", () => {
    const result = verifyThreeFileChainConfigTestDocs({
      ...passingCandidate,
      fileContents: {
        ...passingCandidate.fileContents,
        "scintilla.config.json": JSON.stringify({
          auditEverySteps: 3,
          allowMultiFileWorkerTasks: false,
          defaultModelTier: "tier_2"
        })
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("config defaultModelTier must remain tier_1");
  });

  it("fails package.json changes", () => {
    const result = verifyThreeFileChainConfigTestDocs({
      ...passingCandidate,
      changedFiles: [...passingCandidate.changedFiles, "package.json"],
      fileContents: {
        ...passingCandidate.fileContents,
        "package.json": "{}"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("changedFiles must not include package.json");
  });

  it("fails unrelated file additions", () => {
    const result = verifyThreeFileChainConfigTestDocs({
      ...passingCandidate,
      changedFiles: [...passingCandidate.changedFiles, "src/extra.ts"],
      fileContents: {
        ...passingCandidate.fileContents,
        "src/extra.ts": "export const extra = true;"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("candidate includes unrelated changed files: src/extra.ts");
  });

  it("fails correct edits without decomposition", () => {
    const { decomposition: _decomposition, ...candidate } = passingCandidate;
    const result = verifyThreeFileChainConfigTestDocs(candidate);

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("decomposition is required");
  });

  it("fails multi-file single decomposition step", () => {
    const result = verifyThreeFileChainConfigTestDocs({
      ...passingCandidate,
      decomposition: {
        strategy: "single_purpose_steps",
        steps: [{ stepId: "all", purpose: "config test docs update", file: "scintilla.config.json" }]
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("decomposition must have exactly one step for each changed file");
  });

  it("fails wrong benchmarkId", () => {
    const result = verifyThreeFileChainConfigTestDocs({
      ...passingCandidate,
      benchmarkId: "config_single_file_edit"
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("benchmark id must be three_file_chain_config_test_docs");
  });

  it("fails success claim without diff evidence", () => {
    const result = verifyThreeFileChainConfigTestDocs({
      ...passingCandidate,
      notes: ["Completed successfully."]
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("candidate notes claim success without diff evidence");
  });
});
