import { describe, expect, it } from "vitest";
import { verifyContextRetrievalOnly } from "../../src/core/benchmark/contextRetrievalOnlyVerifier.js";
import type { BenchmarkCandidateResult } from "../../src/core/benchmark/fixtures.js";

const passingCandidate: BenchmarkCandidateResult = {
  benchmarkId: "context_retrieval_only",
  changedFiles: [],
  fileContents: {},
  evidence: [
    {
      file: "docs/ARCHITECTURE.md",
      quote: "Ariadne is the repo context keeper.",
      reason: "This file explains that Ariadne is the repo context keeper."
    },
    {
      file: "src/audit/drift.ts",
      quote: "export function detectDrift",
      reason: "This file defines detectDrift for drift detection."
    }
  ],
  notes: ["Evidence cites docs/ARCHITECTURE.md and src/audit/drift.ts."]
};

describe("context retrieval only verifier", () => {
  it("passes with both required citations", () => {
    const result = verifyContextRetrievalOnly(passingCandidate);

    expect(result.ok).toBe(true);
    expect(result.failedChecks).toEqual([]);
    expect(result.evidence).toEqual(expect.arrayContaining(["evidence cites docs/ARCHITECTURE.md", "evidence cites src/audit/drift.ts"]));
  });

  it("fails when changedFiles is non-empty", () => {
    const result = verifyContextRetrievalOnly({
      ...passingCandidate,
      changedFiles: ["README.md"],
      fileContents: {
        "README.md": "changed"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toEqual(
      expect.arrayContaining(["changedFiles must be empty for context retrieval", "fileContents must be empty for context retrieval"])
    );
  });

  it("fails when docs/ARCHITECTURE.md evidence is missing", () => {
    const result = verifyContextRetrievalOnly({
      ...passingCandidate,
      evidence: passingCandidate.evidence?.filter((entry) => entry.file !== "docs/ARCHITECTURE.md")
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("evidence must include docs/ARCHITECTURE.md");
  });

  it("fails when src/audit/drift.ts evidence is missing", () => {
    const result = verifyContextRetrievalOnly({
      ...passingCandidate,
      evidence: passingCandidate.evidence?.filter((entry) => entry.file !== "src/audit/drift.ts")
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("evidence must include src/audit/drift.ts");
  });

  it("fails unrelated-only evidence", () => {
    const result = verifyContextRetrievalOnly({
      ...passingCandidate,
      evidence: [
        {
          file: "src/context/repoMap.ts",
          reason: "buildRepoMap maps repository files.",
          quote: "buildRepoMap"
        }
      ]
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toEqual(
      expect.arrayContaining([
        "evidence must include docs/ARCHITECTURE.md",
        "evidence must include src/audit/drift.ts",
        "src/context/repoMap.ts alone cannot satisfy both retrieval requirements"
      ])
    );
  });

  it("fails package and README only evidence", () => {
    const result = verifyContextRetrievalOnly({
      ...passingCandidate,
      evidence: [
        {
          file: "README.md",
          reason: "README names Scintilla Context Fixture."
        },
        {
          file: "package.json",
          reason: "Package metadata is present."
        }
      ]
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("package.json and README.md cannot be the only evidence");
  });

  it("fails wrong benchmarkId", () => {
    const result = verifyContextRetrievalOnly({
      ...passingCandidate,
      benchmarkId: "docs_single_file_edit"
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("benchmark id must be context_retrieval_only");
  });

  it("fails a success claim without evidence", () => {
    const result = verifyContextRetrievalOnly({
      benchmarkId: "context_retrieval_only",
      changedFiles: [],
      fileContents: {},
      notes: ["Completed successfully."]
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("candidate notes claim success or changes without cited evidence");
  });
});
