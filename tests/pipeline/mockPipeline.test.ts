import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ContextPacket } from "../../src/core/context/contextPacket.js";
import type { TaskContract } from "../../src/core/contracts/types.js";
import { runMockPipeline } from "../../src/core/pipeline/mockPipeline.js";

async function loadJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function loadReadmeInputs(): Promise<{ contract: TaskContract; contextPacket: ContextPacket }> {
  const contract = await loadJsonFile<TaskContract>("examples/contracts/readme_patch_one_file.contract.json");
  const contextPacket = await loadJsonFile<ContextPacket>("examples/context-packets/readme_patch_one_file.packet.json");

  return { contract, contextPacket };
}

function stableResult(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("runMockPipeline", () => {
  it("valid_docs_single_file_edit returns passed result", async () => {
    const input = await loadReadmeInputs();
    const result = await runMockPipeline({
      ...input,
      scenario: "valid_docs_single_file_edit",
      benchmarkId: "docs_single_file_edit"
    });

    expect(result).toMatchObject({
      ok: true,
      status: "passed",
      benchmarkId: "docs_single_file_edit",
      scenario: "valid_docs_single_file_edit"
    });
    expect(result.ok && result.validation.ok).toBe(true);
    expect(result.ok && result.evaluation.ok).toBe(true);
    expect(result.ok && result.candidate.changedFiles).toEqual(["README.md"]);
  });

  it("invalid_schema returns candidate_invalid without evaluation", async () => {
    const input = await loadReadmeInputs();
    const result = await runMockPipeline({
      ...input,
      scenario: "invalid_schema",
      benchmarkId: "docs_single_file_edit"
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected invalid_schema to fail");
    }
    expect(result.status).toBe("candidate_invalid");
    expect(result.validation?.ok).toBe(false);
    expect(result.evaluation).toBeUndefined();
    expect(result.errors.map((error) => error.code)).toContain("required_string_array");
  });

  it("wrong_benchmark_id returns benchmark_mismatch before evaluation", async () => {
    const input = await loadReadmeInputs();
    const result = await runMockPipeline({
      ...input,
      scenario: "wrong_benchmark_id",
      benchmarkId: "docs_single_file_edit"
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected wrong_benchmark_id to fail");
    }
    expect(result.status).toBe("benchmark_mismatch");
    expect(result.validation).toBeUndefined();
    expect(result.evaluation).toBeUndefined();
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "benchmark_id_mismatch",
          path: "$.benchmarkId"
        })
      ])
    );
  });

  it("refusal_uncertain returns worker_refused and does not validate or evaluate", async () => {
    const input = await loadReadmeInputs();
    const result = await runMockPipeline({
      ...input,
      scenario: "refusal_uncertain",
      benchmarkId: "docs_single_file_edit"
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("worker_refused");
    expect(result.worker?.ok).toBe(false);
    expect(result.candidate).toBeUndefined();
    expect(result.validation).toBeUndefined();
    expect(result.evaluation).toBeUndefined();
  });

  it("scope_violation_detected can pass scope_violation_detection evaluation", async () => {
    const input = await loadReadmeInputs();
    const result = await runMockPipeline({
      ...input,
      scenario: "scope_violation_detected",
      benchmarkId: "scope_violation_detection"
    });

    expect(result).toMatchObject({
      ok: true,
      status: "passed",
      benchmarkId: "scope_violation_detection",
      scenario: "scope_violation_detected"
    });
    expect(result.ok && result.candidate.audit?.verdict).toBe("ROLLBACK_LAST_STEP");
  });

  it("drift_detected can pass drift_detection evaluation", async () => {
    const input = await loadReadmeInputs();
    const result = await runMockPipeline({
      ...input,
      scenario: "drift_detected",
      benchmarkId: "drift_detection"
    });

    expect(result).toMatchObject({
      ok: true,
      status: "passed",
      benchmarkId: "drift_detection",
      scenario: "drift_detected"
    });
    expect(result.ok && result.candidate.drift?.detected).toBe(true);
  });

  it("messy_prompt_interpreted can pass messy_prompt_resilience evaluation", async () => {
    const input = await loadReadmeInputs();
    const result = await runMockPipeline({
      contract: {
        ...input.contract,
        verificationRequired: ["pnpm test", "pnpm typecheck"]
      },
      contextPacket: input.contextPacket,
      scenario: "messy_prompt_interpreted",
      benchmarkId: "messy_prompt_resilience"
    });

    expect(result).toMatchObject({
      ok: true,
      status: "passed",
      benchmarkId: "messy_prompt_resilience",
      scenario: "messy_prompt_interpreted"
    });
    expect(result.ok && result.candidate.interpretedTask?.decompositionRequired).toBe(true);
  });

  it("invalid contract returns structured failure before worker runs", async () => {
    const input = await loadReadmeInputs();
    const result = await runMockPipeline({
      contract: {
        ...input.contract,
        allowedFiles: ["../README.md"]
      },
      contextPacket: input.contextPacket,
      scenario: "valid_docs_single_file_edit",
      benchmarkId: "docs_single_file_edit"
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected invalid contract to fail");
    }
    expect(result.status).toBe("contract_invalid");
    expect(result.worker).toBeUndefined();
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unsafe_path",
          path: "$.allowedFiles[0]"
        })
      ])
    );
  });

  it("does not mutate contract or context packet input", async () => {
    const input = await loadReadmeInputs();
    const before = stableResult(input);

    await runMockPipeline({
      ...input,
      scenario: "valid_docs_single_file_edit",
      benchmarkId: "docs_single_file_edit"
    });

    expect(stableResult(input)).toEqual(before);
  });

  it("returns deterministic result across repeated runs", async () => {
    const input = await loadReadmeInputs();
    const first = await runMockPipeline({
      ...input,
      scenario: "valid_docs_single_file_edit",
      benchmarkId: "docs_single_file_edit"
    });
    const second = await runMockPipeline({
      ...input,
      scenario: "valid_docs_single_file_edit",
      benchmarkId: "docs_single_file_edit"
    });

    expect(stableResult(first)).toEqual(stableResult(second));
  });

  it("does not import shell, network, model, or Ollama modules", async () => {
    const source = await readFile("src/core/pipeline/mockPipeline.ts", "utf8");

    expect(source).not.toMatch(/child_process|node:child_process|http|https|net|tls|ollama|model/i);
  });
});
