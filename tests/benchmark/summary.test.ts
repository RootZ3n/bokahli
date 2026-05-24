import { describe, expect, it } from "vitest";
import {
  benchmarkFixtures,
  benchmarkRegistry,
  getExecutableBenchmarkSummary,
  listExecutableBenchmarks,
  type ExecutableBenchmarkSummary
} from "../../src/index.js";

function summaryById(benchmarkId: string): ExecutableBenchmarkSummary {
  const summary = getExecutableBenchmarkSummary(benchmarkId);
  expect(summary).toBeDefined();
  return summary!;
}

describe("executable benchmark summary API", () => {
  it("lists all executable benchmark ids", () => {
    const summaries = listExecutableBenchmarks();
    const ids = summaries.map((summary) => summary.benchmarkId);

    expect(ids).toEqual([
      "docs_single_file_edit",
      "config_single_file_edit",
      "failing_test_single_file_fix",
      "three_file_chain_config_test_docs",
      "context_retrieval_only",
      "drift_detection",
      "scope_violation_detection",
      "messy_prompt_resilience"
    ]);
  });

  it("uses registry order deterministically", () => {
    const summaries = listExecutableBenchmarks();
    const executableRegistryIds = benchmarkRegistry
      .map((benchmark) => benchmark.id)
      .filter((id) => benchmarkFixtures.some((fixture) => fixture.benchmarkId === id));

    expect(summaries.map((summary) => summary.benchmarkId)).toEqual(executableRegistryIds);
  });

  it("sets fixtureId and verifierId on every executable summary", () => {
    for (const summary of listExecutableBenchmarks()) {
      expect(summary.hasExecutableFixture, summary.benchmarkId).toBe(true);
      expect(summary.fixtureId, summary.benchmarkId).toMatch(/^tests\/fixtures\//);
      expect(summary.verifierId, summary.benchmarkId).toMatch(/Verifier$/);
    }
  });

  it("sets requiredCandidateFields on every executable summary", () => {
    for (const summary of listExecutableBenchmarks()) {
      expect(summary.requiredCandidateFields, summary.benchmarkId).toEqual(expect.arrayContaining(["benchmarkId", "changedFiles", "fileContents"]));
    }
  });

  it("keeps messy_prompt_resilience non-baseline with P3 prompt quality", () => {
    const summary = summaryById("messy_prompt_resilience");

    expect(summary.isBaseline).toBe(false);
    expect(summary.promptQualityLevel).toBe("P3");
    expect(summary.requiredCandidateFields).toContain("interpretedTask");
    expect(summary.requiresZeroEdits).toBe(true);
  });

  it("keeps docs and config single-file benchmarks baseline P0", () => {
    const docs = summaryById("docs_single_file_edit");
    const config = summaryById("config_single_file_edit");

    expect(docs.isBaseline).toBe(true);
    expect(docs.promptQualityLevel).toBe("P0");
    expect(docs.allowedChangedFiles).toEqual(["README.md"]);
    expect(docs.requiredCandidateFields).toEqual(expect.arrayContaining(["changedFiles", "fileContents"]));

    expect(config.isBaseline).toBe(true);
    expect(config.promptQualityLevel).toBe("P0");
    expect(config.allowedChangedFiles).toEqual(["scintilla.config.json"]);
    expect(config.requiredCandidateFields).toEqual(expect.arrayContaining(["changedFiles", "fileContents"]));
  });

  it("marks zero-edit benchmarks correctly", () => {
    expect(summaryById("context_retrieval_only").requiresZeroEdits).toBe(true);
    expect(summaryById("drift_detection").requiresZeroEdits).toBe(true);
    expect(summaryById("messy_prompt_resilience").requiresZeroEdits).toBe(true);

    expect(summaryById("docs_single_file_edit").requiresZeroEdits).toBe(false);
    expect(summaryById("config_single_file_edit").requiresZeroEdits).toBe(false);
  });

  it("exposes specialized candidate field requirements", () => {
    expect(summaryById("context_retrieval_only").requiredCandidateFields).toContain("evidence");
    expect(summaryById("scope_violation_detection").requiredCandidateFields).toContain("audit");
    expect(summaryById("drift_detection").requiredCandidateFields).toContain("drift");
  });

  it("exposes failing test fix target and test-weakening rejection", () => {
    const summary = summaryById("failing_test_single_file_fix");

    expect(summary.allowedChangedFiles).toEqual(["src/math.ts"]);
    expect(summary.rejects.join(" ")).toMatch(/test weakening/i);
  });

  it("exposes three-file decomposition requirement and avoids single-worker classification", () => {
    const summary = summaryById("three_file_chain_config_test_docs");

    expect(summary.requiredCandidateFields).toContain("decomposition");
    expect(summary.allowedChangedFiles).toEqual(["README.md", "scintilla.config.json", "tests/config.test.ts"]);
    expect(summary.verifies.join(" ")).toMatch(/single-file|single-purpose/i);
    expect(summary.rejects.join(" ")).toMatch(/single giant worker task/i);
  });

  it("returns undefined for unknown benchmark ids", () => {
    expect(getExecutableBenchmarkSummary("unknown_benchmark")).toBeUndefined();
  });

  it("does not mutate registry or fixture metadata", () => {
    const registryBefore = JSON.stringify(benchmarkRegistry);
    const fixturesBefore = JSON.stringify(benchmarkFixtures);

    const summaries = listExecutableBenchmarks();
    (summaries[0]?.allowedChangedFiles as string[] | undefined)?.push("mutated.md");
    (summaries[0]?.requiredCandidateFields as string[] | undefined)?.push("mutated");
    (getExecutableBenchmarkSummary("docs_single_file_edit")?.rejects as string[] | undefined)?.push("mutated");

    expect(JSON.stringify(benchmarkRegistry)).toBe(registryBefore);
    expect(JSON.stringify(benchmarkFixtures)).toBe(fixturesBefore);
    expect(summaryById("docs_single_file_edit").allowedChangedFiles).toEqual(["README.md"]);
  });
});
