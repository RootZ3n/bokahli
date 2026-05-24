import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runMockPipelineResultsListCli } from "../../src/cli/mockPipelineResults.js";

describe("mock-pipeline results list CLI", () => {
  it("prints docs_single_file_edit.passed", async () => {
    const result = await runMockPipelineResultsListCli([]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("docs_single_file_edit.passed");
    expect(result.stdout).toContain("docs_single_file_edit");
    expect(result.stdout).toContain("valid_docs_single_file_edit");
    expect(result.stdout).toContain("passed");
  });

  it("--json emits parseable JSON with 1 result", async () => {
    const result = await runMockPipelineResultsListCli(["--json"]);
    const parsed = JSON.parse(result.stdout) as { version: number; generatedBy: string; results: unknown[] };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(parsed.version).toBe(1);
    expect(parsed.generatedBy).toBe("manual");
    expect(parsed.results).toHaveLength(1);
  });

  it("--benchmark docs_single_file_edit returns matching result", async () => {
    const result = await runMockPipelineResultsListCli(["--benchmark", "docs_single_file_edit"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("docs_single_file_edit.passed");
  });

  it("--status passed returns matching result", async () => {
    const result = await runMockPipelineResultsListCli(["--status", "passed"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("docs_single_file_edit.passed");
  });

  it("--id docs_single_file_edit.passed returns one result", async () => {
    const result = await runMockPipelineResultsListCli(["--id", "docs_single_file_edit.passed"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("docs_single_file_edit.passed");
  });

  it("unknown --id exits 1", async () => {
    const result = await runMockPipelineResultsListCli(["--id", "unknown"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No mock-pipeline result fixtures found for id: unknown");
  });

  it("unknown --benchmark exits 1", async () => {
    const result = await runMockPipelineResultsListCli(["--benchmark", "unknown"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No mock-pipeline result fixtures found for benchmarkId: unknown");
  });

  it("--help exits 0", async () => {
    const result = await runMockPipelineResultsListCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("scintilla mock-pipeline-results list");
  });

  it("unknown flag exits 2", async () => {
    const result = await runMockPipelineResultsListCli(["--bad"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown flag: --bad");
  });

  it("forbidden flags exit 2", async () => {
    for (const flag of ["--model", "--ollama", "--execute", "--apply", "--scan", "--build", "--evaluate", "--validate"]) {
      const result = await runMockPipelineResultsListCli([flag]);

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`${flag} is not supported by this read-only mock-pipeline result examples command`);
    }
  });

  it("does not run pipeline, validation, evaluation, or repo scanning", async () => {
    const source = await readFile("src/cli/mockPipelineResults.ts", "utf8");

    expect(source).not.toMatch(/from ["'][^"']*mockPipeline(?:\.js)?["']/);
    expect(source).not.toContain("validateBenchmarkCandidateResult");
    expect(source).not.toContain("evaluateBenchmark");
    expect(source).not.toContain("runBenchmarkFixture");
    expect(source).not.toContain("scanRepoContext");
    expect(source).not.toContain("buildContextPacket");
  });
});
