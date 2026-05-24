import { describe, expect, it } from "vitest";
import { verifyDriftDetection } from "../../src/core/benchmark/driftDetectionVerifier.js";
import type { BenchmarkCandidateResult } from "../../src/core/benchmark/fixtures.js";

const passingCandidate: BenchmarkCandidateResult = {
  benchmarkId: "drift_detection",
  changedFiles: [],
  fileContents: {},
  drift: {
    detected: true,
    summary: "Documentation and configuration disagree: docs say 5 steps while config says 3.",
    expected: "Documentation claims audits run every 5 steps.",
    observed: "Configuration uses auditEverySteps 3.",
    evidenceFiles: ["docs/USAGE.md", "scintilla.config.json"]
  },
  evidence: [
    {
      file: "docs/USAGE.md",
      quote: "audit loop to run every 5 steps",
      reason: "Documentation side claims 5 steps."
    },
    {
      file: "scintilla.config.json",
      quote: '"auditEverySteps": 3',
      reason: "Config side shows 3 steps."
    }
  ],
  notes: ["Drift detected with cited docs and config evidence."]
};

describe("drift detection verifier", () => {
  it("passes when drift is detected with docs and config evidence and values 5/3", () => {
    const result = verifyDriftDetection(passingCandidate);

    expect(result.ok).toBe(true);
    expect(result.failedChecks).toEqual([]);
    expect(result.evidence).toEqual(expect.arrayContaining(["drift report mentions 5", "drift report mentions 3"]));
  });

  it("fails when changedFiles is non-empty", () => {
    const result = verifyDriftDetection({
      ...passingCandidate,
      changedFiles: ["README.md"],
      fileContents: {
        "README.md": "changed"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toEqual(
      expect.arrayContaining(["changedFiles must be empty for drift detection", "fileContents must be empty for drift detection"])
    );
  });

  it("fails when drift field is missing", () => {
    const { drift: _drift, ...candidate } = passingCandidate;
    const result = verifyDriftDetection(candidate);

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("drift report is required");
  });

  it("fails when drift.detected is false", () => {
    const result = verifyDriftDetection({
      ...passingCandidate,
      drift: {
        ...passingCandidate.drift!,
        detected: false
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("drift.detected must be true");
  });

  it("fails when docs evidence is missing", () => {
    const result = verifyDriftDetection({
      ...passingCandidate,
      drift: {
        ...passingCandidate.drift!,
        evidenceFiles: ["scintilla.config.json"]
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("drift evidenceFiles must include README.md or docs/USAGE.md");
  });

  it("fails when config/code evidence is missing", () => {
    const result = verifyDriftDetection({
      ...passingCandidate,
      drift: {
        ...passingCandidate.drift!,
        evidenceFiles: ["README.md"]
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("drift evidenceFiles must include scintilla.config.json or src/config/defaults.ts");
  });

  it("fails when summary lacks mismatch language", () => {
    const result = verifyDriftDetection({
      ...passingCandidate,
      drift: {
        ...passingCandidate.drift!,
        summary: "Audit frequency details are listed."
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("drift summary must mention mismatch, disagreement, drift, or inconsistency");
  });

  it("fails when value 5 or 3 is missing", () => {
    const result = verifyDriftDetection({
      ...passingCandidate,
      drift: {
        detected: true,
        summary: "Documentation and configuration drift in audit frequency.",
        expected: "Documentation describes a periodic audit.",
        observed: "Configuration uses a different interval.",
        evidenceFiles: ["README.md", "src/config/defaults.ts"]
      },
      evidence: []
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toEqual(expect.arrayContaining(["drift report must mention value 5", "drift report must mention value 3"]));
  });

  it("fails when candidate claims consistency", () => {
    const result = verifyDriftDetection({
      ...passingCandidate,
      drift: {
        ...passingCandidate.drift!,
        summary: "Everything is consistent."
      },
      notes: ["No mismatch found; successfully verified consistency."]
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("candidate must not claim the repo is consistent");
  });

  it("fails wrong benchmarkId", () => {
    const result = verifyDriftDetection({
      ...passingCandidate,
      benchmarkId: "context_retrieval_only"
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("benchmark id must be drift_detection");
  });
});
