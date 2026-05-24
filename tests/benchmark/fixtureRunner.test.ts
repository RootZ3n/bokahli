import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runBenchmarkFixture, type BenchmarkVerifier } from "../../src/index.js";
import { configSingleFileEditFixture, docsSingleFileEditFixture, type BenchmarkCandidateResult } from "../../src/core/benchmark/fixtures.js";

const passingCandidate: BenchmarkCandidateResult = {
  benchmarkId: "docs_single_file_edit",
  changedFiles: ["README.md"],
  fileContents: {
    "README.md": "# Fixture\n\n## Usage\nRun the tool with the default command.\n\nUse `npm run doctor` to check setup.\n"
  },
  notes: ["Diff evidence: README.md changed to mention npm run doctor."]
};

const passingConfigCandidate: BenchmarkCandidateResult = {
  benchmarkId: "config_single_file_edit",
  changedFiles: ["scintilla.config.json"],
  fileContents: {
    "scintilla.config.json": JSON.stringify(
      {
        auditEverySteps: 3,
        allowMultiFileWorkerTasks: false,
        defaultModelTier: "tier_1"
      },
      null,
      2
    )
  },
  notes: ["Diff evidence: scintilla.config.json changed auditEverySteps."]
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

  it("passes config_single_file_edit candidate through the runner", async () => {
    const result = await runBenchmarkFixture("config_single_file_edit", passingConfigCandidate);

    expect(result.ok).toBe(true);
    expect(result.benchmarkId).toBe("config_single_file_edit");
    expect(result.evidence).toEqual(expect.arrayContaining(["loaded fixture tests/fixtures/config-single-file-edit", "auditEverySteps === 3"]));
  });

  it("returns structured failure when fixture metadata is missing", async () => {
    const result = await runBenchmarkFixture("config_single_file_edit", passingConfigCandidate, {
      fixtures: [docsSingleFileEditFixture]
    });

    expect(result.ok).toBe(false);
    expect(result.benchmarkId).toBe("config_single_file_edit");
    expect(result.failedChecks).toContain("fixture metadata is missing for benchmark: config_single_file_edit");
  });

  it("returns structured failure when no verifier exists for fixture metadata", async () => {
    const result = await runBenchmarkFixture("config_single_file_edit", passingConfigCandidate, {
      fixtures: [{ ...configSingleFileEditFixture, verifierId: "missingVerifier" }],
      verifiers: {}
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("no verifier exists for benchmark: config_single_file_edit");
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
    expect(result.failedChecks).toContain("candidate_validation");
    expect(result.failedChecks).toContain("candidate benchmarkId does not match requested benchmarkId: docs_single_file_edit");
    expect(result.evidence).toEqual(expect.arrayContaining(["candidate benchmarkId: config_single_file_edit", "requested benchmarkId: docs_single_file_edit"]));
  });

  it("returns malformed candidate failures before verifier dispatch", async () => {
    let verifierCalled = false;
    const result = await runBenchmarkFixture(
      "docs_single_file_edit",
      {
        benchmarkId: "docs_single_file_edit",
        changedFiles: "README.md",
        fileContents: {
          "README.md": "Use `npm run doctor`."
        }
      },
      {
        verifiers: {
          docsSingleFileEditVerifier: () => {
            verifierCalled = true;
            return {
              ok: true,
              benchmarkId: "docs_single_file_edit",
              passedChecks: [],
              failedChecks: [],
              evidence: []
            };
          }
        }
      }
    );

    expect(result.ok).toBe(false);
    expect(verifierCalled).toBe(false);
    expect(result.failedChecks).toContain("candidate_validation");
  });

  it("includes useful failedChecks and evidence for malformed candidates", async () => {
    const result = await runBenchmarkFixture("docs_single_file_edit", {
      benchmarkId: "docs_single_file_edit",
      changedFiles: ["/README.md"],
      fileContents: {}
    });

    expect(result.ok).toBe(false);
    expect(result.failedChecks).toEqual(expect.arrayContaining(["candidate_validation", "absolute_path: $.changedFiles[0]"]));
    expect(result.evidence).toEqual(expect.arrayContaining(["path must not be absolute", "fileContents must include changed file content for /README.md"]));
  });

  it("valid candidates still reach docs_single_file_edit verifier and pass", async () => {
    const result = await runBenchmarkFixture("docs_single_file_edit", passingCandidate);

    expect(result.ok).toBe(true);
    expect(result.passedChecks).toContain('README.md mentions "npm run doctor"');
  });

  it("exports runner functions from public API", () => {
    expect(runBenchmarkFixture).toBeTypeOf("function");
  });
});
