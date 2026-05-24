import { describe, expect, it } from "vitest";
import { validateBenchmarkCandidateResult } from "../../src/index.js";

const validCandidate = {
  benchmarkId: "docs_single_file_edit",
  changedFiles: ["README.md"],
  fileContents: {
    "README.md": "# Fixture\n\n## Usage\nRun `npm run doctor`.\n"
  },
  notes: ["Diff evidence: README.md changed."]
};

describe("benchmark candidate validation", () => {
  it("passes a valid docs_single_file_edit candidate", () => {
    const result = validateBenchmarkCandidateResult(validCandidate, {
      supportedBenchmarkIds: ["docs_single_file_edit"]
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate).toEqual(validCandidate);
    }
  });

  it("fails when benchmarkId is missing", () => {
    const { benchmarkId: _benchmarkId, ...candidate } = validCandidate;
    const result = validateBenchmarkCandidateResult(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: "$.benchmarkId", code: "required_string" })]));
    }
  });

  it("fails when benchmarkId is unsupported", () => {
    const result = validateBenchmarkCandidateResult(
      { ...validCandidate, benchmarkId: "unknown_benchmark" },
      { supportedBenchmarkIds: ["docs_single_file_edit"] }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "unsupported_benchmark" })]));
    }
  });

  it("fails when changedFiles is missing", () => {
    const { changedFiles: _changedFiles, ...candidate } = validCandidate;
    const result = validateBenchmarkCandidateResult(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: "$.changedFiles" })]));
    }
  });

  it("fails when changedFiles is not an array", () => {
    const result = validateBenchmarkCandidateResult({ ...validCandidate, changedFiles: "README.md" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "required_string_array" })]));
    }
  });

  it("fails when changedFiles contains an absolute path", () => {
    const result = validateBenchmarkCandidateResult({
      ...validCandidate,
      changedFiles: ["/tmp/README.md"],
      fileContents: {
        "/tmp/README.md": "bad"
      }
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "absolute_path" })]));
    }
  });

  it("fails when changedFiles contains path traversal", () => {
    const result = validateBenchmarkCandidateResult({
      ...validCandidate,
      changedFiles: ["../README.md"],
      fileContents: {
        "../README.md": "bad"
      }
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "path_traversal" })]));
    }
  });

  it("fails when changedFiles contains duplicate entries", () => {
    const result = validateBenchmarkCandidateResult({
      ...validCandidate,
      changedFiles: ["README.md", "README.md"]
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "duplicate_path" })]));
    }
  });

  it("fails when fileContents is missing", () => {
    const { fileContents: _fileContents, ...candidate } = validCandidate;
    const result = validateBenchmarkCandidateResult(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: "$.fileContents" })]));
    }
  });

  it("fails when fileContents is not a plain object", () => {
    const result = validateBenchmarkCandidateResult({ ...validCandidate, fileContents: ["README.md"] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "required_file_contents" })]));
    }
  });

  it("fails when fileContents contains path traversal", () => {
    const result = validateBenchmarkCandidateResult({
      ...validCandidate,
      changedFiles: ["README.md"],
      fileContents: {
        "README.md": "ok",
        "../secret": "bad"
      }
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "path_traversal" })]));
    }
  });

  it("fails when a changed file is missing from fileContents", () => {
    const result = validateBenchmarkCandidateResult({
      ...validCandidate,
      changedFiles: ["README.md", "docs/usage.md"],
      fileContents: {
        "README.md": "ok"
      }
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing_changed_file_content" })]));
    }
  });

  it("fails when notes is not a string array", () => {
    const result = validateBenchmarkCandidateResult({ ...validCandidate, notes: ["ok", 1] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_notes" })]));
    }
  });

  it("ignores unsupported extra fields", () => {
    const result = validateBenchmarkCandidateResult(
      {
        ...validCandidate,
        unsupported: "ignored",
        claims: ["This is not verification evidence."]
      },
      { supportedBenchmarkIds: ["docs_single_file_edit"] }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("unsupported" in result.candidate).toBe(false);
      expect("claims" in result.candidate).toBe(false);
    }
  });

  it("does not mutate input objects", () => {
    const candidate = {
      ...validCandidate,
      extra: {
        preserved: true
      }
    };
    const before = JSON.stringify(candidate);

    validateBenchmarkCandidateResult(candidate, {
      supportedBenchmarkIds: ["docs_single_file_edit"]
    });

    expect(JSON.stringify(candidate)).toBe(before);
  });
});
