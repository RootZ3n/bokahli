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

export interface SmokeRunResult {
  readonly ok: boolean;
  readonly results: readonly SmokeCommandResult[];
}

export type SmokeCommandRunner = (command: SmokeCommand) => Promise<number>;

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

export function createSpawnRunner(): SmokeCommandRunner {
  return (command) =>
    new Promise((resolve) => {
      const child = spawn(command.command, command.args, {
        shell: false,
        stdio: "inherit"
      });

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

export function formatSmokeTable(result: SmokeRunResult): string {
  const lines = ["status | expected | actual | command", "--- | ---: | ---: | ---"];

  for (const commandResult of result.results) {
    lines.push(
      `${commandResult.ok ? "PASS" : "FAIL"} | ${commandResult.expectedExitCode} | ${commandResult.actualExitCode} | ${formatSmokeCommand(commandResult)}`
    );
  }

  lines.push("");
  lines.push(result.ok ? "BENCHMARK_PLUMBING_READY" : "NOT_READY");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const result = await runBenchmarkReleaseSmoke();
  console.log(formatSmokeTable(result));
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
