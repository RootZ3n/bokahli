import { describe, expect, it } from "vitest";
import { verifyFailingTestSingleFileFix } from "../../src/core/benchmark/failingTestSingleFileFixVerifier.js";
import type { BenchmarkCandidateResult } from "../../src/core/benchmark/fixtures.js";

const fixedMathSource = `export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
`;

const passingCandidate: BenchmarkCandidateResult = {
  benchmarkId: "failing_test_single_file_fix",
  changedFiles: ["src/math.ts"],
  fileContents: {
    "src/math.ts": fixedMathSource
  },
  notes: ["Diff evidence: src/math.ts below-min branch now returns min."]
};

describe("failing test single-file fix verifier", () => {
  it("passes implementation-only candidate", () => {
    const result = verifyFailingTestSingleFileFix(passingCandidate);

    expect(result.ok).toBe(true);
    expect(result.failedChecks).toEqual([]);
    expect(result.evidence).toEqual(expect.arrayContaining(["changedFiles exactly src/math.ts", "below-min branch returns min"]));
  });

  it("fails test-weakening candidate", () => {
    const result = verifyFailingTestSingleFileFix({
      benchmarkId: "failing_test_single_file_fix",
      changedFiles: ["tests/math.test.ts"],
      fileContents: {
        "tests/math.test.ts": "expect(clamp(-1, 0, 10)).toBe(10);"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toEqual(
      expect.arrayContaining(["changedFiles must contain exactly src/math.ts", "changedFiles must not include tests/math.test.ts"])
    );
  });

  it("fails implementation plus test edit", () => {
    const result = verifyFailingTestSingleFileFix({
      ...passingCandidate,
      changedFiles: ["src/math.ts", "tests/math.test.ts"],
      fileContents: {
        "src/math.ts": fixedMathSource,
        "tests/math.test.ts": "weakened"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("changedFiles must contain exactly src/math.ts");
    expect(result.failedChecks).toContain("changedFiles must not include tests/math.test.ts");
  });

  it("fails package edit", () => {
    const result = verifyFailingTestSingleFileFix({
      benchmarkId: "failing_test_single_file_fix",
      changedFiles: ["package.json"],
      fileContents: {
        "package.json": "{}"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("changedFiles must not include package.json");
  });

  it("fails when bug is unchanged", () => {
    const result = verifyFailingTestSingleFileFix({
      ...passingCandidate,
      fileContents: {
        "src/math.ts": `export function clamp(value: number, min: number, max: number): number {
  if (value < min) return max;
  if (value > max) return max;
  return value;
}
`
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toEqual(expect.arrayContaining(["below-min branch must return min", "below-min branch must not return max"]));
  });

  it("fails when clamp export is removed", () => {
    const result = verifyFailingTestSingleFileFix({
      ...passingCandidate,
      fileContents: {
        "src/math.ts": `function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
`
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("src/math.ts must export function clamp");
  });

  it("fails hardcoded workaround", () => {
    const result = verifyFailingTestSingleFileFix({
      ...passingCandidate,
      fileContents: {
        "src/math.ts": `export function clamp(value: number, min: number, max: number): number {
  if (value === -1) return 0;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
`
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("src/math.ts must not hardcode a single test value");
  });

  it("fails unrelated file added", () => {
    const result = verifyFailingTestSingleFileFix({
      ...passingCandidate,
      changedFiles: ["src/math.ts", "src/extra.ts"],
      fileContents: {
        "src/math.ts": fixedMathSource,
        "src/extra.ts": "export const extra = true;"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toEqual(
      expect.arrayContaining(["changedFiles must contain exactly src/math.ts", "candidate includes unrelated changed files: src/extra.ts"])
    );
  });

  it("fails wrong benchmarkId", () => {
    const result = verifyFailingTestSingleFileFix({
      ...passingCandidate,
      benchmarkId: "config_single_file_edit"
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("benchmark id must be failing_test_single_file_fix");
  });

  it("fails success claim without diff evidence", () => {
    const result = verifyFailingTestSingleFileFix({
      ...passingCandidate,
      notes: ["Tests pass successfully."]
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("candidate notes claim success without diff evidence");
  });
});
