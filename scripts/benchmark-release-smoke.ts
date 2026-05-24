import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface SmokeCommand {
  readonly id: string;
  readonly command: "pnpm";
  readonly args: readonly string[];
  readonly expectedExitCode: number;
  readonly captureStdout?: boolean;
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

export interface SmokeCommandOutput {
  readonly exitCode: number;
  readonly stdout?: string;
}

export type SmokeCommandRunner = (command: SmokeCommand) => Promise<number | SmokeCommandOutput>;

export interface SmokeRunOptions {
  readonly tempRoot?: string;
}

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
    },
    {
      id: "ariadne-scan-simple",
      command: "pnpm",
      args: ["ariadne:scan", "--", "--repo", "tests/fixtures/simple-ts-repo"],
      expectedExitCode: 0
    },
    {
      id: "ariadne-scan-simple-json",
      command: "pnpm",
      args: ["ariadne:scan", "--", "--repo", "tests/fixtures/simple-ts-repo", "--json"],
      expectedExitCode: 0
    },
    {
      id: "ariadne-packet-readme-json",
      command: "pnpm",
      args: [
        "ariadne:packet",
        "--",
        "--repo",
        "tests/fixtures/simple-ts-repo",
        "--task-type",
        "patch_one_file",
        "--goal",
        "Update README usage text",
        "--allowed-file",
        "README.md",
        "--select",
        "README.md",
        "--verification",
        "pnpm test",
        "--json"
      ],
      expectedExitCode: 0
    },
    {
      id: "context-packets-list",
      command: "pnpm",
      args: ["context-packets:list"],
      expectedExitCode: 0
    },
    {
      id: "context-packets-list-json",
      command: "pnpm",
      args: ["context-packets:list", "--", "--json"],
      expectedExitCode: 0
    },
    {
      id: "context-packets-list-readme",
      command: "pnpm",
      args: ["context-packets:list", "--", "--id", "readme_patch_one_file"],
      expectedExitCode: 0
    },
    {
      id: "contracts-list",
      command: "pnpm",
      args: ["contracts:list"],
      expectedExitCode: 0
    },
    {
      id: "contracts-list-json",
      command: "pnpm",
      args: ["contracts:list", "--", "--json"],
      expectedExitCode: 0
    },
    {
      id: "contracts-list-readme",
      command: "pnpm",
      args: ["contracts:list", "--", "--id", "readme_patch_one_file"],
      expectedExitCode: 0
    },
    {
      id: "ariadne-packet-readme-contract-json",
      command: "pnpm",
      args: [
        "ariadne:packet",
        "--",
        "--repo",
        "tests/fixtures/simple-ts-repo",
        "--contract",
        "examples/contracts/readme_patch_one_file.contract.json",
        "--json"
      ],
      expectedExitCode: 0
    },
    {
      id: "mock-pipeline-docs-pass",
      command: "pnpm",
      args: [
        "mock-pipeline:run",
        "--",
        "--contract",
        "examples/contracts/readme_patch_one_file.contract.json",
        "--context-packet",
        "examples/context-packets/readme_patch_one_file.packet.json",
        "--scenario",
        "valid_docs_single_file_edit",
        "--benchmark",
        "docs_single_file_edit",
        "--json"
      ],
      expectedExitCode: 0
    },
    {
      id: "mock-pipeline-refusal-expected",
      command: "pnpm",
      args: [
        "mock-pipeline:run",
        "--",
        "--contract",
        "examples/contracts/readme_patch_one_file.contract.json",
        "--context-packet",
        "examples/context-packets/readme_patch_one_file.packet.json",
        "--scenario",
        "refusal_uncertain",
        "--benchmark",
        "docs_single_file_edit",
        "--json"
      ],
      expectedExitCode: 1
    },
    {
      id: "mock-pipeline-invalid-schema-expected",
      command: "pnpm",
      args: [
        "mock-pipeline:run",
        "--",
        "--contract",
        "examples/contracts/readme_patch_one_file.contract.json",
        "--context-packet",
        "examples/context-packets/readme_patch_one_file.packet.json",
        "--scenario",
        "invalid_schema",
        "--benchmark",
        "docs_single_file_edit",
        "--json"
      ],
      expectedExitCode: 1
    },
    {
      id: "mock-pipeline-results-list",
      command: "pnpm",
      args: ["mock-pipeline-results:list"],
      expectedExitCode: 0
    },
    {
      id: "mock-pipeline-results-list-json",
      command: "pnpm",
      args: ["mock-pipeline-results:list", "--", "--json"],
      expectedExitCode: 0
    },
    {
      id: "mock-pipeline-results-list-docs",
      command: "pnpm",
      args: ["mock-pipeline-results:list", "--", "--benchmark", "docs_single_file_edit"],
      expectedExitCode: 0
    },
    {
      id: "mock-pipeline-results-list-passed",
      command: "pnpm",
      args: ["mock-pipeline-results:list", "--", "--status", "passed"],
      expectedExitCode: 0
    },
    {
      id: "mock-pipeline-results-list-docs-passed",
      command: "pnpm",
      args: ["mock-pipeline-results:list", "--", "--id", "docs_single_file_edit.passed"],
      expectedExitCode: 0
    }
  ];
}

export function getMockWorkerCandidateSmokeCommands(candidatePath: string): readonly SmokeCommand[] {
  return [
    {
      id: "mock-worker-candidate-only",
      command: "pnpm",
      args: [
        "--silent",
        "mock-worker:run",
        "--",
        "--contract",
        "examples/contracts/readme_patch_one_file.contract.json",
        "--context-packet",
        "examples/context-packets/readme_patch_one_file.packet.json",
        "--scenario",
        "valid_docs_single_file_edit",
        "--candidate-only"
      ],
      expectedExitCode: 0,
      captureStdout: true
    },
    {
      id: "mock-worker-candidate-validate",
      command: "pnpm",
      args: ["candidates:validate", "--", "--candidate", candidatePath, "--benchmark", "docs_single_file_edit"],
      expectedExitCode: 0
    },
    {
      id: "mock-worker-candidate-evaluate",
      command: "pnpm",
      args: ["candidates:evaluate", "--", "--candidate", candidatePath, "--benchmark", "docs_single_file_edit"],
      expectedExitCode: 0
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
        stdio: options.redirectOutputToStderr || command.captureStdout ? ["ignore", "pipe", "pipe"] : "inherit"
      });
      let stdout = "";

      if (child.stdout !== null) {
        if (command.captureStdout) {
          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
          });
        } else if (options.redirectOutputToStderr) {
          child.stdout.pipe(process.stderr);
        }
      }

      if ((options.redirectOutputToStderr || command.captureStdout) && child.stderr !== null) {
        child.stderr.pipe(process.stderr);
      }

      child.on("error", () => resolve(command.captureStdout ? { exitCode: 127, stdout } : 127));
      child.on("close", (code) => resolve(command.captureStdout ? { exitCode: code ?? 1, stdout } : (code ?? 1)));
    });
}

function normalizeCommandOutput(output: number | SmokeCommandOutput): SmokeCommandOutput {
  return typeof output === "number" ? { exitCode: output } : output;
}

async function runSmokeCommand(command: SmokeCommand, runner: SmokeCommandRunner): Promise<SmokeCommandResult & { readonly stdout?: string }> {
  const output = normalizeCommandOutput(await runner(command));
  return {
    ...command,
    actualExitCode: output.exitCode,
    ok: output.exitCode === command.expectedExitCode,
    stdout: output.stdout
  };
}

function failedResult(command: SmokeCommand): SmokeCommandResult {
  return {
    ...command,
    actualExitCode: 1,
    ok: false
  };
}

async function runMockWorkerCandidatePath(
  runner: SmokeCommandRunner,
  results: SmokeCommandResult[],
  options: SmokeRunOptions
): Promise<void> {
  const tempDir = await mkdtemp(path.join(options.tempRoot ?? tmpdir(), "scintilla-smoke-"));
  const candidatePath = path.join(tempDir, "mock-worker-candidate.json");
  const commands = getMockWorkerCandidateSmokeCommands(candidatePath);
  const generateCommand = commands[0] as SmokeCommand;
  const validateCommand = commands[1] as SmokeCommand;
  const evaluateCommand = commands[2] as SmokeCommand;

  try {
    const generateResult = await runSmokeCommand(generateCommand, runner);
    results.push(generateResult);

    if (!generateResult.ok || generateResult.stdout === undefined || generateResult.stdout.length === 0) {
      results.push(failedResult(validateCommand), failedResult(evaluateCommand));
      return;
    }

    await writeFile(candidatePath, generateResult.stdout, "utf8");
    results.push(await runSmokeCommand(validateCommand, runner));
    results.push(await runSmokeCommand(evaluateCommand, runner));
  } finally {
    await rm(tempDir, {
      recursive: true,
      force: true
    });
  }
}

export async function runBenchmarkReleaseSmoke(
  runner: SmokeCommandRunner = createSpawnRunner(),
  options: SmokeRunOptions = {}
): Promise<SmokeRunResult> {
  const results: SmokeCommandResult[] = [];

  for (const command of getBenchmarkReleaseSmokeCommands()) {
    results.push(await runSmokeCommand(command, runner));
  }

  await runMockWorkerCandidatePath(runner, results, options);

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
