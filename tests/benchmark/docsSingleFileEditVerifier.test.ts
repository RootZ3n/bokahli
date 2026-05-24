import { describe, expect, it } from "vitest";
import { verifyDocsSingleFileEdit } from "../../src/core/benchmark/docsSingleFileEditVerifier.js";
import { benchmarkFixtures, docsSingleFileEditFixture, type BenchmarkCandidateResult } from "../../src/core/benchmark/fixtures.js";
import { getBenchmarkById } from "../../src/core/benchmark/registry.js";

const passingCandidate: BenchmarkCandidateResult = {
  benchmarkId: "docs_single_file_edit",
  changedFiles: ["README.md"],
  fileContents: {
    "README.md": "# Fixture\n\n## Usage\nRun the tool with the default command.\n\nUse `npm run doctor` to check the setup.\n"
  },
  notes: ["Diff evidence: README.md changed to mention npm run doctor."]
};

describe("docs single-file edit verifier", () => {
  it("passes a scoped README candidate that mentions npm run doctor", () => {
    const result = verifyDocsSingleFileEdit(passingCandidate);

    expect(result.ok).toBe(true);
    expect(result.failedChecks).toEqual([]);
    expect(result.evidence).toEqual(expect.arrayContaining(['README.md contains "npm run doctor"']));
  });

  it("fails a package.json-only candidate", () => {
    const result = verifyDocsSingleFileEdit({
      benchmarkId: "docs_single_file_edit",
      changedFiles: ["package.json"],
      fileContents: {
        "package.json": JSON.stringify({ scripts: { doctor: "node doctor.js" } }, null, 2)
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toEqual(expect.arrayContaining(["changedFiles must include README.md", "fileContents must include README.md"]));
    expect(result.failedChecks).toContain("changedFiles must not include package.json");
  });

  it("fails a README candidate without npm run doctor", () => {
    const result = verifyDocsSingleFileEdit({
      benchmarkId: "docs_single_file_edit",
      changedFiles: ["README.md"],
      fileContents: {
        "README.md": "# Fixture\n\n## Usage\nRun the tool with the default command.\n"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('README.md must contain "npm run doctor"');
  });

  it("fails a candidate that adds an unrelated file", () => {
    const result = verifyDocsSingleFileEdit({
      benchmarkId: "docs_single_file_edit",
      changedFiles: ["README.md", "NOTES.md"],
      fileContents: {
        "README.md": "# Fixture\n\n## Usage\nRun `npm run doctor`.\n",
        "NOTES.md": "Unrelated notes.\n"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks.some((check) => check.includes("outside fixture allowlist"))).toBe(true);
  });

  it("fails a candidate with the wrong benchmark id", () => {
    const result = verifyDocsSingleFileEdit({
      ...passingCandidate,
      benchmarkId: "config_single_file_edit"
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("benchmark id must be docs_single_file_edit");
  });

  it("returns useful evidence and failed checks", () => {
    const result = verifyDocsSingleFileEdit({
      benchmarkId: "docs_single_file_edit",
      changedFiles: ["README.md"],
      fileContents: {
        "README.md": "# Fixture\n\n## Usage\nRun the tool.\n"
      },
      notes: ["Completed successfully."]
    });

    expect(result.ok).toBe(false);
    expect(result.evidence).toEqual(expect.arrayContaining(["changedFiles includes README.md", "fileContents includes README.md"]));
    expect(result.failedChecks).toEqual(
      expect.arrayContaining(['README.md must contain "npm run doctor"', "candidate notes claim success without diff evidence"])
    );
  });

  it("links the registry entry to executable fixture metadata", () => {
    const registryEntry = getBenchmarkById("docs_single_file_edit");

    expect(registryEntry.id).toBe(docsSingleFileEditFixture.benchmarkId);
    expect(benchmarkFixtures).toContainEqual(docsSingleFileEditFixture);
    expect(docsSingleFileEditFixture.fixturePath).toBe("tests/fixtures/docs-single-file-edit");
    expect(docsSingleFileEditFixture.verifierId).toBe("docsSingleFileEditVerifier");
  });
});
