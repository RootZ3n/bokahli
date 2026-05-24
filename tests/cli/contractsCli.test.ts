import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runContractsListCli } from "../../src/cli/contracts.js";

describe("contracts list CLI", () => {
  it("prints readme_patch_one_file", async () => {
    const result = await runContractsListCli([]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("readme_patch_one_file");
    expect(result.stdout).toContain("examples/contracts/readme_patch_one_file.contract.json");
  });

  it("--json emits parseable JSON", async () => {
    const result = await runContractsListCli(["--json"]);
    const parsed = JSON.parse(result.stdout) as { version: number; generatedBy: string; templates: unknown[] };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(parsed.version).toBe(1);
    expect(parsed.generatedBy).toBe("manual");
    expect(parsed.templates).toHaveLength(1);
  });

  it("--task-type patch_one_file returns matching templates", async () => {
    const result = await runContractsListCli(["--task-type", "patch_one_file"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("readme_patch_one_file");
  });

  it("--id readme_patch_one_file returns one template", async () => {
    const result = await runContractsListCli(["--id", "readme_patch_one_file"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("readme_patch_one_file");
    expect(result.stdout).toContain("examples/contracts/readme_patch_one_file.contract.json");
  });

  it("unknown --id exits 1", async () => {
    const result = await runContractsListCli(["--id", "unknown"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No contract templates found for id: unknown");
  });

  it("--help exits 0", async () => {
    const result = await runContractsListCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("scintilla contracts list");
  });

  it("unknown flag exits 2", async () => {
    const result = await runContractsListCli(["--bad"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown flag: --bad");
  });

  it("forbidden flags exit 2", async () => {
    for (const flag of ["--model", "--ollama", "--execute", "--apply", "--scan", "--build", "--packet"]) {
      const result = await runContractsListCli([flag]);

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`${flag} is not supported by this read-only contract examples command`);
    }
  });

  it("does not scan repos or build packets", async () => {
    const source = await readFile("src/cli/contracts.ts", "utf8");

    expect(source).not.toContain("scanRepoContext");
    expect(source).not.toContain("buildContextPacket");
    expect(source).not.toContain("previewRepoFiles");
    expect(source).not.toContain("buildRepoContextMap");
  });
});
