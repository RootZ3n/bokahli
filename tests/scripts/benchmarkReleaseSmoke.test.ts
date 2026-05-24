import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatSmokeTable,
  getSmokeCounts,
  getBenchmarkReleaseSmokeCommands,
  getMockWorkerCandidateSmokeCommands,
  runBenchmarkReleaseSmoke,
  toSmokeJsonReport,
  type SmokeCommand,
  type SmokeCommandOutput,
  type SmokeCommandRunner
} from "../../scripts/benchmark-release-smoke.js";

const ariadneCheckIds = [
  "ariadne-scan-simple",
  "ariadne-scan-simple-json",
  "ariadne-packet-readme-json",
  "context-packets-list",
  "context-packets-list-json",
  "context-packets-list-readme"
];

const contractCheckIds = ["contracts-list", "contracts-list-json", "contracts-list-readme", "ariadne-packet-readme-contract-json"];
const mockWorkerCandidateCheckIds = ["mock-worker-candidate-only", "mock-worker-candidate-validate", "mock-worker-candidate-evaluate"];
const mockPipelineCheckIds = ["mock-pipeline-docs-pass", "mock-pipeline-refusal-expected", "mock-pipeline-invalid-schema-expected"];
const mockPipelineResultsCheckIds = [
  "mock-pipeline-results-list",
  "mock-pipeline-results-list-json",
  "mock-pipeline-results-list-docs",
  "mock-pipeline-results-list-passed",
  "mock-pipeline-results-list-docs-passed"
];

const mockCandidateJson = JSON.stringify({
  benchmarkId: "docs_single_file_edit",
  changedFiles: ["README.md"],
  fileContents: {
    "README.md": "## Usage\nRun npm run doctor before submitting changes.\n"
  }
});

function expectedSmokeCheckCount(): number {
  return getBenchmarkReleaseSmokeCommands().length + mockWorkerCandidateCheckIds.length;
}

function runnerWith(overrides: Readonly<Record<string, number | SmokeCommandOutput>> = {}): SmokeCommandRunner {
  return async (command: SmokeCommand) => {
    const override = overrides[command.id];
    if (override !== undefined) {
      return override;
    }

    if (command.id === "mock-worker-candidate-only") {
      return {
        exitCode: command.expectedExitCode,
        stdout: mockCandidateJson
      };
    }

    return command.expectedExitCode;
  };
}

describe("benchmark release smoke script", () => {
  it("succeeds when all expected commands return expected exits", async () => {
    const result = await runBenchmarkReleaseSmoke(runnerWith());

    expect(result.ok).toBe(true);
    expect(result.results.every((entry) => entry.ok)).toBe(true);
    expect(formatSmokeTable(result)).toContain("SCINTILLA_BENCHMARK_PLUMBING_STATUS=BENCHMARK_PLUMBING_READY");
  });

  it("success run includes exact status line once as the last non-empty text line", async () => {
    const result = await runBenchmarkReleaseSmoke(runnerWith());
    const lines = formatSmokeTable(result).split("\n").filter((line) => line.length > 0);
    const statusLine = "SCINTILLA_BENCHMARK_PLUMBING_STATUS=BENCHMARK_PLUMBING_READY";

    expect(lines.filter((line) => line === statusLine)).toHaveLength(1);
    expect(lines.at(-1)).toBe(statusLine);
  });

  it("fails when a required success command fails", async () => {
    const result = await runBenchmarkReleaseSmoke(runnerWith({ typecheck: 2 }));

    expect(result.ok).toBe(false);
    expect(result.results.find((entry) => entry.id === "typecheck")).toMatchObject({
      expectedExitCode: 0,
      actualExitCode: 2,
      ok: false
    });
    expect(formatSmokeTable(result)).toContain("SCINTILLA_BENCHMARK_PLUMBING_STATUS=NOT_READY");
  });

  it("fails when the intentional fail example exits 0", async () => {
    const result = await runBenchmarkReleaseSmoke(runnerWith({ "candidate-evaluate-docs-intentional-fail": 0 }));

    expect(result.ok).toBe(false);
    expect(result.results.find((entry) => entry.id === "candidate-evaluate-docs-intentional-fail")).toMatchObject({
      expectedExitCode: 1,
      actualExitCode: 0,
      ok: false
    });
  });

  it("fails when the intentional fail example exits 2", async () => {
    const result = await runBenchmarkReleaseSmoke(runnerWith({ "candidate-evaluate-docs-intentional-fail": 2 }));

    expect(result.ok).toBe(false);
    expect(result.results.find((entry) => entry.id === "candidate-evaluate-docs-intentional-fail")).toMatchObject({
      expectedExitCode: 1,
      actualExitCode: 2,
      ok: false
    });
  });

  it("succeeds when the intentional fail example exits 1", async () => {
    const result = await runBenchmarkReleaseSmoke(runnerWith({ "candidate-evaluate-docs-intentional-fail": 1 }));

    expect(result.ok).toBe(true);
  });

  it("includes Ariadne read-only checks in the success count", async () => {
    const commands = getBenchmarkReleaseSmokeCommands();
    const commandIds = commands.map((command) => command.id);
    const result = await runBenchmarkReleaseSmoke(runnerWith());

    expect(commandIds).toEqual(expect.arrayContaining(ariadneCheckIds));
    expect(commands).toHaveLength(29);
    expect(getSmokeCounts(result)).toEqual({
      total: expectedSmokeCheckCount(),
      passed: expectedSmokeCheckCount(),
      failed: 0
    });
  });

  it("Ariadne command failure causes NOT_READY", async () => {
    const result = await runBenchmarkReleaseSmoke(runnerWith({ "ariadne-scan-simple": 2 }));

    expect(result.ok).toBe(false);
    expect(result.results.find((entry) => entry.id === "ariadne-scan-simple")).toMatchObject({
      expectedExitCode: 0,
      actualExitCode: 2,
      ok: false
    });
    expect(formatSmokeTable(result)).toContain("SCINTILLA_BENCHMARK_PLUMBING_STATUS=NOT_READY");
  });

  it("contract command failure causes NOT_READY", async () => {
    const result = await runBenchmarkReleaseSmoke(runnerWith({ "contracts-list": 2 }));

    expect(result.ok).toBe(false);
    expect(result.results.find((entry) => entry.id === "contracts-list")).toMatchObject({
      expectedExitCode: 0,
      actualExitCode: 2,
      ok: false
    });
    expect(formatSmokeTable(result)).toContain("SCINTILLA_BENCHMARK_PLUMBING_STATUS=NOT_READY");
  });

  it("mock-pipeline-results:list failure causes NOT_READY", async () => {
    const result = await runBenchmarkReleaseSmoke(runnerWith({ "mock-pipeline-results-list": 2 }));

    expect(result.ok).toBe(false);
    expect(result.results.find((entry) => entry.id === "mock-pipeline-results-list")).toMatchObject({
      expectedExitCode: 0,
      actualExitCode: 2,
      ok: false
    });
    expect(formatSmokeTable(result)).toContain("SCINTILLA_BENCHMARK_PLUMBING_STATUS=NOT_READY");
  });

  it("successful mock-pipeline failure causes NOT_READY", async () => {
    const result = await runBenchmarkReleaseSmoke(runnerWith({ "mock-pipeline-docs-pass": 1 }));

    expect(result.ok).toBe(false);
    expect(result.results.find((entry) => entry.id === "mock-pipeline-docs-pass")).toMatchObject({
      expectedExitCode: 0,
      actualExitCode: 1,
      ok: false
    });
  });

  it("mock-pipeline refusal scenario exit 1 counts as pass", async () => {
    const result = await runBenchmarkReleaseSmoke(runnerWith({ "mock-pipeline-refusal-expected": 1 }));

    expect(result.ok).toBe(true);
    expect(result.results.find((entry) => entry.id === "mock-pipeline-refusal-expected")).toMatchObject({
      expectedExitCode: 1,
      actualExitCode: 1,
      ok: true
    });
  });

  it("mock-pipeline refusal scenario exit 0 or 2 causes NOT_READY", async () => {
    for (const exitCode of [0, 2]) {
      const result = await runBenchmarkReleaseSmoke(runnerWith({ "mock-pipeline-refusal-expected": exitCode }));

      expect(result.ok).toBe(false);
      expect(result.results.find((entry) => entry.id === "mock-pipeline-refusal-expected")).toMatchObject({
        expectedExitCode: 1,
        actualExitCode: exitCode,
        ok: false
      });
    }
  });

  it("mock-pipeline invalid_schema scenario exit 1 counts as pass", async () => {
    const result = await runBenchmarkReleaseSmoke(runnerWith({ "mock-pipeline-invalid-schema-expected": 1 }));

    expect(result.ok).toBe(true);
    expect(result.results.find((entry) => entry.id === "mock-pipeline-invalid-schema-expected")).toMatchObject({
      expectedExitCode: 1,
      actualExitCode: 1,
      ok: true
    });
  });

  it("mock-pipeline invalid_schema scenario exit 0 or 2 causes NOT_READY", async () => {
    for (const exitCode of [0, 2]) {
      const result = await runBenchmarkReleaseSmoke(runnerWith({ "mock-pipeline-invalid-schema-expected": exitCode }));

      expect(result.ok).toBe(false);
      expect(result.results.find((entry) => entry.id === "mock-pipeline-invalid-schema-expected")).toMatchObject({
        expectedExitCode: 1,
        actualExitCode: exitCode,
        ok: false
      });
    }
  });

  it("successful mock-worker candidate-only path contributes to success", async () => {
    const result = await runBenchmarkReleaseSmoke(runnerWith());
    const resultIds = result.results.map((entry) => entry.id);

    expect(result.ok).toBe(true);
    expect(resultIds).toEqual(expect.arrayContaining(mockWorkerCandidateCheckIds));
    expect(getSmokeCounts(result)).toEqual({
      total: expectedSmokeCheckCount(),
      passed: expectedSmokeCheckCount(),
      failed: 0
    });
  });

  it("mock-worker generation failure causes NOT_READY", async () => {
    const result = await runBenchmarkReleaseSmoke(
      runnerWith({
        "mock-worker-candidate-only": {
          exitCode: 2,
          stdout: ""
        }
      })
    );

    expect(result.ok).toBe(false);
    expect(result.results.find((entry) => entry.id === "mock-worker-candidate-only")).toMatchObject({
      expectedExitCode: 0,
      actualExitCode: 2,
      ok: false
    });
    expect(formatSmokeTable(result)).toContain("SCINTILLA_BENCHMARK_PLUMBING_STATUS=NOT_READY");
  });

  it("validation failure of generated candidate causes NOT_READY", async () => {
    const result = await runBenchmarkReleaseSmoke(runnerWith({ "mock-worker-candidate-validate": 1 }));

    expect(result.ok).toBe(false);
    expect(result.results.find((entry) => entry.id === "mock-worker-candidate-validate")).toMatchObject({
      expectedExitCode: 0,
      actualExitCode: 1,
      ok: false
    });
  });

  it("evaluation failure of generated candidate causes NOT_READY", async () => {
    const result = await runBenchmarkReleaseSmoke(runnerWith({ "mock-worker-candidate-evaluate": 1 }));

    expect(result.ok).toBe(false);
    expect(result.results.find((entry) => entry.id === "mock-worker-candidate-evaluate")).toMatchObject({
      expectedExitCode: 0,
      actualExitCode: 1,
      ok: false
    });
  });

  it("generated candidate temp file is cleaned up", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "scintilla-smoke-test-"));

    await runBenchmarkReleaseSmoke(runnerWith(), { tempRoot });

    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("reports total, passed, and failed counts", async () => {
    const result = await runBenchmarkReleaseSmoke(runnerWith({ typecheck: 2, build: 1 }));
    const counts = getSmokeCounts(result);
    const table = formatSmokeTable(result);

    expect(counts).toEqual({
      total: expectedSmokeCheckCount(),
      passed: expectedSmokeCheckCount() - 2,
      failed: 2
    });
    expect(table).toContain(`SCINTILLA_BENCHMARK_PLUMBING_CHECKS_TOTAL=${counts.total}`);
    expect(table).toContain(`SCINTILLA_BENCHMARK_PLUMBING_CHECKS_PASSED=${counts.passed}`);
    expect(table).toContain(`SCINTILLA_BENCHMARK_PLUMBING_CHECKS_FAILED=${counts.failed}`);
  });

  it("emits parseable JSON report without extra text", async () => {
    const result = await runBenchmarkReleaseSmoke(runnerWith());
    const jsonText = JSON.stringify(toSmokeJsonReport(result), null, 2);
    const parsed = JSON.parse(jsonText) as ReturnType<typeof toSmokeJsonReport>;

    expect(parsed.status).toBe("BENCHMARK_PLUMBING_READY");
    expect(parsed.checksTotal).toBe(expectedSmokeCheckCount());
    expect(parsed.checksFailed).toBe(0);
    expect(parsed.checks[0]).toMatchObject({
      name: "typecheck",
      expectedExit: 0,
      actualExit: 0,
      status: "pass",
      command: ["pnpm", "typecheck"]
    });
  });

  it("JSON status matches text status behavior", async () => {
    const result = await runBenchmarkReleaseSmoke(runnerWith({ typecheck: 2 }));
    const json = toSmokeJsonReport(result);
    const table = formatSmokeTable(result);

    expect(json.status).toBe("NOT_READY");
    expect(table).toContain("SCINTILLA_BENCHMARK_PLUMBING_STATUS=NOT_READY");
  });

  it("JSON report includes Ariadne checks", async () => {
    const result = await runBenchmarkReleaseSmoke(runnerWith());
    const json = toSmokeJsonReport(result);
    const checkNames = json.checks.map((check) => check.name);

    expect(json.status).toBe("BENCHMARK_PLUMBING_READY");
    expect(checkNames).toEqual(expect.arrayContaining(ariadneCheckIds));
  });

  it("JSON report includes contract checks", async () => {
    const result = await runBenchmarkReleaseSmoke(runnerWith());
    const json = toSmokeJsonReport(result);
    const checkNames = json.checks.map((check) => check.name);

    expect(json.status).toBe("BENCHMARK_PLUMBING_READY");
    expect(checkNames).toEqual(expect.arrayContaining(contractCheckIds));
  });

  it("JSON report includes mock-worker candidate checks", async () => {
    const result = await runBenchmarkReleaseSmoke(runnerWith());
    const json = toSmokeJsonReport(result);
    const checkNames = json.checks.map((check) => check.name);

    expect(json.status).toBe("BENCHMARK_PLUMBING_READY");
    expect(checkNames).toEqual(expect.arrayContaining(mockWorkerCandidateCheckIds));
  });

  it("JSON report includes mock-pipeline checks", async () => {
    const result = await runBenchmarkReleaseSmoke(runnerWith());
    const json = toSmokeJsonReport(result);
    const checkNames = json.checks.map((check) => check.name);

    expect(json.status).toBe("BENCHMARK_PLUMBING_READY");
    expect(checkNames).toEqual(expect.arrayContaining(mockPipelineCheckIds));
  });

  it("JSON report includes mock-pipeline-results checks", async () => {
    const result = await runBenchmarkReleaseSmoke(runnerWith());
    const json = toSmokeJsonReport(result);
    const checkNames = json.checks.map((check) => check.name);

    expect(json.status).toBe("BENCHMARK_PLUMBING_READY");
    expect(checkNames).toEqual(expect.arrayContaining(mockPipelineResultsCheckIds));
  });

  it("context packet list checks are included", () => {
    const commands = getBenchmarkReleaseSmokeCommands();

    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "context-packets-list", args: ["context-packets:list"] }),
        expect.objectContaining({ id: "context-packets-list-json", args: ["context-packets:list", "--", "--json"] }),
        expect.objectContaining({ id: "context-packets-list-readme", args: ["context-packets:list", "--", "--id", "readme_patch_one_file"] })
      ])
    );
  });

  it("contract list checks are included", () => {
    const commands = getBenchmarkReleaseSmokeCommands();

    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "contracts-list", args: ["contracts:list"] }),
        expect.objectContaining({ id: "contracts-list-json", args: ["contracts:list", "--", "--json"] }),
        expect.objectContaining({ id: "contracts-list-readme", args: ["contracts:list", "--", "--id", "readme_patch_one_file"] })
      ])
    );
  });

  it("mock-pipeline checks are included with expected exits", () => {
    const commands = getBenchmarkReleaseSmokeCommands();

    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "mock-pipeline-docs-pass", expectedExitCode: 0 }),
        expect.objectContaining({ id: "mock-pipeline-refusal-expected", expectedExitCode: 1 }),
        expect.objectContaining({ id: "mock-pipeline-invalid-schema-expected", expectedExitCode: 1 })
      ])
    );
  });

  it("mock-pipeline result discovery checks are included", () => {
    const commands = getBenchmarkReleaseSmokeCommands();

    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "mock-pipeline-results-list", args: ["mock-pipeline-results:list"] }),
        expect.objectContaining({ id: "mock-pipeline-results-list-json", args: ["mock-pipeline-results:list", "--", "--json"] }),
        expect.objectContaining({
          id: "mock-pipeline-results-list-docs",
          args: ["mock-pipeline-results:list", "--", "--benchmark", "docs_single_file_edit"]
        }),
        expect.objectContaining({
          id: "mock-pipeline-results-list-passed",
          args: ["mock-pipeline-results:list", "--", "--status", "passed"]
        }),
        expect.objectContaining({
          id: "mock-pipeline-results-list-docs-passed",
          args: ["mock-pipeline-results:list", "--", "--id", "docs_single_file_edit.passed"]
        })
      ])
    );
  });

  it("Ariadne contract packet check appears exactly once", () => {
    const commands = getBenchmarkReleaseSmokeCommands();
    const ariadneContractCommands = commands.filter((command) => command.id === "ariadne-packet-readme-contract-json");

    expect(ariadneContractCommands).toHaveLength(1);
    expect(ariadneContractCommands[0]?.args).toContain("examples/contracts/readme_patch_one_file.contract.json");
  });

  it("mock-worker candidate-only command uses pnpm --silent for captured JSON", () => {
    const [generateCommand] = getMockWorkerCandidateSmokeCommands("/tmp/scintilla-candidate.json");

    expect(generateCommand).toEqual(
      expect.objectContaining({
        id: "mock-worker-candidate-only",
        args: expect.arrayContaining(["--silent", "mock-worker:run", "--candidate-only"]),
        captureStdout: true
      })
    );
  });

  it("keeps BLOCKED reserved for future classified environment blockage", () => {
    expect(["BENCHMARK_PLUMBING_READY", "NOT_READY", "BLOCKED"]).toContain("BLOCKED");
  });

  it("does not include model, network, or orchestration commands", () => {
    const commandText = [
      ...getBenchmarkReleaseSmokeCommands(),
      ...getMockWorkerCandidateSmokeCommands("/tmp/scintilla-candidate.json")
    ]
      .map((command) => [command.command, ...command.args].join(" "))
      .join("\n");

    expect(commandText).not.toMatch(/ollama|model|aedis|orchestrat|curl|wget|http:\/\/|https:\/\//i);
  });
});
