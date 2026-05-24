import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  benchmarkRegistry,
  evaluateBenchmarkCandidateFromFile,
  loadCandidateExampleManifest,
  loadCandidateResultFromFile,
  validateCandidateExampleManifest
} from "../../src/index.js";

const examplesDir = "examples/candidates";
const manifestPath = path.join(examplesDir, "manifest.json");
const secretPatterns = [/sk-/, /OPENAI_API_KEY/, /ANTHROPIC_API_KEY/, /OPENROUTER_API_KEY/, /ZAI_API_KEY/, /Bearer/];

async function candidateExampleFiles(): Promise<string[]> {
  const entries = await readdir(examplesDir);
  return entries.filter((entry) => entry.endsWith(".json") && entry !== "manifest.json").map((entry) => path.join(examplesDir, entry)).sort();
}

describe("candidate example manifest", () => {
  it("parses and validates manifest.json", async () => {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    const validation = validateCandidateExampleManifest(parsed);

    expect(validation.ok).toBe(true);
  });

  it("uses manifest version 1", async () => {
    const manifest = await loadCandidateExampleManifest();

    expect(manifest.version).toBe(1);
  });

  it("has unique template ids", async () => {
    const manifest = await loadCandidateExampleManifest();
    const ids = manifest.templates.map((template) => template.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses only safe relative template paths", async () => {
    const manifest = await loadCandidateExampleManifest();

    for (const template of manifest.templates) {
      expect(path.isAbsolute(template.path), template.id).toBe(false);
      expect(template.path.split(/[\\/]/), template.id).not.toContain("..");
    }
  });

  it("points every template path at an existing file", async () => {
    const manifest = await loadCandidateExampleManifest();

    for (const template of manifest.templates) {
      await expect(readFile(template.path, "utf8"), template.id).resolves.toEqual(expect.any(String));
    }
  });

  it("lists every candidate example JSON file exactly once", async () => {
    const manifest = await loadCandidateExampleManifest();
    const manifestPaths = manifest.templates.map((template) => template.path).sort();

    expect(manifestPaths).toEqual(await candidateExampleFiles());
  });

  it("matches manifest benchmarkId to each candidate file benchmarkId", async () => {
    const manifest = await loadCandidateExampleManifest();

    for (const template of manifest.templates) {
      const parsedCandidate = JSON.parse(await readFile(template.path, "utf8")) as { benchmarkId?: unknown };

      expect(parsedCandidate.benchmarkId, template.id).toBe(template.benchmarkId);
    }
  });

  it("matches expectedValidation to actual candidate loading behavior", async () => {
    const manifest = await loadCandidateExampleManifest();

    for (const template of manifest.templates) {
      const result = await loadCandidateResultFromFile(template.path, {
        supportedBenchmarkIds: [template.benchmarkId]
      });

      expect(result.ok ? "pass" : "fail", template.id).toBe(template.expectedValidation);
    }
  });

  it("matches expectedEvaluation to actual deterministic evaluation behavior", async () => {
    const manifest = await loadCandidateExampleManifest();

    for (const template of manifest.templates) {
      const result = await evaluateBenchmarkCandidateFromFile(template.benchmarkId, template.path);

      expect(result.ok ? "pass" : "fail", template.id).toBe(template.expectedEvaluation);
    }
  });

  it("marks docs_single_file_edit.fail as validation pass and evaluation fail", async () => {
    const manifest = await loadCandidateExampleManifest();
    const template = manifest.templates.find((entry) => entry.id === "docs_single_file_edit.fail");

    expect(template).toMatchObject({
      benchmarkId: "docs_single_file_edit",
      path: "examples/candidates/docs_single_file_edit.fail.json",
      expectedValidation: "pass",
      expectedEvaluation: "fail"
    });
  });

  it("does not contain obvious secret-like strings", async () => {
    const manifest = await loadCandidateExampleManifest();
    const manifestText = JSON.stringify(manifest);

    for (const pattern of secretPatterns) {
      expect(manifestText, `manifest must not match ${pattern}`).not.toMatch(pattern);
    }
  });

  it("does not contain unknown benchmark ids", async () => {
    const manifest = await loadCandidateExampleManifest();
    const knownBenchmarkIds = new Set<string>(benchmarkRegistry.map((benchmark) => benchmark.id));

    for (const template of manifest.templates) {
      expect(knownBenchmarkIds.has(template.benchmarkId), template.id).toBe(true);
    }
  });
});
