import { describe, expect, it } from "vitest";
import { listExecutableBenchmarks } from "../../src/index.js";
import { runBenchmarksListCli } from "../../src/cli/benchmarks.js";

describe("benchmarks list CLI", () => {
  it("prints all executable benchmark ids in human output", () => {
    const result = runBenchmarksListCli([]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    for (const summary of listExecutableBenchmarks()) {
      expect(result.stdout).toContain(summary.benchmarkId);
    }
  });

  it("--json emits parseable JSON matching executable summaries", () => {
    const result = runBenchmarksListCli(["--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(listExecutableBenchmarks());
  });

  it("accepts pnpm-style -- argument separator before --json", () => {
    const result = runBenchmarksListCli(["--", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(listExecutableBenchmarks());
  });

  it("--json includes messy_prompt_resilience with P3 and baseline false", () => {
    const result = runBenchmarksListCli(["--json"]);
    const parsed = JSON.parse(result.stdout) as Array<{ benchmarkId: string; promptQualityLevel: string; isBaseline: boolean }>;
    const messyPrompt = parsed.find((summary) => summary.benchmarkId === "messy_prompt_resilience");

    expect(messyPrompt).toMatchObject({
      benchmarkId: "messy_prompt_resilience",
      promptQualityLevel: "P3",
      isBaseline: false
    });
  });

  it("--help exits 0 and prints usage", () => {
    const result = runBenchmarksListCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("scintilla benchmarks list [--json]");
  });

  it("unknown flags exit 2 with clear stderr", () => {
    const result = runBenchmarksListCli(["--bad"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown flag: --bad");
  });

  it("does not expose evaluation or fixture loading behavior", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile("src/cli/benchmarks.ts", "utf8"));

    expect(source).not.toContain("evaluateBenchmark");
    expect(source).not.toContain("runBenchmarkFixture");
    expect(source).not.toContain("loadCandidateResult");
  });
});
