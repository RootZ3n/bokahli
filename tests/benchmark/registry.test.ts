import { describe, expect, it } from "vitest";
import { benchmarkRegistry } from "../../src/core/benchmark/registry.js";

describe("benchmark registry", () => {
  it("has unique benchmark ids", () => {
    const ids = benchmarkRegistry.map((benchmark) => benchmark.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("defines success and failure criteria for every benchmark", () => {
    for (const benchmark of benchmarkRegistry) {
      expect(benchmark.success_criteria.length, benchmark.id).toBeGreaterThan(0);
      expect(benchmark.failure_criteria.length, benchmark.id).toBeGreaterThan(0);
    }
  });

  it("keeps baseline benchmarks at P0 only", () => {
    const baselineBenchmarks = benchmarkRegistry.filter((benchmark) => benchmark.baseline);

    expect(baselineBenchmarks.length).toBeGreaterThan(0);
    expect(baselineBenchmarks.every((benchmark) => benchmark.prompt_quality_level === "P0")).toBe(true);
  });

  it("keeps messy_prompt_resilience out of baseline", () => {
    const benchmark = benchmarkRegistry.find((entry) => entry.id === "messy_prompt_resilience");

    expect(benchmark?.baseline).toBe(false);
  });

  it("defines verifier requirements for every benchmark", () => {
    for (const benchmark of benchmarkRegistry) {
      expect(benchmark.verifier_requirements.length, benchmark.id).toBeGreaterThan(0);
    }
  });

  it("requires decomposition for three_file_chain_config_test_docs", () => {
    const benchmark = benchmarkRegistry.find((entry) => entry.id === "three_file_chain_config_test_docs");
    const searchableText = [
      ...(benchmark?.required_capabilities ?? []),
      ...(benchmark?.success_criteria ?? []),
      ...(benchmark?.verifier_requirements ?? [])
    ].join(" ");

    expect(searchableText).toContain("single-file");
    expect(searchableText).toContain("single-purpose");
    expect(benchmark?.expected_pipeline_phases).toContain("decompose");
  });

  it("requires verification evidence and rejects model self-claim as success", () => {
    for (const benchmark of benchmarkRegistry) {
      expect(benchmark.success_criteria.some((criterion) => criterion.includes("verification evidence")), benchmark.id).toBe(true);
      expect(
        benchmark.failure_criteria.some((criterion) => criterion.includes("model self-claim")) ||
          benchmark.verifier_requirements.some((requirement) => requirement.includes("model self-claim")),
        benchmark.id
      ).toBe(true);
    }
  });
});
