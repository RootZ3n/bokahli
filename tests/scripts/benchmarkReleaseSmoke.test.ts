import { describe, expect, it } from "vitest";
import {
  formatSmokeTable,
  getBenchmarkReleaseSmokeCommands,
  runBenchmarkReleaseSmoke,
  type SmokeCommand,
  type SmokeCommandRunner
} from "../../scripts/benchmark-release-smoke.js";

function runnerWith(overrides: Readonly<Record<string, number>> = {}): SmokeCommandRunner {
  return async (command: SmokeCommand) => overrides[command.id] ?? command.expectedExitCode;
}

describe("benchmark release smoke script", () => {
  it("succeeds when all expected commands return expected exits", async () => {
    const result = await runBenchmarkReleaseSmoke(runnerWith());

    expect(result.ok).toBe(true);
    expect(result.results.every((entry) => entry.ok)).toBe(true);
    expect(formatSmokeTable(result)).toContain("BENCHMARK_PLUMBING_READY");
  });

  it("fails when a required success command fails", async () => {
    const result = await runBenchmarkReleaseSmoke(runnerWith({ typecheck: 2 }));

    expect(result.ok).toBe(false);
    expect(result.results.find((entry) => entry.id === "typecheck")).toMatchObject({
      expectedExitCode: 0,
      actualExitCode: 2,
      ok: false
    });
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

  it("does not include model, network, or orchestration commands", () => {
    const commandText = getBenchmarkReleaseSmokeCommands()
      .map((command) => [command.command, ...command.args].join(" "))
      .join("\n");

    expect(commandText).not.toMatch(/ollama|model|aedis|orchestrat|curl|wget|http:\/\/|https:\/\//i);
  });
});
