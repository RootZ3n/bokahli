import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ContextPacket } from "../../src/index.js";

const examplesDir = "examples/context-packets";
const secretPatterns = [/sk-/, /OPENAI_API_KEY/, /ANTHROPIC_API_KEY/, /OPENROUTER_API_KEY/, /ZAI_API_KEY/, /Bearer/];
const executionOrModelKeys = new Set(["model", "provider", "ollama", "apiKey", "commandToRun", "execute"]);

async function listPacketFiles(): Promise<string[]> {
  const entries = await readdir(examplesDir);
  return entries.filter((entry) => entry.endsWith(".packet.json")).sort();
}

async function readPacket(fileName: string): Promise<ContextPacket> {
  return JSON.parse(await readFile(path.join(examplesDir, fileName), "utf8")) as ContextPacket;
}

function expectPacketShape(packet: ContextPacket): void {
  expect(packet).toHaveProperty("generatedAt");
  expect(packet).toHaveProperty("repoRoot");
  expect(packet).toHaveProperty("task");
  expect(packet).toHaveProperty("repoSummary");
  expect(packet).toHaveProperty("selectedPreviews");
  expect(packet).toHaveProperty("skippedPreviews");
  expect(packet).toHaveProperty("constraints");
  expect(packet).toHaveProperty("truncation");
  expect(packet).toHaveProperty("warnings");

  expect(typeof packet.generatedAt).toBe("string");
  expect(typeof packet.repoRoot).toBe("string");
  expect(Array.isArray(packet.selectedPreviews)).toBe(true);
  expect(Array.isArray(packet.skippedPreviews)).toBe(true);
  expect(Array.isArray(packet.warnings)).toBe(true);
  expect(Array.isArray(packet.repoSummary.sections.source)).toBe(true);
  expect(Array.isArray(packet.repoSummary.sections.tests)).toBe(true);
  expect(Array.isArray(packet.repoSummary.sections.docs)).toBe(true);
  expect(Array.isArray(packet.repoSummary.sections.config)).toBe(true);
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (value === null || typeof value !== "object") {
    return keys;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    keys.add(key);
    collectKeys(nestedValue, keys);
  }

  return keys;
}

describe("Ariadne context packet examples", () => {
  it("parses every packet example and validates required top-level fields", async () => {
    const files = await listPacketFiles();

    expect(files).toEqual(["config_patch_one_file.packet.json", "readme_patch_one_file.packet.json"]);
    for (const file of files) {
      expectPacketShape(await readPacket(file));
    }
  });

  it("validates readme_patch_one_file packet fields", async () => {
    const packet = await readPacket("readme_patch_one_file.packet.json");

    expect(packet.task.taskType).toBe("patch_one_file");
    expect(packet.task.goal).toContain("README usage text");
    expect(packet.constraints.workerAuthority).toBe("propose_only");
    expect(packet.constraints.verifierDeterminesTruth).toBe(true);
    expect(packet.constraints.allowedFiles).toContain("README.md");
    expect(packet.selectedPreviews.map((preview) => preview.path)).toContain("README.md");
    expect(packet.repoSummary.sections.source).toEqual(expect.any(Array));
    expect(packet.repoSummary.sections.tests).toEqual(expect.any(Array));
    expect(packet.repoSummary.sections.docs).toEqual(expect.any(Array));
    expect(packet.repoSummary.sections.config).toEqual(expect.any(Array));
  });

  it("does not contain obvious secret-like strings", async () => {
    for (const file of await listPacketFiles()) {
      const contents = await readFile(path.join(examplesDir, file), "utf8");
      for (const pattern of secretPatterns) {
        expect(contents, `${file} must not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("does not include model or execution contract fields", async () => {
    for (const file of await listPacketFiles()) {
      const keys = collectKeys(await readPacket(file));
      for (const forbiddenKey of executionOrModelKeys) {
        expect(keys.has(forbiddenKey), `${file} must not include ${forbiddenKey}`).toBe(false);
      }
    }
  });
});
