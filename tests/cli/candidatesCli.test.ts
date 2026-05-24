import { describe, expect, it } from "vitest";
import { runCandidatesValidateCli } from "../../src/cli/candidates.js";

const fixtureRoot = "tests/fixtures/candidate-cli";
const validCandidate = `${fixtureRoot}/valid-docs-candidate.json`;
const invalidCandidate = `${fixtureRoot}/invalid-missing-changed-files.json`;
const configCandidate = `${fixtureRoot}/config-candidate.json`;
const malformedCandidate = `${fixtureRoot}/malformed.json`;

describe("candidates validate CLI", () => {
  it("valid candidate file exits 0", async () => {
    const result = await runCandidatesValidateCli(["--candidate", validCandidate, "--benchmark", "docs_single_file_edit"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("VALID");
    expect(result.stdout).toContain("benchmarkId: docs_single_file_edit");
  });

  it("invalid candidate shape exits 1", async () => {
    const result = await runCandidatesValidateCli(["--candidate", invalidCandidate, "--benchmark", "docs_single_file_edit"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("INVALID");
    expect(result.stdout).toContain("candidate_validation_error");
    expect(result.stdout).toContain("$.changedFiles");
  });

  it("malformed JSON exits 2", async () => {
    const result = await runCandidatesValidateCli(["--candidate", malformedCandidate]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("INVALID");
    expect(result.stdout).toContain("json_parse_error");
  });

  it("missing file exits 2", async () => {
    const result = await runCandidatesValidateCli(["--candidate", `${fixtureRoot}/missing.json`]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("INVALID");
    expect(result.stdout).toContain("file_not_found");
  });

  it("--benchmark mismatch exits 1 with useful message", async () => {
    const result = await runCandidatesValidateCli(["--candidate", configCandidate, "--benchmark", "docs_single_file_edit"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("benchmarkId: config_single_file_edit");
    expect(result.stdout).toContain("unsupported_benchmark");
  });

  it("--json emits parseable JSON", async () => {
    const result = await runCandidatesValidateCli(["--candidate", validCandidate, "--benchmark", "docs_single_file_edit", "--json"]);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; source: string; benchmarkId?: string; errors: unknown[] };

    expect(result.exitCode).toBe(0);
    expect(parsed).toEqual({
      ok: true,
      source: "file",
      benchmarkId: "docs_single_file_edit",
      errors: []
    });
  });

  it("--help exits 0", async () => {
    const result = await runCandidatesValidateCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("scintilla candidates validate --candidate <path>");
  });

  it("unknown flag exits 2", async () => {
    const result = await runCandidatesValidateCli(["--candidate", validCandidate, "--bad"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown flag: --bad");
  });

  it("forbidden execution flags exit 2", async () => {
    const result = await runCandidatesValidateCli(["--candidate", validCandidate, "--evaluate"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--evaluate is not supported by this read-only validation command");
  });

  it("does not expose verification, fixture loading, or evaluation behavior", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile("src/cli/candidates.ts", "utf8"));

    expect(source).not.toContain("runBenchmarkFixture");
    expect(source).not.toContain("evaluateBenchmark");
    expect(source).not.toContain("benchmarkFixtures");
  });
});
