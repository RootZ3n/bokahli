import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadCandidateResultFromFile, loadCandidateResultFromJsonString } from "../../src/index.js";

const validCandidate = {
  benchmarkId: "docs_single_file_edit",
  changedFiles: ["README.md"],
  fileContents: {
    "README.md": "# Fixture\n\n## Usage\nRun `npm run doctor`.\n"
  },
  notes: ["Diff evidence: README.md changed."]
};

async function createTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "scintilla-candidate-loader-"));
}

describe("candidate result loader", () => {
  it("loads a valid JSON string", () => {
    const result = loadCandidateResultFromJsonString(JSON.stringify(validCandidate), {
      supportedBenchmarkIds: ["docs_single_file_edit"]
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe("string");
    if (result.ok) {
      expect(result.candidate).toEqual(validCandidate);
    }
  });

  it("returns json_parse_error for malformed JSON strings", () => {
    const result = loadCandidateResultFromJsonString("{ bad json");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "json_parse_error" })]));
    }
  });

  it("returns validation errors for unsupported benchmark IDs", () => {
    const result = loadCandidateResultFromJsonString(JSON.stringify({ ...validCandidate, benchmarkId: "unknown_benchmark" }), {
      supportedBenchmarkIds: ["docs_single_file_edit"]
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "candidate_validation_error", path: "$.benchmarkId" })])
      );
      expect(result.errors[0]?.message).toContain("unsupported_benchmark");
    }
  });

  it("returns validation errors when changedFiles is missing", () => {
    const { changedFiles: _changedFiles, ...candidate } = validCandidate;
    const result = loadCandidateResultFromJsonString(JSON.stringify(candidate));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "candidate_validation_error", path: "$.changedFiles" })])
      );
    }
  });

  it("loads a valid local JSON file", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "candidate.json");
    await writeFile(filePath, JSON.stringify(validCandidate), "utf8");

    const result = await loadCandidateResultFromFile(filePath, {
      allowedRoots: [dir],
      supportedBenchmarkIds: ["docs_single_file_edit"]
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe("file");
    if (result.ok) {
      expect(result.candidate.benchmarkId).toBe("docs_single_file_edit");
    }
  });

  it("returns file_not_found for missing files", async () => {
    const dir = await createTempDir();
    const result = await loadCandidateResultFromFile(path.join(dir, "missing.json"), {
      allowedRoots: [dir]
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "file_not_found" })]));
    }
  });

  it("fails for directory paths", async () => {
    const dir = await createTempDir();
    const result = await loadCandidateResultFromFile(dir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "file_is_directory" })]));
    }
  });

  it("fails for symlink paths", async () => {
    const dir = await createTempDir();
    const targetPath = path.join(dir, "candidate.json");
    const linkPath = path.join(dir, "candidate-link.json");
    await writeFile(targetPath, JSON.stringify(validCandidate), "utf8");
    await symlink(targetPath, linkPath);

    const result = await loadCandidateResultFromFile(linkPath, {
      allowedRoots: [dir]
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "file_is_symlink" })]));
    }
  });

  it("fails when file exceeds maxBytes", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "candidate.json");
    await writeFile(filePath, JSON.stringify(validCandidate), "utf8");

    const result = await loadCandidateResultFromFile(filePath, {
      allowedRoots: [dir],
      maxBytes: 2
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "file_too_large" })]));
    }
  });

  it("rejects URL strings as file paths", async () => {
    const result = await loadCandidateResultFromFile("https://example.test/candidate.json");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "url_not_allowed" })]));
    }
  });

  it("fails for absolute files outside allowedRoots", async () => {
    const allowedDir = await createTempDir();
    const outsideDir = await createTempDir();
    const outsideFile = path.join(outsideDir, "candidate.json");
    await writeFile(outsideFile, JSON.stringify(validCandidate), "utf8");

    const result = await loadCandidateResultFromFile(outsideFile, {
      allowedRoots: [allowedDir]
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "file_outside_allowed_roots" })]));
    }
  });

  it("fails for traversal paths when allowedRoots are configured", async () => {
    const allowedDir = await createTempDir();
    const nestedDir = path.join(allowedDir, "nested");
    await mkdir(nestedDir);
    const result = await loadCandidateResultFromFile("../candidate.json", {
      allowedRoots: [nestedDir]
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "file_outside_allowed_roots" })]));
    }
  });

  it("does not run benchmark verifiers", async () => {
    const result = loadCandidateResultFromJsonString(JSON.stringify({ ...validCandidate, fileContents: { "README.md": "missing command" } }), {
      supportedBenchmarkIds: ["docs_single_file_edit"]
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.fileContents["README.md"]).toBe("missing command");
    }
  });

  it("does not modify input files", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "candidate.json");
    const contents = JSON.stringify(validCandidate, null, 2);
    await writeFile(filePath, contents, "utf8");

    await loadCandidateResultFromFile(filePath, {
      allowedRoots: [dir],
      supportedBenchmarkIds: ["docs_single_file_edit"]
    });

    expect(await readFile(filePath, "utf8")).toBe(contents);
  });
});
