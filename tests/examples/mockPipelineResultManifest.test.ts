import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadMockPipelineResultManifest,
  type MockPipelineResult,
  validateMockPipelineResultManifest
} from "../../src/index.js";

const examplesDir = "examples/mock-pipeline";
const manifestPath = path.join(examplesDir, "manifest.json");
const secretPatterns = [/sk-/, /OPENAI_API_KEY/, /ANTHROPIC_API_KEY/, /OPENROUTER_API_KEY/, /ZAI_API_KEY/, /Bearer/];

async function resultExampleFiles(): Promise<string[]> {
  const entries = await readdir(examplesDir);
  return entries.filter((entry) => entry.endsWith(".result.json")).map((entry) => path.join(examplesDir, entry)).sort();
}

async function readResult(filePath: string): Promise<MockPipelineResult> {
  return JSON.parse(await readFile(filePath, "utf8")) as MockPipelineResult;
}

describe("mock-pipeline result manifest", () => {
  it("parses and validates manifest.json", async () => {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    const validation = validateMockPipelineResultManifest(parsed);

    expect(validation.ok).toBe(true);
  });

  it("uses manifest version 1", async () => {
    const manifest = await loadMockPipelineResultManifest();

    expect(manifest.version).toBe(1);
  });

  it("has unique result ids", async () => {
    const manifest = await loadMockPipelineResultManifest();
    const ids = manifest.results.map((entry) => entry.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses only safe relative result paths", async () => {
    const manifest = await loadMockPipelineResultManifest();

    for (const entry of manifest.results) {
      expect(path.isAbsolute(entry.path), entry.id).toBe(false);
      expect(entry.path.split(/[\\/]/), entry.id).not.toContain("..");
    }
  });

  it("points every result path at an existing file", async () => {
    const manifest = await loadMockPipelineResultManifest();

    for (const entry of manifest.results) {
      await expect(readFile(entry.path, "utf8"), entry.id).resolves.toEqual(expect.any(String));
    }
  });

  it("lists every result JSON file exactly once", async () => {
    const manifest = await loadMockPipelineResultManifest();
    const manifestPaths = manifest.results.map((entry) => entry.path).sort();

    expect(manifestPaths).toEqual(await resultExampleFiles());
  });

  it("matches manifest benchmarkId, scenario, and expectedStatus to result JSON", async () => {
    const manifest = await loadMockPipelineResultManifest();

    for (const entry of manifest.results) {
      const result = await readResult(entry.path);

      expect(result.benchmarkId, entry.id).toBe(entry.benchmarkId);
      expect(result.scenario, entry.id).toBe(entry.scenario);
      expect(result.status, entry.id).toBe(entry.expectedStatus);
    }
  });

  it("result fixtures have enough shape to identify worker, candidate, validation, and evaluation", async () => {
    const manifest = await loadMockPipelineResultManifest();

    for (const entry of manifest.results) {
      const result = await readResult(entry.path);

      expect(result, entry.id).toHaveProperty("worker");
      expect(result, entry.id).toHaveProperty("candidate");
      expect(result, entry.id).toHaveProperty("validation");
      expect(result, entry.id).toHaveProperty("evaluation");
    }
  });

  it("does not contain obvious secret-like strings in manifest entries", async () => {
    const manifest = await loadMockPipelineResultManifest();
    const manifestText = JSON.stringify(manifest);

    for (const pattern of secretPatterns) {
      expect(manifestText, `manifest must not match ${pattern}`).not.toMatch(pattern);
    }
  });

  it("does not contain obvious secret-like strings in result fixtures", async () => {
    for (const filePath of await resultExampleFiles()) {
      const contents = await readFile(filePath, "utf8");
      for (const pattern of secretPatterns) {
        expect(contents, `${filePath} must not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("returns structured errors for malformed manifest input", () => {
    const validation = validateMockPipelineResultManifest({
      version: 2,
      generatedBy: "",
      results: [
        {
          id: "duplicate",
          path: "/tmp/docs_single_file_edit.passed.result.json",
          benchmarkId: "",
          scenario: "",
          expectedStatus: "",
          description: ""
        },
        {
          id: "duplicate",
          path: "examples/mock-pipeline/docs_single_file_edit.passed.result.json",
          benchmarkId: "docs_single_file_edit",
          scenario: "valid_docs_single_file_edit",
          expectedStatus: "passed",
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
          expect.objectContaining({ path: "$.results[0].path", code: "unsafe_result_path" }),
          expect.objectContaining({ path: "$.results[0].benchmarkId", code: "required_benchmark_id" }),
          expect.objectContaining({ path: "$.results[0].scenario", code: "required_scenario" }),
          expect.objectContaining({ path: "$.results[0].expectedStatus", code: "required_expected_status" }),
          expect.objectContaining({ path: "$.results[1].id", code: "duplicate_result_id" })
        ])
      );
    }
  });
});
