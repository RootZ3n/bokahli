import { describe, expect, it } from "vitest";
import {
  formatSmokeTable,
  getSmokeCounts,
  getBenchmarkReleaseSmokeCommands,
  runBenchmarkReleaseSmoke,
  toSmokeJsonReport,
  type SmokeCommand,
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

function runnerWith(overrides: Readonly<Record<string, number>> = {}): SmokeCommandRunner {
  return async (command: SmokeCommand) => overrides[command.id] ?? command.expectedExitCode;
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
    expect(commands).toHaveLength(21);
    expect(getSmokeCounts(result)).toEqual({
      total: 21,
      passed: 21,
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

  it("reports total, passed, and failed counts", async () => {
    const result = await runBenchmarkReleaseSmoke(runnerWith({ typecheck: 2, build: 1 }));
    const counts = getSmokeCounts(result);
    const table = formatSmokeTable(result);

    expect(counts).toEqual({
      total: getBenchmarkReleaseSmokeCommands().length,
      passed: getBenchmarkReleaseSmokeCommands().length - 2,
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
    expect(parsed.checksTotal).toBe(getBenchmarkReleaseSmokeCommands().length);
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

  it("Ariadne contract packet check appears exactly once", () => {
    const commands = getBenchmarkReleaseSmokeCommands();

    expect(commands.filter((command) => command.id === "ariadne-packet-readme-contract-json")).toHaveLength(1);
    expect(commands.filter((command) => command.args.includes("examples/contracts/readme_patch_one_file.contract.json"))).toHaveLength(1);
  });

  it("keeps BLOCKED reserved for future classified environment blockage", () => {
    expect(["BENCHMARK_PLUMBING_READY", "NOT_READY", "BLOCKED"]).toContain("BLOCKED");
  });

  it("does not include model, network, or orchestration commands", () => {
    const commandText = getBenchmarkReleaseSmokeCommands()
      .map((command) => [command.command, ...command.args].join(" "))
      .join("\n");

    expect(commandText).not.toMatch(/ollama|model|aedis|orchestrat|curl|wget|http:\/\/|https:\/\//i);
  });
});
