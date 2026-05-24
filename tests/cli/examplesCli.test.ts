import { describe, expect, it } from "vitest";
import { loadCandidateExampleManifest } from "../../src/index.js";
import { runExamplesListCli } from "../../src/cli/examples.js";

describe("examples list CLI", () => {
  it("prints all 9 template ids", async () => {
    const manifest = await loadCandidateExampleManifest();
    const result = await runExamplesListCli([]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(manifest.templates).toHaveLength(9);
    for (const template of manifest.templates) {
      expect(result.stdout).toContain(template.id);
    }
  });

  it("--json emits parseable JSON with 9 templates", async () => {
    const result = await runExamplesListCli(["--json"]);
    const parsed = JSON.parse(result.stdout) as { version: number; generatedBy: string; templates: unknown[] };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(parsed.version).toBe(1);
    expect(parsed.generatedBy).toBe("manual");
    expect(parsed.templates).toHaveLength(9);
  });

  it("--benchmark docs_single_file_edit returns pass and fail examples", async () => {
    const result = await runExamplesListCli(["--benchmark", "docs_single_file_edit"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("docs_single_file_edit.pass");
    expect(result.stdout).toContain("docs_single_file_edit.fail");
    expect(result.stdout).not.toContain("config_single_file_edit.pass");
  });

  it("--benchmark unknown exits 1", async () => {
    const result = await runExamplesListCli(["--benchmark", "unknown"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No candidate example templates found for benchmark: unknown");
  });

  it("--help exits 0", async () => {
    const result = await runExamplesListCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("scintilla examples list");
  });

  it("unknown flag exits 2", async () => {
    const result = await runExamplesListCli(["--bad"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown flag: --bad");
  });

  it("forbidden flags exit 2", async () => {
    const evaluateResult = await runExamplesListCli(["--evaluate"]);
    const modelResult = await runExamplesListCli(["--model"]);
    const applyResult = await runExamplesListCli(["--apply"]);

    expect(evaluateResult.exitCode).toBe(2);
    expect(evaluateResult.stderr).toContain("--evaluate is not supported by this read-only examples command");
    expect(modelResult.exitCode).toBe(2);
    expect(modelResult.stderr).toContain("--model is not supported by this read-only examples command");
    expect(applyResult.exitCode).toBe(2);
    expect(applyResult.stderr).toContain("--apply is not supported by this read-only examples command");
  });

  it("does not run candidate validation or evaluation", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile("src/cli/examples.ts", "utf8"));

    expect(source).not.toContain("loadCandidateResult");
    expect(source).not.toContain("evaluateBenchmark");
    expect(source).not.toContain("runBenchmarkFixture");
  });
});
