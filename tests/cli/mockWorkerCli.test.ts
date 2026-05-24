import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runMockWorkerCli } from "../../src/cli/mockWorker.js";
import {
  evaluateBenchmarkCandidateFromJsonString,
  validateBenchmarkCandidateResult,
  type BenchmarkCandidateResult,
  type WorkerResult
} from "../../src/index.js";

const validArgs = [
  "--contract",
  "examples/contracts/readme_patch_one_file.contract.json",
  "--context-packet",
  "examples/context-packets/readme_patch_one_file.packet.json",
  "--scenario",
  "valid_docs_single_file_edit"
];

describe("mock worker CLI", () => {
  it("valid_docs_single_file_edit emits candidate and exits 0", async () => {
    const result = await runMockWorkerCli(validArgs);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("CANDIDATE_EMITTED");
    expect(result.stdout).toContain("benchmarkId: docs_single_file_edit");
    expect(result.stdout).toContain("changedFiles: README.md");
  });

  it("--json emits parseable worker result", async () => {
    const result = await runMockWorkerCli([...validArgs, "--json"]);
    const parsed = JSON.parse(result.stdout) as WorkerResult;

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.candidate.benchmarkId).toBe("docs_single_file_edit");
      expect(parsed.candidate.fileContents["README.md"]).toContain("npm run doctor");
    }
  });

  it("--candidate-only emits parseable candidate JSON and exits 0", async () => {
    const result = await runMockWorkerCli([...validArgs, "--candidate-only"]);
    const parsed = JSON.parse(result.stdout) as BenchmarkCandidateResult;

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(parsed.benchmarkId).toBe("docs_single_file_edit");
    expect(parsed.changedFiles).toEqual(["README.md"]);
    expect(parsed.fileContents["README.md"]).toContain("npm run doctor");
  });

  it("--candidate-only output validates with candidate validation helper", async () => {
    const result = await runMockWorkerCli([...validArgs, "--candidate-only"]);
    const parsed = JSON.parse(result.stdout) as unknown;

    expect(validateBenchmarkCandidateResult(parsed).ok).toBe(true);
  });

  it("--candidate-only output evaluates successfully for docs_single_file_edit", async () => {
    const result = await runMockWorkerCli([...validArgs, "--candidate-only"]);
    const evaluation = await evaluateBenchmarkCandidateFromJsonString("docs_single_file_edit", result.stdout);

    expect(evaluation.ok).toBe(true);
  });

  it("refusal_uncertain exits 1 and emits refusal reason", async () => {
    const result = await runMockWorkerCli([...validArgs.slice(0, -1), "refusal_uncertain"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("NO_CANDIDATE");
    expect(result.stdout).toContain("uncertain");
  });

  it("refusal_uncertain --candidate-only exits 1 with empty stdout", async () => {
    const result = await runMockWorkerCli([...validArgs.slice(0, -1), "refusal_uncertain", "--candidate-only"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("emitted no candidate");
    expect(result.stderr).toContain("uncertain");
  });

  it("invalid_schema exits 0 because malformed candidate emission is intentional", async () => {
    const result = await runMockWorkerCli([...validArgs.slice(0, -1), "invalid_schema", "--json"]);
    const parsed = JSON.parse(result.stdout) as WorkerResult;

    expect(result.exitCode).toBe(0);
    expect(parsed.ok).toBe(false);
    expect(parsed.candidate).toEqual(expect.objectContaining({ benchmarkId: "docs_single_file_edit" }));
  });

  it("invalid_schema --candidate-only exits 0 and emits raw malformed candidate payload", async () => {
    const result = await runMockWorkerCli([...validArgs.slice(0, -1), "invalid_schema", "--candidate-only"]);
    const parsed = JSON.parse(result.stdout) as unknown;

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(parsed).toEqual(
      expect.objectContaining({
        benchmarkId: "docs_single_file_edit",
        fileContents: expect.any(Object)
      })
    );
    expect(validateBenchmarkCandidateResult(parsed).ok).toBe(false);
  });

  it("unknown scenario exits 2", async () => {
    const result = await runMockWorkerCli([...validArgs.slice(0, -1), "unknown"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown mock worker scenario: unknown");
  });

  it("invalid contract exits 2", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scintilla-mock-worker-"));
    const contractPath = path.join(dir, "invalid.contract.json");
    await writeFile(
      contractPath,
      JSON.stringify({
        goal: "Missing task type",
        allowedFiles: ["README.md"]
      }),
      "utf8"
    );

    const result = await runMockWorkerCli([
      "--contract",
      contractPath,
      "--context-packet",
      "examples/context-packets/readme_patch_one_file.packet.json",
      "--scenario",
      "valid_docs_single_file_edit"
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("$.taskType");
  });

  it("missing context packet exits 2", async () => {
    const result = await runMockWorkerCli([
      "--contract",
      "examples/contracts/readme_patch_one_file.contract.json",
      "--context-packet",
      "examples/context-packets/missing.packet.json",
      "--scenario",
      "valid_docs_single_file_edit"
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("context packet file could not be inspected");
  });

  it("unknown flag exits 2", async () => {
    const result = await runMockWorkerCli([...validArgs, "--bad"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown flag: --bad");
  });

  it("forbidden execution, model, and evaluation flags exit 2", async () => {
    for (const flag of ["--model", "--ollama", "--evaluate", "--apply"]) {
      const result = await runMockWorkerCli([...validArgs, flag]);

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`${flag} is not supported by this deterministic mock worker command`);
    }
  });

  it("human mode without --candidate-only still works", async () => {
    const result = await runMockWorkerCli(validArgs);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("CANDIDATE_EMITTED");
    expect(result.stdout).toContain("changedFiles: README.md");
  });

  it("--candidate-only stdout has no wrapper or extra human text", async () => {
    const result = await runMockWorkerCli([...validArgs, "--candidate-only"]);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.stdout.trimStart().startsWith("{")).toBe(true);
    expect(result.stdout).not.toContain("CANDIDATE_EMITTED");
    expect(result.stdout).not.toContain('"candidate"');
    expect(parsed["benchmarkId"]).toBe("docs_single_file_edit");
  });

  it("does not run candidate validation or benchmark evaluation", async () => {
    const source = await readFile("src/cli/mockWorker.ts", "utf8");

    expect(source).not.toContain("validateBenchmarkCandidateResult");
    expect(source).not.toContain("evaluateBenchmark");
    expect(source).not.toContain("runBenchmarkFixture");
  });

  it("output is deterministic across repeated runs", async () => {
    const first = await runMockWorkerCli([...validArgs, "--json"]);
    const second = await runMockWorkerCli([...validArgs, "--json"]);

    expect(second).toEqual(first);
  });
});
