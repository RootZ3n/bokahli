import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runContextPacketsListCli } from "../../src/cli/contextPackets.js";
import { loadContextPacketExampleManifest } from "../../src/index.js";

describe("context packets list CLI", () => {
  it("prints both template ids", async () => {
    const manifest = await loadContextPacketExampleManifest();
    const result = await runContextPacketsListCli([]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(manifest.templates).toHaveLength(2);
    for (const template of manifest.templates) {
      expect(result.stdout).toContain(template.id);
    }
  });

  it("--json emits parseable JSON with 2 templates", async () => {
    const result = await runContextPacketsListCli(["--json"]);
    const parsed = JSON.parse(result.stdout) as { version: number; generatedBy: string; templates: unknown[] };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(parsed.version).toBe(1);
    expect(parsed.generatedBy).toBe("manual");
    expect(parsed.templates).toHaveLength(2);
  });

  it("--task-type patch_one_file returns both current templates", async () => {
    const result = await runContextPacketsListCli(["--task-type", "patch_one_file"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("readme_patch_one_file");
    expect(result.stdout).toContain("config_patch_one_file");
  });

  it("--id readme_patch_one_file returns one template", async () => {
    const result = await runContextPacketsListCli(["--id", "readme_patch_one_file"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("readme_patch_one_file");
    expect(result.stdout).not.toContain("config_patch_one_file");
  });

  it("unknown --id exits 1", async () => {
    const result = await runContextPacketsListCli(["--id", "unknown"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No context packet templates found for id: unknown");
  });

  it("--help exits 0", async () => {
    const result = await runContextPacketsListCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("scintilla context-packets list");
  });

  it("unknown flag exits 2", async () => {
    const result = await runContextPacketsListCli(["--bad"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown flag: --bad");
  });

  it("forbidden flags exit 2", async () => {
    for (const flag of ["--model", "--ollama", "--execute", "--apply", "--scan", "--build"]) {
      const result = await runContextPacketsListCli([flag]);

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`${flag} is not supported by this read-only context packet examples command`);
    }
  });

  it("does not scan repos or build packets", async () => {
    const source = await readFile("src/cli/contextPackets.ts", "utf8");

    expect(source).not.toContain("scanRepoContext");
    expect(source).not.toContain("buildContextPacket");
    expect(source).not.toContain("previewRepoFiles");
    expect(source).not.toContain("buildRepoContextMap");
  });
});
