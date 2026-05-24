import { describe, expect, it } from "vitest";
import {
  buildContextPacket,
  buildContextPacketFromContract,
  buildRepoContextMap,
  scanRepoContext,
  type ContextPacket,
  type ContextPacketInput,
  TaskContractPacketValidationError,
  type RepoContextMap
} from "../../src/index.js";

const fixtureRoot = "tests/fixtures/simple-ts-repo";

async function createInput(overrides: Partial<ContextPacketInput> = {}): Promise<ContextPacketInput> {
  const snapshot = await scanRepoContext(fixtureRoot);
  const repoMap = buildRepoContextMap(snapshot);

  return {
    repoRoot: fixtureRoot,
    repoMap,
    task: {
      benchmarkId: "docs_single_file_edit",
      taskType: "docs_update",
      promptQuality: "P0",
      goal: "Update README usage docs.",
      allowedFiles: ["README.md"],
      forbiddenFiles: ["package.json"],
      verificationRequired: ["deterministic verifier"]
    },
    selectedPaths: ["README.md", "src/index.ts"],
    ...overrides
  };
}

function normalizePacket(packet: ContextPacket): ContextPacket {
  return {
    ...packet,
    generatedAt: "<generated>"
  };
}

describe("Ariadne context packet builder", () => {
  it("builds packet with repo summary and selected previews", async () => {
    const packet = await buildContextPacket(await createInput());

    expect(packet.repoSummary.packageManager).toBe("pnpm");
    expect(packet.repoSummary.totals.files).toBeGreaterThan(0);
    expect(packet.selectedPreviews.map((preview) => preview.path)).toEqual(["README.md", "src/index.ts"]);
    expect(packet.selectedPreviews[0]?.text).toContain("Simple TS Repo");
  });

  it("includes task goal, type, and allowed files", async () => {
    const packet = await buildContextPacket(await createInput());

    expect(packet.task.taskType).toBe("docs_update");
    expect(packet.task.goal).toBe("Update README usage docs.");
    expect(packet.task.allowedFiles).toEqual(["README.md"]);
    expect(packet.constraints.allowedFiles).toEqual(["README.md"]);
  });

  it("sets workerAuthority to propose_only", async () => {
    const packet = await buildContextPacket(await createInput());

    expect(packet.constraints.workerAuthority).toBe("propose_only");
  });

  it("sets verifierDeterminesTruth true", async () => {
    const packet = await buildContextPacket(await createInput());

    expect(packet.constraints.verifierDeterminesTruth).toBe(true);
  });

  it("includes forbidden files", async () => {
    const packet = await buildContextPacket(await createInput());

    expect(packet.constraints.forbiddenFiles).toEqual(["package.json"]);
  });

  it("previews only selected paths", async () => {
    const packet = await buildContextPacket(
      await createInput({
        selectedPaths: ["README.md"]
      })
    );

    expect(packet.selectedPreviews.map((preview) => preview.path)).toEqual(["README.md"]);
    expect(packet.selectedPreviews.map((preview) => preview.path)).not.toContain("src/util.ts");
  });

  it("carries skipped preview reasons", async () => {
    const packet = await buildContextPacket(
      await createInput({
        selectedPaths: ["missing.md"]
      })
    );

    expect(packet.selectedPreviews).toEqual([]);
    expect(packet.skippedPreviews).toEqual([expect.objectContaining({ path: "missing.md", reason: "file does not exist" })]);
  });

  it("carries repoMap warnings", async () => {
    const input = await createInput();
    const repoMap: RepoContextMap = {
      ...input.repoMap,
      warnings: ["repo warning"]
    };

    const packet = await buildContextPacket({
      ...input,
      repoMap
    });

    expect(packet.warnings).toContain("repo warning");
  });

  it("detects anyFileTruncated when preview truncates", async () => {
    const packet = await buildContextPacket(
      await createInput({
        selectedPaths: ["README.md"],
        budgets: {
          maxBytesPerFile: 4
        }
      })
    );

    expect(packet.selectedPreviews[0]?.truncated).toBe(true);
    expect(packet.truncation.anyFileTruncated).toBe(true);
  });

  it("respects maxTotalPreviewBytes through previewRepoFiles", async () => {
    const packet = await buildContextPacket(
      await createInput({
        selectedPaths: ["README.md", "src/index.ts"],
        budgets: {
          maxBytesPerFile: 100,
          maxTotalPreviewBytes: 10
        }
      })
    );

    expect(packet.truncation.totalPreviewBytes).toBe(10);
    expect(packet.truncation.maxTotalPreviewBytes).toBe(10);
    expect(packet.selectedPreviews[0]?.truncated).toBe(true);
    expect(packet.skippedPreviews[0]).toEqual(expect.objectContaining({ path: "src/index.ts", reason: "total byte budget exceeded" }));
  });

  it("is deterministic apart from generatedAt", async () => {
    const input = await createInput();
    const first = normalizePacket(await buildContextPacket(input));
    const second = normalizePacket(await buildContextPacket(input));

    expect(second).toEqual(first);
  });

  it("does not mutate repoMap or input task", async () => {
    const input = await createInput();
    const repoMapBefore = JSON.stringify(input.repoMap);
    const taskBefore = JSON.stringify(input.task);

    await buildContextPacket(input);

    expect(JSON.stringify(input.repoMap)).toBe(repoMapBefore);
    expect(JSON.stringify(input.task)).toBe(taskBefore);
  });

  it("handles empty selectedPaths", async () => {
    const packet = await buildContextPacket(
      await createInput({
        selectedPaths: []
      })
    );

    expect(packet.selectedPreviews).toEqual([]);
    expect(packet.skippedPreviews).toEqual([]);
    expect(packet.truncation.totalPreviewBytes).toBe(0);
  });

  it("section summaries include source, tests, docs, and config paths", async () => {
    const input = await createInput();
    const repoMap: RepoContextMap = {
      ...input.repoMap,
      sections: {
        ...input.repoMap.sections,
        tests: [
          {
            path: "tests/example.test.ts",
            extension: ".ts",
            sizeBytes: 1,
            mtimeMs: 1,
            reason: "test"
          }
        ]
      }
    };

    const packet = await buildContextPacket({
      ...input,
      repoMap
    });

    expect(packet.repoSummary.sections.source).toEqual(expect.arrayContaining(["src/index.ts", "src/util.ts"]));
    expect(packet.repoSummary.sections.tests).toEqual(["tests/example.test.ts"]);
    expect(packet.repoSummary.sections.docs).toEqual(expect.arrayContaining(["README.md"]));
    expect(packet.repoSummary.sections.config).toEqual(expect.arrayContaining(["config.json", "package.json"]));
  });

  it("truncates section summaries for maxPacketChars before preview text when possible", async () => {
    const input = await createInput();
    const repoMap: RepoContextMap = {
      ...input.repoMap,
      sections: {
        ...input.repoMap.sections,
        other: Array.from({ length: 500 }, (_, index) => ({
          path: `generated/other-${index}.json`,
          extension: ".json",
          sizeBytes: 1,
          mtimeMs: 1,
          reason: "other"
        }))
      }
    };

    const packet = await buildContextPacket({
      ...input,
      repoMap,
      selectedPaths: ["README.md"],
      budgets: {
        maxPacketChars: 3000
      }
    });

    expect(packet.truncation.packetTruncated).toBe(true);
    expect(packet.repoSummary.sections.other.length).toBeLessThan(500);
    expect(packet.selectedPreviews[0]?.text).toContain("Simple TS Repo");
  });

  it("builds a packet from a valid TaskContract", async () => {
    const input = await createInput();
    const packet = await buildContextPacketFromContract({
      repoRoot: input.repoRoot,
      repoMap: input.repoMap,
      contract: {
        id: "readme_patch_one_file",
        taskType: "patch_one_file",
        promptQuality: "P0",
        goal: "Update README usage text",
        allowedFiles: ["README.md"],
        forbiddenFiles: ["package.json"],
        verificationRequired: ["pnpm test"]
      }
    });

    expect(packet.task.taskType).toBe("patch_one_file");
    expect(packet.task.goal).toBe("Update README usage text");
    expect(packet.selectedPreviews.map((preview) => preview.path)).toEqual(["README.md"]);
  });

  it("invalid TaskContract fails before previews are read", async () => {
    const input = await createInput();

    await expect(
      buildContextPacketFromContract({
        repoRoot: "tests/fixtures/does-not-exist",
        repoMap: input.repoMap,
        contract: {
          taskType: "patch_one_file",
          goal: "Update README usage text",
          allowedFiles: ["/README.md"]
        }
      })
    ).rejects.toBeInstanceOf(TaskContractPacketValidationError);
  });

  it("contract selectedPaths default to allowedFiles", async () => {
    const input = await createInput();
    const packet = await buildContextPacketFromContract({
      repoRoot: input.repoRoot,
      repoMap: input.repoMap,
      contract: {
        taskType: "patch_one_file",
        goal: "Update README usage text",
        allowedFiles: ["README.md"]
      }
    });

    expect(packet.selectedPreviews.map((preview) => preview.path)).toEqual(["README.md"]);
  });

  it("contract forbidden paths and verification requirements are carried into the packet", async () => {
    const input = await createInput();
    const packet = await buildContextPacketFromContract({
      repoRoot: input.repoRoot,
      repoMap: input.repoMap,
      contract: {
        taskType: "patch_one_file",
        goal: "Update README usage text",
        allowedFiles: ["README.md"],
        forbiddenFiles: ["package.json"],
        verificationRequired: ["pnpm test"]
      }
    });

    expect(packet.constraints.forbiddenFiles).toEqual(["package.json"]);
    expect(packet.task.verificationRequired).toEqual(["pnpm test"]);
  });

  it("contract mode still sets packet authority constraints", async () => {
    const input = await createInput();
    const packet = await buildContextPacketFromContract({
      repoRoot: input.repoRoot,
      repoMap: input.repoMap,
      contract: {
        taskType: "patch_one_file",
        goal: "Update README usage text",
        allowedFiles: ["README.md"]
      }
    });

    expect(packet.constraints.workerAuthority).toBe("propose_only");
    expect(packet.constraints.verifierDeterminesTruth).toBe(true);
  });
});
