import { describe, expect, it } from "vitest";
import { runCandidatesEvaluateCli } from "../../src/cli/evaluate.js";

const fixtureRoot = "tests/fixtures/candidate-cli";
const passingDocsCandidate = `${fixtureRoot}/valid-docs-candidate.json`;
const failingDocsCandidate = `${fixtureRoot}/failing-docs-candidate.json`;
const invalidCandidate = `${fixtureRoot}/invalid-missing-changed-files.json`;
const configCandidate = `${fixtureRoot}/config-candidate.json`;
const malformedCandidate = `${fixtureRoot}/malformed.json`;

describe("candidates evaluate CLI", () => {
  it("passing docs_single_file_edit candidate exits 0", async () => {
    const result = await runCandidatesEvaluateCli(["--candidate", passingDocsCandidate, "--benchmark", "docs_single_file_edit"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("PASS");
    expect(result.stdout).toContain("benchmarkId: docs_single_file_edit");
  });

  it("valid but failing candidate exits 1", async () => {
    const result = await runCandidatesEvaluateCli(["--candidate", failingDocsCandidate, "--benchmark", "docs_single_file_edit"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("FAIL");
    expect(result.stdout).toContain("stage: verify");
    expect(result.stdout).toContain("README.md must contain");
  });

  it("malformed JSON exits 2", async () => {
    const result = await runCandidatesEvaluateCli(["--candidate", malformedCandidate, "--benchmark", "docs_single_file_edit"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("FAIL");
    expect(result.stdout).toContain("stage: load");
    expect(result.stdout).toContain("json_parse_error");
  });

  it("invalid candidate shape exits 2", async () => {
    const result = await runCandidatesEvaluateCli(["--candidate", invalidCandidate, "--benchmark", "docs_single_file_edit"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("FAIL");
    expect(result.stdout).toContain("stage: validate");
    expect(result.stdout).toContain("candidate_validation_error");
  });

  it("unknown benchmark exits 2", async () => {
    const result = await runCandidatesEvaluateCli(["--candidate", passingDocsCandidate, "--benchmark", "unknown_benchmark"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("FAIL");
    expect(result.stdout).toContain("unknown_benchmark");
  });

  it("benchmark mismatch exits 2", async () => {
    const result = await runCandidatesEvaluateCli(["--candidate", configCandidate, "--benchmark", "docs_single_file_edit"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("FAIL");
    expect(result.stdout).toContain("candidate benchmarkId does not match requested benchmarkId");
  });

  it("--json emits parseable JSON for pass", async () => {
    const result = await runCandidatesEvaluateCli(["--candidate", passingDocsCandidate, "--benchmark", "docs_single_file_edit", "--json"]);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; benchmarkId: string; verification?: { ok: boolean } };

    expect(result.exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.benchmarkId).toBe("docs_single_file_edit");
    expect(parsed.verification?.ok).toBe(true);
  });

  it("--json emits parseable JSON for verification failure", async () => {
    const result = await runCandidatesEvaluateCli(["--candidate", failingDocsCandidate, "--benchmark", "docs_single_file_edit", "--json"]);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; stage: string; verification?: { ok: boolean; failedChecks: string[] } };

    expect(result.exitCode).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.stage).toBe("verify");
    expect(parsed.verification?.ok).toBe(false);
    expect(parsed.verification?.failedChecks).toEqual(expect.arrayContaining(['README.md must contain "npm run doctor"']));
  });

  it("--help exits 0", async () => {
    const result = await runCandidatesEvaluateCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("scintilla candidates evaluate --candidate <path>");
  });

  it("unknown flag exits 2", async () => {
    const result = await runCandidatesEvaluateCli(["--candidate", passingDocsCandidate, "--benchmark", "docs_single_file_edit", "--bad"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown flag: --bad");
  });

  it("forbidden model or execution flags exit 2", async () => {
    const modelResult = await runCandidatesEvaluateCli(["--candidate", passingDocsCandidate, "--benchmark", "docs_single_file_edit", "--model"]);
    const runResult = await runCandidatesEvaluateCli(["--candidate", passingDocsCandidate, "--benchmark", "docs_single_file_edit", "--run"]);

    expect(modelResult.exitCode).toBe(2);
    expect(modelResult.stderr).toContain("--model is not supported by this deterministic evaluation command");
    expect(runResult.exitCode).toBe(2);
    expect(runResult.stderr).toContain("--run is not supported by this deterministic evaluation command");
  });

  it("does not expose model, shell, network, or orchestration behavior", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile("src/cli/evaluate.ts", "utf8"));

    expect(source).not.toContain("child_process");
    expect(source).not.toMatch(/\bexec\b|\bspawn\b|fetch\(|http:\/\/|https:\/\//i);
    expect(source).not.toMatch(/create.*model|ollama client|model client/i);
  });
});
