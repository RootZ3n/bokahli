import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runBenchmarkFixture, type BenchmarkVerifier } from "../../src/index.js";
import { docsSingleFileEditFixture, type BenchmarkCandidateResult } from "../../src/core/benchmark/fixtures.js";

const passingCandidate: BenchmarkCandidateResult = {
  benchmarkId: "docs_single_file_edit",
  changedFiles: ["README.md"],
  fileContents: {
    "README.md": "# Fixture\n\n## Usage\nRun the tool with the default command.\n\nUse `npm run doctor` to check setup.\n"
  },
  notes: ["Diff evidence: README.md changed to mention npm run doctor."]
};

describe("benchmark fixture runner", () => {
  it("passes docs_single_file_edit candidate through the runner", async () => {
    const result = await runBenchmarkFixture("docs_single_file_edit", passingCandidate);

    expect(result.ok).toBe(true);
    expect(result.benchmarkId).toBe("docs_single_file_edit");
    expect(result.evidence).toEqual(expect.arrayContaining(["loaded fixture tests/fixtures/docs-single-file-edit"]));
  });

  it("fails docs_single_file_edit candidate through the runner", async () => {
    const result = await runBenchmarkFixture("docs_single_file_edit", {
      benchmarkId: "docs_single_file_edit",
      changedFiles: ["README.md"],
      fileContents: {
        "README.md": "# Fixture\n\n## Usage\nRun the tool with the default command.\n"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('README.md must contain "npm run doctor"');
    expect(result.evidence).toEqual(expect.arrayContaining(["loaded fixture files: README.md, package.json"]));
  });

  it("returns structured failure for unknown benchmark id", async () => {
    const result = await runBenchmarkFixture("unknown_benchmark", {
      ...passingCandidate,
      benchmarkId: "unknown_benchmark"
    });

    expect(result.ok).toBe(false);
    expect(result.benchmarkId).toBe("unknown_benchmark");
    expect(result.failedChecks).toContain("unknown benchmark fixture: unknown_benchmark");
    expect(result.evidence[0]).toContain("available executable fixtures:");
  });

  it("returns structured failure when fixture metadata is missing", async () => {
    const result = await runBenchmarkFixture("config_single_file_edit", {
      ...passingCandidate,
      benchmarkId: "config_single_file_edit"
    });

    expect(result.ok).toBe(false);
    expect(result.benchmarkId).toBe("config_single_file_edit");
    expect(result.failedChecks).toContain("fixture metadata is missing for benchmark: config_single_file_edit");
  });

  it("returns structured failure when no verifier exists for fixture metadata", async () => {
    const result = await runBenchmarkFixture("docs_single_file_edit", passingCandidate, {
      fixtures: [{ ...docsSingleFileEditFixture, verifierId: "missingVerifier" }],
      verifiers: {}
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("no verifier exists for benchmark: docs_single_file_edit");
    expect(result.evidence).toContain("missing verifier id: missingVerifier");
  });

  it("loads fixture README and package files before dispatching", async () => {
    const inspectingVerifier: BenchmarkVerifier = (_candidate, fixture) => ({
      ok: true,
      benchmarkId: fixture.metadata.benchmarkId,
      passedChecks: [
        fixture.files["README.md"]?.includes("Run the tool with the default command.") ? "README loaded" : "README missing",
        fixture.files["package.json"]?.includes("docs-single-file-edit-fixture") ? "package loaded" : "package missing"
      ],
      failedChecks: [],
      evidence: Object.keys(fixture.files).sort()
    });

    const result = await runBenchmarkFixture("docs_single_file_edit", passingCandidate, {
      verifiers: {
        docsSingleFileEditVerifier: inspectingVerifier
      }
    });

    expect(result.ok).toBe(true);
    expect(result.passedChecks).toEqual(["README loaded", "package loaded"]);
    expect(result.evidence).toEqual(expect.arrayContaining(["README.md", "package.json", "loaded fixture files: README.md, package.json"]));
  });

  it("does not mutate fixture files", async () => {
    const readmePath = "tests/fixtures/docs-single-file-edit/README.md";
    const packagePath = "tests/fixtures/docs-single-file-edit/package.json";
    const beforeReadme = await readFile(readmePath, "utf8");
    const beforePackage = await readFile(packagePath, "utf8");

    await runBenchmarkFixture("docs_single_file_edit", passingCandidate);

    expect(await readFile(readmePath, "utf8")).toBe(beforeReadme);
    expect(await readFile(packagePath, "utf8")).toBe(beforePackage);
  });

  it("fails when candidate benchmark id does not match the requested verifier", async () => {
    const result = await runBenchmarkFixture("docs_single_file_edit", {
      ...passingCandidate,
      benchmarkId: "config_single_file_edit"
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("benchmark id must be docs_single_file_edit");
  });

  it("exports runner functions from public API", () => {
    expect(runBenchmarkFixture).toBeTypeOf("function");
  });
});
