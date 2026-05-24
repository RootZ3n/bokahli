import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runMockPipelineCli } from "../../src/cli/mockPipeline.js";
import type { MockPipelineResult } from "../../src/index.js";

const validArgs = [
  "--contract",
  "examples/contracts/readme_patch_one_file.contract.json",
  "--context-packet",
  "examples/context-packets/readme_patch_one_file.packet.json",
  "--scenario",
  "valid_docs_single_file_edit",
  "--benchmark",
  "docs_single_file_edit",
  "--json"
];

function withScenario(scenario: string): string[] {
  const args = [...validArgs];
  const scenarioIndex = args.indexOf("--scenario") + 1;
  args[scenarioIndex] = scenario;
  return args;
}

describe("mock pipeline CLI", () => {
  it("valid_docs_single_file_edit exits 0 and JSON status is passed", async () => {
    const result = await runMockPipelineCli(validArgs);
    const parsed = JSON.parse(result.stdout) as MockPipelineResult;

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(parsed).toMatchObject({
      ok: true,
      status: "passed",
      benchmarkId: "docs_single_file_edit",
      scenario: "valid_docs_single_file_edit"
    });
  });

  it("invalid_schema exits 1 and status is candidate_invalid", async () => {
    const result = await runMockPipelineCli(withScenario("invalid_schema"));
    const parsed = JSON.parse(result.stdout) as MockPipelineResult;

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(parsed).toMatchObject({
      ok: false,
      status: "candidate_invalid",
      scenario: "invalid_schema"
    });
  });

  it("refusal_uncertain exits 1 and status is worker_refused", async () => {
    const result = await runMockPipelineCli(withScenario("refusal_uncertain"));
    const parsed = JSON.parse(result.stdout) as MockPipelineResult;

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(parsed).toMatchObject({
      ok: false,
      status: "worker_refused",
      scenario: "refusal_uncertain"
    });
  });

  it("wrong_benchmark_id exits 1 and status is benchmark_mismatch", async () => {
    const result = await runMockPipelineCli(withScenario("wrong_benchmark_id"));
    const parsed = JSON.parse(result.stdout) as MockPipelineResult;

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(parsed).toMatchObject({
      ok: false,
      status: "benchmark_mismatch",
      scenario: "wrong_benchmark_id"
    });
  });

  it("missing contract exits 2", async () => {
    const result = await runMockPipelineCli([
      "--contract",
      "examples/contracts/missing.contract.json",
      "--context-packet",
      "examples/context-packets/readme_patch_one_file.packet.json",
      "--scenario",
      "valid_docs_single_file_edit"
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("contract_file_error");
  });

  it("malformed context packet exits 2", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scintilla-mock-pipeline-"));
    const contextPacketPath = path.join(dir, "malformed.packet.json");
    await writeFile(contextPacketPath, "{", "utf8");

    const result = await runMockPipelineCli([
      "--contract",
      "examples/contracts/readme_patch_one_file.contract.json",
      "--context-packet",
      contextPacketPath,
      "--scenario",
      "valid_docs_single_file_edit"
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("context packet JSON could not be parsed");
  });

  it("unknown scenario exits 2", async () => {
    const result = await runMockPipelineCli(withScenario("unknown"));

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown mock worker scenario: unknown");
  });

  it("--help exits 0", async () => {
    const result = await runMockPipelineCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("scintilla mock-pipeline run");
  });

  it("unknown flag exits 2", async () => {
    const result = await runMockPipelineCli([...validArgs, "--bad"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown flag: --bad");
  });

  it("forbidden model, execution, and mutation flags exit 2", async () => {
    for (const flag of ["--model", "--ollama", "--execute", "--apply", "--write", "--edit", "--shell"]) {
      const result = await runMockPipelineCli([...validArgs, flag]);

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`${flag} is not supported by this deterministic mock pipeline command`);
    }
  });

  it("output is parseable JSON with no extra stdout text", async () => {
    const result = await runMockPipelineCli(validArgs);

    expect(result.stdout.trimStart().startsWith("{")).toBe(true);
    expect(result.stdout).not.toContain("PASS");
    expect(result.stdout).not.toContain("FAIL");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it("does not mutate fixture or example files", async () => {
    const paths = [
      "examples/contracts/readme_patch_one_file.contract.json",
      "examples/context-packets/readme_patch_one_file.packet.json",
      "tests/fixtures/docs-single-file-edit/README.md"
    ];
    const before = await Promise.all(paths.map((filePath) => readFile(filePath, "utf8")));

    await runMockPipelineCli(validArgs);

    const after = await Promise.all(paths.map((filePath) => readFile(filePath, "utf8")));
    expect(after).toEqual(before);
  });

  it("does not import shell, network, model, or Ollama modules", async () => {
    const source = await readFile("src/cli/mockPipeline.ts", "utf8");

    expect(source).not.toMatch(/from ["'](?:node:)?child_process["']/);
    expect(source).not.toMatch(/from ["'](?:node:)?(?:http|https|net|tls)["']/);
    expect(source).not.toMatch(/from ["'][^"']*(?:ollama|model)[^"']*["']/i);
  });
});
