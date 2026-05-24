import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateBenchmarkCandidateFromFile,
  listExecutableBenchmarks,
  loadCandidateResultFromFile
} from "../../src/index.js";

const examplesDir = "examples/candidates";
const secretPatterns = [/sk-/, /OPENAI_API_KEY/, /ANTHROPIC_API_KEY/, /OPENROUTER_API_KEY/, /ZAI_API_KEY/, /Bearer/];

async function listExampleFiles(suffix: string): Promise<string[]> {
  const entries = await readdir(examplesDir);
  return entries.filter((entry) => entry.endsWith(suffix)).sort();
}

function benchmarkIdFromPassFile(fileName: string): string {
  return fileName.replace(/\.pass\.json$/, "");
}

describe("candidate JSON examples", () => {
  it("loads and validates every pass example", async () => {
    const passFiles = await listExampleFiles(".pass.json");

    expect(passFiles.length).toBeGreaterThan(0);
    for (const file of passFiles) {
      const benchmarkId = benchmarkIdFromPassFile(file);
      const result = await loadCandidateResultFromFile(path.join(examplesDir, file), {
        supportedBenchmarkIds: [benchmarkId]
      });

      expect(result.ok, file).toBe(true);
      if (result.ok) {
        expect(result.candidate.benchmarkId).toBe(benchmarkId);
      }
    }
  });

  it("evaluates every pass example successfully", async () => {
    const passFiles = await listExampleFiles(".pass.json");

    for (const file of passFiles) {
      const benchmarkId = benchmarkIdFromPassFile(file);
      const result = await evaluateBenchmarkCandidateFromFile(benchmarkId, path.join(examplesDir, file));

      expect(result.ok, file).toBe(true);
    }
  });

  it("docs_single_file_edit fail example validates but fails evaluation", async () => {
    const filePath = path.join(examplesDir, "docs_single_file_edit.fail.json");
    const loadResult = await loadCandidateResultFromFile(filePath, {
      supportedBenchmarkIds: ["docs_single_file_edit"]
    });
    const evaluationResult = await evaluateBenchmarkCandidateFromFile("docs_single_file_edit", filePath);

    expect(loadResult.ok).toBe(true);
    expect(evaluationResult.ok).toBe(false);
    if (!evaluationResult.ok) {
      expect(evaluationResult.stage).toBe("verify");
    }
  });

  it("has exactly one pass example for every executable benchmark", async () => {
    const expectedIds = listExecutableBenchmarks().map((summary) => summary.benchmarkId).sort();
    const actualIds = (await listExampleFiles(".pass.json")).map(benchmarkIdFromPassFile).sort();

    expect(actualIds).toEqual(expectedIds);
  });

  it("does not contain obvious secret-like strings", async () => {
    const exampleFiles = await listExampleFiles(".json");

    for (const file of exampleFiles) {
      const contents = await readFile(path.join(examplesDir, file), "utf8");
      for (const pattern of secretPatterns) {
        expect(contents, `${file} must not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
