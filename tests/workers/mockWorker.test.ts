import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildContextPacketFromContract,
  buildRepoContextMap,
  evaluateBenchmarkCandidateFromJsonString,
  runMockWorker,
  scanRepoContext,
  validateBenchmarkCandidateResult,
  type ContextPacket,
  type TaskContract
} from "../../src/index.js";

const fixtureRoot = "tests/fixtures/simple-ts-repo";

const docsContract: TaskContract = {
  benchmarkId: "docs_single_file_edit",
  taskType: "patch_one_file",
  promptQuality: "P0",
  goal: "Update README usage text",
  allowedFiles: ["README.md"],
  forbiddenFiles: ["package.json"],
  verificationRequired: ["deterministic verifier"]
};

async function createPacket(contract: TaskContract = docsContract): Promise<ContextPacket> {
  const snapshot = await scanRepoContext(fixtureRoot);
  const repoMap = buildRepoContextMap(snapshot);

  return buildContextPacketFromContract({
    repoRoot: fixtureRoot,
    repoMap,
    contract
  });
}

describe("deterministic mock worker", () => {
  it("valid_docs_single_file_edit produces a candidate that validates", async () => {
    const result = runMockWorker({
      contract: docsContract,
      contextPacket: await createPacket(),
      scenario: "valid_docs_single_file_edit"
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(validateBenchmarkCandidateResult(result.candidate).ok).toBe(true);
      expect(result.candidate.changedFiles).toEqual(["README.md"]);
      expect(result.candidate.fileContents["README.md"]).toContain("npm run doctor");
    }
  });

  it("valid_docs_single_file_edit evaluates successfully for docs_single_file_edit", async () => {
    const result = runMockWorker({
      contract: docsContract,
      contextPacket: await createPacket(),
      scenario: "valid_docs_single_file_edit"
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const evaluation = await evaluateBenchmarkCandidateFromJsonString("docs_single_file_edit", JSON.stringify(result.candidate));

      expect(evaluation.ok).toBe(true);
    }
  });

  it("invalid_schema fails candidate validation", async () => {
    const result = runMockWorker({
      contract: docsContract,
      contextPacket: await createPacket(),
      scenario: "invalid_schema"
    });

    expect(result.ok).toBe(false);
    expect(validateBenchmarkCandidateResult(result.candidate).ok).toBe(false);
  });

  it("wrong_benchmark_id fails evaluation as a mismatch", async () => {
    const result = runMockWorker({
      contract: docsContract,
      contextPacket: await createPacket(),
      scenario: "wrong_benchmark_id"
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const evaluation = await evaluateBenchmarkCandidateFromJsonString("docs_single_file_edit", JSON.stringify(result.candidate));

      expect(evaluation.ok).toBe(false);
      if (!evaluation.ok) {
        expect(evaluation.stage).toBe("verify");
        expect(evaluation.errors.map((error) => error.message).join("\n")).toContain("unsupported_benchmark: $.benchmarkId");
      }
    }
  });

  it("scope_violation_detected produces rollback audit candidate", async () => {
    const contract: TaskContract = {
      ...docsContract,
      benchmarkId: "scope_violation_detection",
      allowedFiles: ["src/allowed.ts"],
      forbiddenFiles: ["src/forbidden.ts"]
    };
    const result = runMockWorker({
      contract,
      contextPacket: await createPacket(contract),
      scenario: "scope_violation_detected"
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(validateBenchmarkCandidateResult(result.candidate).ok).toBe(true);
      expect(result.candidate.audit?.verdict).toBe("ROLLBACK_LAST_STEP");
      expect(result.candidate.audit?.flaggedFiles).toEqual(["src/forbidden.ts"]);
    }
  });

  it("drift_detected produces deterministic drift report", async () => {
    const contract: TaskContract = {
      ...docsContract,
      benchmarkId: "drift_detection",
      allowedFiles: ["README.md", "scintilla.config.json"]
    };
    const result = runMockWorker({
      contract,
      contextPacket: await createPacket(contract),
      scenario: "drift_detected"
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(validateBenchmarkCandidateResult(result.candidate).ok).toBe(true);
      expect(result.candidate.drift?.detected).toBe(true);
      expect(result.candidate.drift?.summary).toContain("5");
      expect(result.candidate.drift?.summary).toContain("3");
    }
  });

  it("messy_prompt_interpreted produces interpreted task candidate", async () => {
    const contract: TaskContract = {
      ...docsContract,
      benchmarkId: "messy_prompt_resilience",
      promptQuality: "P3",
      allowedFiles: ["scintilla.config.json", "tests/config.test.ts", "README.md"]
    };
    const result = runMockWorker({
      contract,
      contextPacket: await createPacket(contract),
      scenario: "messy_prompt_interpreted"
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(validateBenchmarkCandidateResult(result.candidate).ok).toBe(true);
      expect(result.candidate.interpretedTask?.decompositionRequired).toBe(true);
      expect(result.candidate.interpretedTask?.targetBehavior).toContain("5");
      expect(result.candidate.interpretedTask?.targetBehavior).toContain("3");
    }
  });

  it("refusal_uncertain returns no candidate and clear reason", async () => {
    const result = runMockWorker({
      contract: docsContract,
      contextPacket: await createPacket(),
      scenario: "refusal_uncertain"
    });

    expect(result.ok).toBe(false);
    expect(result.candidate).toBeUndefined();
    if (!result.ok) {
      expect(result.reason).toContain("uncertain");
    }
  });

  it("does not mutate contract or context packet input", async () => {
    const contextPacket = await createPacket();
    const contractBefore = JSON.stringify(docsContract);
    const packetBefore = JSON.stringify(contextPacket);

    runMockWorker({
      contract: docsContract,
      contextPacket,
      scenario: "valid_docs_single_file_edit"
    });

    expect(JSON.stringify(docsContract)).toBe(contractBefore);
    expect(JSON.stringify(contextPacket)).toBe(packetBefore);
  });

  it("does not import model, network, or child_process modules", async () => {
    const source = await readFile("src/core/workers/mockWorker.ts", "utf8");

    expect(source).not.toContain("child_process");
    expect(source).not.toContain("node:http");
    expect(source).not.toContain("node:https");
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("ollama");
  });

  it("output is deterministic across repeated calls", async () => {
    const contextPacket = await createPacket();
    const input = {
      contract: docsContract,
      contextPacket,
      scenario: "valid_docs_single_file_edit" as const
    };

    expect(runMockWorker(input)).toEqual(runMockWorker(input));
  });

  it("never includes verification success claims", async () => {
    const contextPacket = await createPacket();
    const outputs = [
      runMockWorker({ contract: docsContract, contextPacket, scenario: "valid_docs_single_file_edit" }),
      runMockWorker({ contract: docsContract, contextPacket, scenario: "scope_violation_detected" }),
      runMockWorker({ contract: docsContract, contextPacket, scenario: "drift_detected" }),
      runMockWorker({ contract: docsContract, contextPacket, scenario: "messy_prompt_interpreted" })
    ];

    for (const output of outputs) {
      expect(JSON.stringify(output).toLowerCase()).not.toContain("tests passed");
      expect(JSON.stringify(output).toLowerCase()).not.toContain("verification passed");
    }
  });

  it("unknown scenario returns structured refusal", async () => {
    const result = runMockWorker({
      contract: docsContract,
      contextPacket: await createPacket(),
      scenario: "unknown_scenario"
    });

    expect(result.ok).toBe(false);
    expect(result.candidate).toBeUndefined();
    if (!result.ok) {
      expect(result.reason).toContain("Unknown mock worker scenario");
    }
  });
});
