import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export interface SmokeCommand {
  readonly id: string;
  readonly command: "pnpm";
  readonly args: readonly string[];
  readonly expectedExitCode: number;
}

export interface SmokeCommandResult extends SmokeCommand {
  readonly actualExitCode: number;
  readonly ok: boolean;
}

export type SmokeStatus = "BENCHMARK_PLUMBING_READY" | "NOT_READY" | "BLOCKED";

export interface SmokeRunResult {
  readonly ok: boolean;
  readonly results: readonly SmokeCommandResult[];
}

export interface SmokeCounts {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
}

export interface SmokeJsonCheck {
  readonly name: string;
  readonly expectedExit: number | "zero";
  readonly actualExit: number | null;
  readonly status: "pass" | "fail" | "blocked";
  readonly command: readonly string[];
}

export interface SmokeJsonReport {
  readonly status: SmokeStatus;
  readonly checksTotal: number;
  readonly checksPassed: number;
  readonly checksFailed: number;
  readonly checks: readonly SmokeJsonCheck[];
}

export type SmokeCommandRunner = (command: SmokeCommand) => Promise<number>;

export interface SpawnRunnerOptions {
  readonly redirectOutputToStderr?: boolean;
}

export function getBenchmarkReleaseSmokeCommands(): readonly SmokeCommand[] {
  return [
    {
      id: "typecheck",
      command: "pnpm",
      args: ["typecheck"],
      expectedExitCode: 0
    },
    {
      id: "test",
      command: "pnpm",
      args: ["test"],
      expectedExitCode: 0
    },
    {
      id: "build",
      command: "pnpm",
      args: ["build"],
      expectedExitCode: 0
    },
    {
      id: "benchmarks-list",
      command: "pnpm",
      args: ["benchmarks:list"],
      expectedExitCode: 0
    },
    {
      id: "benchmarks-list-json",
      command: "pnpm",
      args: ["benchmarks:list", "--", "--json"],
      expectedExitCode: 0
    },
    {
      id: "examples-list",
      command: "pnpm",
      args: ["examples:list"],
      expectedExitCode: 0
    },
    {
      id: "examples-list-json",
      command: "pnpm",
      args: ["examples:list", "--", "--json"],
      expectedExitCode: 0
    },
    {
      id: "examples-list-docs",
      command: "pnpm",
      args: ["examples:list", "--", "--benchmark", "docs_single_file_edit"],
      expectedExitCode: 0
    },
    {
      id: "candidate-validate-docs-pass",
      command: "pnpm",
      args: [
        "candidates:validate",
        "--",
        "--candidate",
        "examples/candidates/docs_single_file_edit.pass.json",
        "--benchmark",
        "docs_single_file_edit"
      ],
      expectedExitCode: 0
    },
    {
      id: "candidate-evaluate-docs-pass",
      command: "pnpm",
      args: [
        "candidates:evaluate",
        "--",
        "--candidate",
        "examples/candidates/docs_single_file_edit.pass.json",
        "--benchmark",
        "docs_single_file_edit"
      ],
      expectedExitCode: 0
    },
    {
      id: "candidate-evaluate-docs-intentional-fail",
      command: "pnpm",
      args: [
        "candidates:evaluate",
        "--",
        "--candidate",
        "examples/candidates/docs_single_file_edit.fail.json",
        "--benchmark",
        "docs_single_file_edit"
      ],
      expectedExitCode: 1
    }
  ];
}

export function formatSmokeCommand(command: SmokeCommand): string {
  return [command.command, ...command.args].join(" ");
}

export function createSpawnRunner(options: SpawnRunnerOptions = {}): SmokeCommandRunner {
  return (command) =>
    new Promise((resolve) => {
      const child = spawn(command.command, command.args, {
        shell: false,
        stdio: options.redirectOutputToStderr ? ["ignore", "pipe", "pipe"] : "inherit"
      });

      if (options.redirectOutputToStderr && child.stdout !== null && child.stderr !== null) {
        child.stdout.pipe(process.stderr);
        child.stderr.pipe(process.stderr);
      }

      child.on("error", () => resolve(127));
      child.on("close", (code) => resolve(code ?? 1));
    });
}

export async function runBenchmarkReleaseSmoke(runner: SmokeCommandRunner = createSpawnRunner()): Promise<SmokeRunResult> {
  const results: SmokeCommandResult[] = [];

  for (const command of getBenchmarkReleaseSmokeCommands()) {
    const actualExitCode = await runner(command);
    results.push({
      ...command,
      actualExitCode,
      ok: actualExitCode === command.expectedExitCode
    });
  }

  return {
    ok: results.every((result) => result.ok),
    results
  };
}

export function getSmokeStatus(result: SmokeRunResult): SmokeStatus {
  return result.ok ? "BENCHMARK_PLUMBING_READY" : "NOT_READY";
}

export function getSmokeCounts(result: SmokeRunResult): SmokeCounts {
  const passed = result.results.filter((entry) => entry.ok).length;
  const total = result.results.length;

  return {
    total,
    passed,
    failed: total - passed
  };
}

export function formatSmokeTable(result: SmokeRunResult): string {
  const lines = ["status | expected | actual | command", "--- | ---: | ---: | ---"];
  const counts = getSmokeCounts(result);
  const status = getSmokeStatus(result);

  for (const commandResult of result.results) {
    lines.push(
      `${commandResult.ok ? "PASS" : "FAIL"} | ${commandResult.expectedExitCode} | ${commandResult.actualExitCode} | ${formatSmokeCommand(commandResult)}`
    );
  }

  lines.push("");
  lines.push(`SCINTILLA_BENCHMARK_PLUMBING_CHECKS_TOTAL=${counts.total}`);
  lines.push(`SCINTILLA_BENCHMARK_PLUMBING_CHECKS_PASSED=${counts.passed}`);
  lines.push(`SCINTILLA_BENCHMARK_PLUMBING_CHECKS_FAILED=${counts.failed}`);
  lines.push(`SCINTILLA_BENCHMARK_PLUMBING_STATUS=${status}`);
  return lines.join("\n");
}

export function toSmokeJsonReport(result: SmokeRunResult): SmokeJsonReport {
  const counts = getSmokeCounts(result);

  return {
    status: getSmokeStatus(result),
    checksTotal: counts.total,
    checksPassed: counts.passed,
    checksFailed: counts.failed,
    checks: result.results.map((entry) => ({
      name: entry.id,
      expectedExit: entry.expectedExitCode,
      actualExit: entry.actualExitCode,
      status: entry.ok ? "pass" : "fail",
      command: [entry.command, ...entry.args]
    }))
  };
}

async function main(): Promise<void> {
  const json = process.argv.slice(2).filter((arg) => arg !== "--").includes("--json");
  const result = await runBenchmarkReleaseSmoke(createSpawnRunner({ redirectOutputToStderr: json }));
  console.log(json ? JSON.stringify(toSmokeJsonReport(result), null, 2) : formatSmokeTable(result));
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
