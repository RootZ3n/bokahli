import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runMockPipelineCli } from "../../src/cli/mockPipeline.js";
import type { ContextPacket, MockPipelineResult, TaskContract } from "../../src/index.js";
import { validateBenchmarkCandidateResult } from "../../src/index.js";
import { runMockPipeline } from "../../src/index.js";

const examplesDir = "examples/mock-pipeline";
const exampleFile = "docs_single_file_edit.passed.result.json";
const secretPatterns = [/sk-/, /OPENAI_API_KEY/, /ANTHROPIC_API_KEY/, /OPENROUTER_API_KEY/, /ZAI_API_KEY/, /Bearer/];

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function readExample(): Promise<MockPipelineResult> {
  return readJsonFile<MockPipelineResult>(path.join(examplesDir, exampleFile));
}

async function loadInputs(): Promise<{ contract: TaskContract; contextPacket: ContextPacket }> {
  return {
    contract: await readJsonFile<TaskContract>("examples/contracts/readme_patch_one_file.contract.json"),
    contextPacket: await readJsonFile<ContextPacket>("examples/context-packets/readme_patch_one_file.packet.json")
  };
}

function normalize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("mock-pipeline result examples", () => {
  it("parses every result example", async () => {
    const files = (await readdir(examplesDir)).filter((entry) => entry.endsWith(".result.json")).sort();

    expect(files).toEqual([exampleFile]);
    for (const file of files) {
      await expect(readJsonFile(path.join(examplesDir, file))).resolves.toEqual(expect.any(Object));
    }
  });

  it("captures the passing docs_single_file_edit result shape", async () => {
    const result = await readExample();

    expect(result).toMatchObject({
      ok: true,
      status: "passed",
      benchmarkId: "docs_single_file_edit",
      scenario: "valid_docs_single_file_edit",
      worker: expect.any(Object),
      candidate: expect.any(Object),
      validation: expect.any(Object),
      evaluation: expect.any(Object)
    });
  });

  it("contains candidate data that validates", async () => {
    const result = await readExample();

    if (!result.ok) {
      throw new Error("expected passed example");
    }

    const validation = validateBenchmarkCandidateResult(result.candidate, {
      supportedBenchmarkIds: ["docs_single_file_edit"]
    });

    expect(validation.ok).toBe(true);
    expect(result.validation.ok).toBe(true);
    expect(result.candidate.benchmarkId).toBe("docs_single_file_edit");
    expect(result.candidate.changedFiles).toEqual(["README.md"]);
  });

  it("contains a passing evaluation result", async () => {
    const result = await readExample();

    if (!result.ok) {
      throw new Error("expected passed example");
    }

    expect(result.evaluation).toMatchObject({
      ok: true,
      benchmarkId: "docs_single_file_edit"
    });
    expect(result.evaluation.ok && result.evaluation.verification.ok).toBe(true);
  });

  it("does not contain obvious secret-like strings", async () => {
    for (const file of (await readdir(examplesDir)).filter((entry) => entry.endsWith(".json"))) {
      const contents = await readFile(path.join(examplesDir, file), "utf8");
      for (const pattern of secretPatterns) {
        expect(contents, `${file} must not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("matches the current deterministic runMockPipeline output", async () => {
    const inputs = await loadInputs();
    const liveResult = await runMockPipeline({
      ...inputs,
      scenario: "valid_docs_single_file_edit",
      benchmarkId: "docs_single_file_edit"
    });

    expect(normalize(await readExample())).toEqual(normalize(liveResult));
  });

  it("the live mock-pipeline CLI still produces a passing result for the same inputs", async () => {
    const cliResult = await runMockPipelineCli([
      "--contract",
      "examples/contracts/readme_patch_one_file.contract.json",
      "--context-packet",
      "examples/context-packets/readme_patch_one_file.packet.json",
      "--scenario",
      "valid_docs_single_file_edit",
      "--benchmark",
      "docs_single_file_edit",
      "--json"
    ]);
    const parsed = JSON.parse(cliResult.stdout) as MockPipelineResult;

    expect(cliResult.exitCode).toBe(0);
    expect(cliResult.stderr).toBe("");
    expect(parsed).toMatchObject({
      ok: true,
      status: "passed",
      benchmarkId: "docs_single_file_edit",
      scenario: "valid_docs_single_file_edit"
    });
  });
});
