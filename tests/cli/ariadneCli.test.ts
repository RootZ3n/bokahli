import { readFile, stat, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAriadnePacketCli, runAriadneScanCli } from "../../src/cli/ariadne.js";
import type { ContextPacket, RepoContextMap } from "../../src/index.js";

const fixtureRoot = "tests/fixtures/simple-ts-repo";

describe("Ariadne scan CLI", () => {
  it("ariadne scan --repo fixture exits 0", async () => {
    const result = await runAriadneScanCli(["--repo", fixtureRoot]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("root:");
  });

  it("human output includes section counts", async () => {
    const result = await runAriadneScanCli(["--repo", fixtureRoot]);

    expect(result.stdout).toContain("package manager: pnpm");
    expect(result.stdout).toContain("scripts: 2");
    expect(result.stdout).toContain("total files:");
    expect(result.stdout).toContain("section counts:");
    expect(result.stdout).toContain("  source:");
    expect(result.stdout).toContain("  tests:");
    expect(result.stdout).toContain("  docs:");
    expect(result.stdout).toContain("  config:");
    expect(result.stdout).toContain("  other:");
    expect(result.stdout).toContain("  ignoredContext:");
  });

  it("--json emits parseable RepoContextMap", async () => {
    const result = await runAriadneScanCli(["--repo", fixtureRoot, "--json"]);
    const parsed = JSON.parse(result.stdout) as RepoContextMap;

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(parsed.root).toContain("tests/fixtures/simple-ts-repo");
    expect(parsed.packageManager).toBe("pnpm");
    expect(parsed.sections.source.map((entry) => entry.path)).toEqual(expect.arrayContaining(["src/index.ts", "src/util.ts"]));
  });

  it("--help exits 0", async () => {
    const result = await runAriadneScanCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("scintilla ariadne scan");
  });

  it("missing --repo exits 2", async () => {
    const result = await runAriadneScanCli([]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--repo is required");
  });

  it("unknown flag exits 2", async () => {
    const result = await runAriadneScanCli(["--repo", fixtureRoot, "--bad"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown flag: --bad");
  });

  it("forbidden execution and model flags exit 2", async () => {
    for (const flag of ["--model", "--ollama", "--execute", "--apply"]) {
      const result = await runAriadneScanCli(["--repo", fixtureRoot, flag]);

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`${flag} is not supported by this read-only Ariadne scan command`);
    }
  });

  it("non-directory repo exits 2", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scintilla-ariadne-cli-"));
    const filePath = path.join(dir, "not-a-repo.ts");
    await writeFile(filePath, "export const value = 1;\n", "utf8");

    const result = await runAriadneScanCli(["--repo", filePath]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("root_not_directory");
  });

  it("does not mutate fixture repo", async () => {
    const packagePath = path.join(fixtureRoot, "package.json");
    const before = {
      contents: await readFile(packagePath, "utf8"),
      mtimeMs: (await stat(packagePath)).mtimeMs
    };

    await runAriadneScanCli(["--repo", fixtureRoot, "--json"]);

    const after = {
      contents: await readFile(packagePath, "utf8"),
      mtimeMs: (await stat(packagePath)).mtimeMs
    };
    expect(after).toEqual(before);
  });

  it("does not add shell execution or direct file content reads to the CLI", async () => {
    const source = await readFile("src/cli/ariadne.ts", "utf8");

    expect(source).not.toContain("child_process");
    expect(source).not.toContain("execFile");
    expect(source).not.toContain("spawn");
    expect(source).not.toContain("readFile");
  });
});

describe("Ariadne packet CLI", () => {
  const validPacketArgs = [
    "--repo",
    fixtureRoot,
    "--task-type",
    "patch_one_file",
    "--goal",
    "Update README usage text",
    "--allowed-file",
    "README.md",
    "--select",
    "README.md",
    "--verification",
    "pnpm test",
    "--json"
  ];

  it("builds packet JSON for simple fixture repo", async () => {
    const result = await runAriadnePacketCli(validPacketArgs);
    const packet = JSON.parse(result.stdout) as ContextPacket;

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(packet.repoRoot).toBe(fixtureRoot);
    expect(packet.repoSummary.packageManager).toBe("pnpm");
  });

  it("packet includes task goal, type, and allowed file", async () => {
    const packet = JSON.parse((await runAriadnePacketCli(validPacketArgs)).stdout) as ContextPacket;

    expect(packet.task.taskType).toBe("patch_one_file");
    expect(packet.task.goal).toBe("Update README usage text");
    expect(packet.task.allowedFiles).toEqual(["README.md"]);
    expect(packet.constraints.allowedFiles).toEqual(["README.md"]);
  });

  it("selected README preview is included", async () => {
    const packet = JSON.parse((await runAriadnePacketCli(validPacketArgs)).stdout) as ContextPacket;

    expect(packet.selectedPreviews.map((preview) => preview.path)).toEqual(["README.md"]);
    expect(packet.selectedPreviews[0]?.text).toContain("Simple TS Repo");
  });

  it("forbidden file flag appears in constraints", async () => {
    const packet = JSON.parse((await runAriadnePacketCli([...validPacketArgs, "--forbidden-file", "package.json"])).stdout) as ContextPacket;

    expect(packet.constraints.forbiddenFiles).toEqual(["package.json"]);
  });

  it("verification flag appears in task", async () => {
    const packet = JSON.parse((await runAriadnePacketCli([...validPacketArgs, "--verification", "pnpm typecheck"])).stdout) as ContextPacket;

    expect(packet.task.verificationRequired).toEqual(["pnpm test", "pnpm typecheck"]);
  });

  it("max bytes flags influence truncation and budgets", async () => {
    const packet = JSON.parse(
      (
        await runAriadnePacketCli([
          "--repo",
          fixtureRoot,
          "--task-type",
          "patch_one_file",
          "--goal",
          "Update README usage text",
          "--allowed-file",
          "README.md",
          "--select",
          "README.md",
          "--max-bytes-per-file",
          "4",
          "--max-total-preview-bytes",
          "4",
          "--max-packet-chars",
          "64000"
        ])
      ).stdout
    ) as ContextPacket;

    expect(packet.truncation.maxTotalPreviewBytes).toBe(4);
    expect(packet.truncation.totalPreviewBytes).toBe(4);
    expect(packet.truncation.anyFileTruncated).toBe(true);
    expect(packet.truncation.maxPacketChars).toBe(64000);
  });

  it("missing --repo exits 2", async () => {
    const result = await runAriadnePacketCli(validPacketArgs.filter((arg) => arg !== "--repo" && arg !== fixtureRoot));

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--repo is required");
  });

  it("missing --goal exits 2", async () => {
    const result = await runAriadnePacketCli(validPacketArgs.filter((arg) => arg !== "--goal" && arg !== "Update README usage text"));

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--goal is required");
  });

  it("missing --task-type exits 2", async () => {
    const result = await runAriadnePacketCli(validPacketArgs.filter((arg) => arg !== "--task-type" && arg !== "patch_one_file"));

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--task-type is required");
  });

  it("missing --select exits 2", async () => {
    const result = await runAriadnePacketCli([
      "--repo",
      fixtureRoot,
      "--task-type",
      "patch_one_file",
      "--goal",
      "Update README usage text",
      "--allowed-file",
      "README.md"
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--select is required at least once");
  });

  it("unknown flag exits 2", async () => {
    const result = await runAriadnePacketCli([...validPacketArgs, "--bad"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown flag: --bad");
  });

  it("forbidden execution and model flags exit 2", async () => {
    for (const flag of ["--model", "--ollama", "--execute", "--apply"]) {
      const result = await runAriadnePacketCli([...validPacketArgs, flag]);

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`${flag} is not supported by this read-only Ariadne packet command`);
    }
  });

  it("unsafe selected path returns skipped preview", async () => {
    const packet = JSON.parse(
      (
        await runAriadnePacketCli([
          "--repo",
          fixtureRoot,
          "--task-type",
          "patch_one_file",
          "--goal",
          "Update README usage text",
          "--allowed-file",
          "README.md",
          "--select",
          "../README.md"
        ])
      ).stdout
    ) as ContextPacket;

    expect(packet.selectedPreviews).toEqual([]);
    expect(packet.skippedPreviews).toEqual([expect.objectContaining({ path: "../README.md", reason: "path traversal is not allowed" })]);
  });

  it("contract mode emits valid packet JSON", async () => {
    const result = await runAriadnePacketCli([
      "--repo",
      fixtureRoot,
      "--contract",
      "examples/contracts/readme_patch_one_file.contract.json",
      "--json"
    ]);
    const packet = JSON.parse(result.stdout) as ContextPacket;

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(packet.task.taskType).toBe("patch_one_file");
    expect(packet.task.goal).toBe("Update README usage text");
    expect(packet.constraints.allowedFiles).toEqual(["README.md"]);
    expect(packet.constraints.forbiddenFiles).toEqual(["package.json"]);
    expect(packet.task.verificationRequired).toEqual(["pnpm test"]);
    expect(packet.selectedPreviews.map((preview) => preview.path)).toEqual(["README.md"]);
    expect(packet.constraints.workerAuthority).toBe("propose_only");
    expect(packet.constraints.verifierDeterminesTruth).toBe(true);
  });

  it("contract mode allows explicit selected path override", async () => {
    const result = await runAriadnePacketCli([
      "--repo",
      fixtureRoot,
      "--contract",
      "examples/contracts/readme_patch_one_file.contract.json",
      "--select",
      "src/index.ts",
      "--json"
    ]);
    const packet = JSON.parse(result.stdout) as ContextPacket;

    expect(result.exitCode).toBe(0);
    expect(packet.selectedPreviews.map((preview) => preview.path)).toEqual(["src/index.ts"]);
    expect(packet.constraints.allowedFiles).toEqual(["README.md"]);
  });

  it("invalid contract exits 2 before packet output", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scintilla-ariadne-contract-"));
    const contractPath = path.join(dir, "invalid.contract.json");
    await writeFile(
      contractPath,
      JSON.stringify({
        taskType: "patch_one_file",
        goal: "Update README usage text",
        allowedFiles: ["/README.md"]
      }),
      "utf8"
    );

    const result = await runAriadnePacketCli(["--repo", fixtureRoot, "--contract", contractPath, "--json"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unsafe_path");
  });

  it("does not mutate fixture repo", async () => {
    const packagePath = path.join(fixtureRoot, "package.json");
    const before = {
      contents: await readFile(packagePath, "utf8"),
      mtimeMs: (await stat(packagePath)).mtimeMs
    };

    await runAriadnePacketCli(validPacketArgs);

    const after = {
      contents: await readFile(packagePath, "utf8"),
      mtimeMs: (await stat(packagePath)).mtimeMs
    };
    expect(after).toEqual(before);
  });
});
