import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadContextPacketExampleManifest,
  validateContextPacketExampleManifest,
  type ContextPacket
} from "../../src/index.js";

const examplesDir = "examples/context-packets";
const manifestPath = path.join(examplesDir, "manifest.json");
const secretPatterns = [/sk-/, /OPENAI_API_KEY/, /ANTHROPIC_API_KEY/, /OPENROUTER_API_KEY/, /ZAI_API_KEY/, /Bearer/];

async function packetExampleFiles(): Promise<string[]> {
  const entries = await readdir(examplesDir);
  return entries.filter((entry) => entry.endsWith(".packet.json")).map((entry) => path.join(examplesDir, entry)).sort();
}

async function readPacket(filePath: string): Promise<ContextPacket> {
  return JSON.parse(await readFile(filePath, "utf8")) as ContextPacket;
}

describe("context packet example manifest", () => {
  it("parses and validates manifest.json", async () => {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    const validation = validateContextPacketExampleManifest(parsed);

    expect(validation.ok).toBe(true);
  });

  it("uses manifest version 1", async () => {
    const manifest = await loadContextPacketExampleManifest();

    expect(manifest.version).toBe(1);
  });

  it("has unique template ids", async () => {
    const manifest = await loadContextPacketExampleManifest();
    const ids = manifest.templates.map((template) => template.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses only safe relative template paths", async () => {
    const manifest = await loadContextPacketExampleManifest();

    for (const template of manifest.templates) {
      expect(path.isAbsolute(template.path), template.id).toBe(false);
      expect(template.path.split(/[\\/]/), template.id).not.toContain("..");
    }
  });

  it("points every template path at an existing file", async () => {
    const manifest = await loadContextPacketExampleManifest();

    for (const template of manifest.templates) {
      await expect(readFile(template.path, "utf8"), template.id).resolves.toEqual(expect.any(String));
    }
  });

  it("lists every packet example JSON file exactly once", async () => {
    const manifest = await loadContextPacketExampleManifest();
    const manifestPaths = manifest.templates.map((template) => template.path).sort();

    expect(manifestPaths).toEqual(await packetExampleFiles());
  });

  it("matches manifest taskType to packet task.taskType", async () => {
    const manifest = await loadContextPacketExampleManifest();

    for (const template of manifest.templates) {
      const packet = await readPacket(template.path);

      expect(packet.task.taskType, template.id).toBe(template.taskType);
    }
  });

  it("matches manifest goal to packet task.goal", async () => {
    const manifest = await loadContextPacketExampleManifest();

    for (const template of manifest.templates) {
      const packet = await readPacket(template.path);

      expect(packet.task.goal, template.id).toBe(template.goal);
    }
  });

  it("matches selectedPaths to selected or skipped preview paths", async () => {
    const manifest = await loadContextPacketExampleManifest();

    for (const template of manifest.templates) {
      const packet = await readPacket(template.path);
      const packetPaths = new Set([...packet.selectedPreviews.map((preview) => preview.path), ...packet.skippedPreviews.map((skip) => skip.path)]);

      expect(template.selectedPaths.every((selectedPath) => packetPaths.has(selectedPath)), template.id).toBe(true);
    }
  });

  it("matches allowedFiles to packet constraints.allowedFiles", async () => {
    const manifest = await loadContextPacketExampleManifest();

    for (const template of manifest.templates) {
      const packet = await readPacket(template.path);

      expect(packet.constraints.allowedFiles, template.id).toEqual(template.allowedFiles);
    }
  });

  it("does not contain obvious secret-like strings in manifest entries", async () => {
    const manifest = await loadContextPacketExampleManifest();
    const manifestText = JSON.stringify(manifest);

    for (const pattern of secretPatterns) {
      expect(manifestText, `manifest must not match ${pattern}`).not.toMatch(pattern);
    }
  });

  it("does not contain obvious secret-like strings in packet examples", async () => {
    for (const filePath of await packetExampleFiles()) {
      const contents = await readFile(filePath, "utf8");
      for (const pattern of secretPatterns) {
        expect(contents, `${filePath} must not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("returns structured errors for malformed manifest input", () => {
    const validation = validateContextPacketExampleManifest({
      version: 2,
      generatedBy: "",
      templates: [
        {
          id: "duplicate",
          path: "/tmp/example.packet.json",
          taskType: "",
          goal: "",
          selectedPaths: ["../README.md"],
          allowedFiles: "README.md",
          description: ""
        },
        {
          id: "duplicate",
          path: "examples/context-packets/readme_patch_one_file.packet.json",
          taskType: "patch_one_file",
          goal: "Update README usage text",
          selectedPaths: ["README.md"],
          allowedFiles: ["README.md"],
          description: "Duplicate id."
        }
      ]
    });

    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "$.version", code: "invalid_version" }),
          expect.objectContaining({ path: "$.generatedBy", code: "required_generated_by" }),
          expect.objectContaining({ path: "$.templates[0].path", code: "unsafe_template_path" }),
          expect.objectContaining({ path: "$.templates[0].selectedPaths[0]", code: "unsafe_selectedPaths_entry" }),
          expect.objectContaining({ path: "$.templates[0].allowedFiles", code: "required_allowedFiles" }),
          expect.objectContaining({ path: "$.templates[1].id", code: "duplicate_template_id" })
        ])
      );
    }
  });
});
