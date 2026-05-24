import { describe, expect, it } from "vitest";
import { verifyConfigSingleFileEdit } from "../../src/core/benchmark/configSingleFileEditVerifier.js";
import type { BenchmarkCandidateResult } from "../../src/core/benchmark/fixtures.js";

function configContent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      auditEverySteps: 3,
      allowMultiFileWorkerTasks: false,
      defaultModelTier: "tier_1",
      ...overrides
    },
    null,
    2
  );
}

const passingCandidate: BenchmarkCandidateResult = {
  benchmarkId: "config_single_file_edit",
  changedFiles: ["scintilla.config.json"],
  fileContents: {
    "scintilla.config.json": configContent()
  },
  notes: ["Diff evidence: scintilla.config.json changed auditEverySteps from 5 to 3."]
};

describe("config single-file edit verifier", () => {
  it("passes a scoped config candidate", () => {
    const result = verifyConfigSingleFileEdit(passingCandidate);

    expect(result.ok).toBe(true);
    expect(result.failedChecks).toEqual([]);
    expect(result.evidence).toEqual(expect.arrayContaining(["auditEverySteps === 3", "allowMultiFileWorkerTasks === false"]));
  });

  it("fails a package.json-only edit", () => {
    const result = verifyConfigSingleFileEdit({
      benchmarkId: "config_single_file_edit",
      changedFiles: ["package.json"],
      fileContents: {
        "package.json": "{}"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toEqual(
      expect.arrayContaining(["changedFiles must include scintilla.config.json", "changedFiles must not include package.json"])
    );
  });

  it("fails a README.md edit", () => {
    const result = verifyConfigSingleFileEdit({
      benchmarkId: "config_single_file_edit",
      changedFiles: ["README.md"],
      fileContents: {
        "README.md": "Updated docs"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toEqual(
      expect.arrayContaining(["changedFiles must include scintilla.config.json", "changedFiles must not include README.md"])
    );
  });

  it("fails invalid JSON", () => {
    const result = verifyConfigSingleFileEdit({
      benchmarkId: "config_single_file_edit",
      changedFiles: ["scintilla.config.json"],
      fileContents: {
        "scintilla.config.json": "{ bad json"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("scintilla.config.json must be parseable JSON");
  });

  it("fails when auditEverySteps is unchanged", () => {
    const result = verifyConfigSingleFileEdit({
      ...passingCandidate,
      fileContents: {
        "scintilla.config.json": configContent({ auditEverySteps: 5 })
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("auditEverySteps must be exactly 3");
  });

  it("fails when auditEverySteps has the wrong value", () => {
    const result = verifyConfigSingleFileEdit({
      ...passingCandidate,
      fileContents: {
        "scintilla.config.json": configContent({ auditEverySteps: 4 })
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("auditEverySteps must be exactly 3");
  });

  it("fails when allowMultiFileWorkerTasks changes to true", () => {
    const result = verifyConfigSingleFileEdit({
      ...passingCandidate,
      fileContents: {
        "scintilla.config.json": configContent({ allowMultiFileWorkerTasks: true })
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("allowMultiFileWorkerTasks must remain false");
  });

  it("fails when defaultModelTier changes", () => {
    const result = verifyConfigSingleFileEdit({
      ...passingCandidate,
      fileContents: {
        "scintilla.config.json": configContent({ defaultModelTier: "tier_2" })
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("defaultModelTier must remain tier_1");
  });

  it("fails when an unrelated file is added", () => {
    const result = verifyConfigSingleFileEdit({
      benchmarkId: "config_single_file_edit",
      changedFiles: ["scintilla.config.json", "notes.txt"],
      fileContents: {
        "scintilla.config.json": configContent(),
        "notes.txt": "unrelated"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks.some((check) => check.includes("outside fixture allowlist"))).toBe(true);
  });

  it("fails wrong benchmarkId", () => {
    const result = verifyConfigSingleFileEdit({
      ...passingCandidate,
      benchmarkId: "docs_single_file_edit"
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("benchmark id must be config_single_file_edit");
  });

  it("fails a success claim without diff evidence", () => {
    const result = verifyConfigSingleFileEdit({
      ...passingCandidate,
      notes: ["Completed successfully."]
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("candidate notes claim success without diff evidence");
  });
});
