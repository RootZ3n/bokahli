import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadContractExampleManifest, validateContractExampleManifest, validateTaskContract, type TaskContract } from "../../src/index.js";

const examplesDir = "examples/contracts";
const manifestPath = path.join(examplesDir, "manifest.json");
const secretPatterns = [/sk-/, /OPENAI_API_KEY/, /ANTHROPIC_API_KEY/, /OPENROUTER_API_KEY/, /ZAI_API_KEY/, /Bearer/];

async function contractExampleFiles(): Promise<string[]> {
  const entries = await readdir(examplesDir);
  return entries.filter((entry) => entry.endsWith(".contract.json")).map((entry) => path.join(examplesDir, entry)).sort();
}

async function readContract(filePath: string): Promise<TaskContract> {
  return JSON.parse(await readFile(filePath, "utf8")) as TaskContract;
}

describe("contract example manifest", () => {
  it("parses and validates manifest.json", async () => {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    const validation = validateContractExampleManifest(parsed);

    expect(validation.ok).toBe(true);
  });

  it("uses manifest version 1", async () => {
    const manifest = await loadContractExampleManifest();

    expect(manifest.version).toBe(1);
  });

  it("has unique template ids", async () => {
    const manifest = await loadContractExampleManifest();
    const ids = manifest.templates.map((template) => template.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses only safe relative template paths", async () => {
    const manifest = await loadContractExampleManifest();

    for (const template of manifest.templates) {
      expect(path.isAbsolute(template.path), template.id).toBe(false);
      expect(template.path.split(/[\\/]/), template.id).not.toContain("..");
    }
  });

  it("lists every contract example JSON file exactly once", async () => {
    const manifest = await loadContractExampleManifest();
    const manifestPaths = manifest.templates.map((template) => template.path).sort();

    expect(manifestPaths).toEqual(await contractExampleFiles());
  });

  it("points every template path at an existing file", async () => {
    const manifest = await loadContractExampleManifest();

    for (const template of manifest.templates) {
      await expect(readFile(template.path, "utf8"), template.id).resolves.toEqual(expect.any(String));
    }
  });

  it("matches manifest fields to referenced contracts", async () => {
    const manifest = await loadContractExampleManifest();

    for (const template of manifest.templates) {
      const contract = await readContract(template.path);

      expect(contract.taskType, template.id).toBe(template.taskType);
      expect(contract.promptQuality, template.id).toBe(template.promptQuality);
      expect(contract.allowedFiles, template.id).toEqual(template.allowedFiles);
    }
  });

  it("validates every referenced contract", async () => {
    const manifest = await loadContractExampleManifest();

    for (const template of manifest.templates) {
      expect(validateTaskContract(await readContract(template.path)).ok, template.id).toBe(true);
    }
  });

  it("does not contain obvious secret-like strings", async () => {
    const manifestText = await readFile(manifestPath, "utf8");
    const contractTexts = await Promise.all((await contractExampleFiles()).map((filePath) => readFile(filePath, "utf8")));

    for (const pattern of secretPatterns) {
      expect(manifestText, `manifest must not match ${pattern}`).not.toMatch(pattern);
      for (const contractText of contractTexts) {
        expect(contractText, `contract must not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("returns structured errors for malformed manifest input", () => {
    const validation = validateContractExampleManifest({
      version: 2,
      generatedBy: "",
      templates: [
        {
          id: "duplicate",
          path: "/tmp/example.contract.json",
          taskType: "",
          promptQuality: "",
          allowedFiles: ["../README.md"],
          description: ""
        },
        {
          id: "duplicate",
          path: "examples/contracts/readme_patch_one_file.contract.json",
          taskType: "patch_one_file",
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
          expect.objectContaining({ path: "$.templates[0].taskType", code: "required_task_type" }),
          expect.objectContaining({ path: "$.templates[0].promptQuality", code: "invalid_prompt_quality" }),
          expect.objectContaining({ path: "$.templates[0].allowedFiles[0]", code: "unsafe_allowedFiles_entry" }),
          expect.objectContaining({ path: "$.templates[1].id", code: "duplicate_template_id" })
        ])
      );
    }
  });
});
