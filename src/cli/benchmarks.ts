import { listExecutableBenchmarks, type ExecutableBenchmarkSummary } from "../core/benchmark/summary.js";

export interface BenchmarksListCliResult {
  exitCode: 0 | 2;
  stdout: string;
  stderr: string;
}

const usage = `Usage:
  scintilla benchmarks list [--json]
  scintilla benchmarks list --help

Options:
  --json   Print executable benchmark summaries as JSON.
  --help   Show this help message.`;

function formatBaseline(isBaseline: boolean): string {
  return isBaseline ? "yes" : "no";
}

export function formatBenchmarkSummariesHuman(summaries: readonly ExecutableBenchmarkSummary[]): string {
  return summaries
    .map((summary) =>
      [
        summary.benchmarkId,
        `  title: ${summary.title}`,
        `  prompt quality: ${summary.promptQualityLevel}`,
        `  baseline: ${formatBaseline(summary.isBaseline)}`,
        `  fixture: ${summary.fixtureId}`,
        `  verifier: ${summary.verifierId}`,
        `  required candidate fields: ${summary.requiredCandidateFields.join(", ")}`
      ].join("\n")
    )
    .join("\n\n");
}

export function runBenchmarksListCli(args: readonly string[]): BenchmarksListCliResult {
  const normalizedArgs = args.filter((arg) => arg !== "--");
  const unknownFlag = normalizedArgs.find((arg) => arg.startsWith("-") && arg !== "--json" && arg !== "--help");
  if (unknownFlag !== undefined) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `Unknown flag: ${unknownFlag}\n\n${usage}\n`
    };
  }

  if (normalizedArgs.includes("--help")) {
    return {
      exitCode: 0,
      stdout: `${usage}\n`,
      stderr: ""
    };
  }

  const summaries = listExecutableBenchmarks();
  if (normalizedArgs.includes("--json")) {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify(summaries, null, 2)}\n`,
      stderr: ""
    };
  }

  return {
    exitCode: 0,
    stdout: `${formatBenchmarkSummariesHuman(summaries)}\n`,
    stderr: ""
  };
}
