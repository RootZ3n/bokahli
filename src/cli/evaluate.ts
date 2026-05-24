import {
  evaluateBenchmarkCandidateFromFile,
  type BenchmarkEvaluationError,
  type BenchmarkEvaluationResult
} from "../core/benchmark/evaluateBenchmark.js";
import { getExecutableBenchmarkSummary } from "../core/benchmark/summary.js";

export interface CandidatesEvaluateCliResult {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

interface ParsedArgs {
  candidatePath: string;
  benchmarkId: string;
  json: boolean;
}

const usage = `Usage:
  scintilla candidates evaluate --candidate <path> --benchmark <benchmarkId> [--json]
  scintilla candidates evaluate --help

Options:
  --candidate <path>       Local candidate JSON file to evaluate.
  --benchmark <benchmark>  Benchmark id to evaluate against.
  --json                   Print machine-readable evaluation result.
  --help                   Show this help message.`;

const forbiddenExecutionFlags = new Set(["--run", "--apply", "--model", "--ollama", "--shell", "--network"]);

function usageResult(message: string): CandidatesEvaluateCliResult {
  return {
    exitCode: 2,
    stdout: "",
    stderr: `${message}\n\n${usage}\n`
  };
}

function parseArgs(args: readonly string[]): ParsedArgs | CandidatesEvaluateCliResult {
  const normalizedArgs = args.filter((arg) => arg !== "--");

  if (normalizedArgs.includes("--help")) {
    return {
      exitCode: 0,
      stdout: `${usage}\n`,
      stderr: ""
    };
  }

  let candidatePath: string | undefined;
  let benchmarkId: string | undefined;
  let json = false;

  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const arg = normalizedArgs[index];
    if (arg === undefined) {
      continue;
    }

    if (forbiddenExecutionFlags.has(arg)) {
      return usageResult(`${arg} is not supported by this deterministic evaluation command.`);
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--candidate") {
      const value = normalizedArgs[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return usageResult("--candidate requires a file path");
      }
      candidatePath = value;
      index += 1;
      continue;
    }

    if (arg === "--benchmark") {
      const value = normalizedArgs[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return usageResult("--benchmark requires a benchmark id");
      }
      benchmarkId = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      return usageResult(`Unknown flag: ${arg}`);
    }

    return usageResult(`Unexpected argument: ${arg}`);
  }

  if (candidatePath === undefined) {
    return usageResult("--candidate is required");
  }

  if (benchmarkId === undefined) {
    return usageResult("--benchmark is required");
  }

  return {
    candidatePath,
    benchmarkId,
    json
  };
}

function formatErrors(errors: readonly BenchmarkEvaluationError[]): string {
  return errors.map((error) => `- ${error.code}${error.path === undefined ? "" : ` ${error.path}`}: ${error.message}`).join("\n");
}

function formatHuman(result: BenchmarkEvaluationResult): string {
  if (result.ok) {
    return [
      "PASS",
      `benchmarkId: ${result.benchmarkId}`,
      "failedChecks: none",
      "evidence:",
      ...result.verification.evidence.map((entry) => `- ${entry}`)
    ].join("\n");
  }

  const lines = ["FAIL", `stage: ${result.stage}`, `benchmarkId: ${result.benchmarkId}`];
  if (result.verification !== undefined) {
    lines.push("failedChecks:", ...result.verification.failedChecks.map((check) => `- ${check}`));
    lines.push("evidence:", ...result.verification.evidence.map((entry) => `- ${entry}`));
  } else {
    lines.push("errors:", formatErrors(result.errors));
  }

  return lines.join("\n");
}

function isUsageOrValidationFailure(result: BenchmarkEvaluationResult): boolean {
  if (result.ok) {
    return false;
  }

  if (result.stage === "load" || result.stage === "validate") {
    return true;
  }

  const failedChecks = result.verification?.failedChecks ?? [];
  return failedChecks.some(
    (check) =>
      check.startsWith("unknown benchmark fixture:") ||
      check.includes("candidate benchmarkId does not match requested benchmarkId") ||
      check === "candidate_validation"
  );
}

export async function runCandidatesEvaluateCli(args: readonly string[]): Promise<CandidatesEvaluateCliResult> {
  const parsedArgs = parseArgs(args);
  if ("exitCode" in parsedArgs) {
    return parsedArgs;
  }

  if (getExecutableBenchmarkSummary(parsedArgs.benchmarkId) === undefined) {
    const result: BenchmarkEvaluationResult = {
      ok: false,
      benchmarkId: parsedArgs.benchmarkId,
      source: "file",
      stage: "load",
      errors: [
        {
          code: "unknown_benchmark",
          message: `unknown executable benchmark: ${parsedArgs.benchmarkId}`
        }
      ]
    };

    return {
      exitCode: 2,
      stdout: parsedArgs.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatHuman(result)}\n`,
      stderr: ""
    };
  }

  const result = await evaluateBenchmarkCandidateFromFile(parsedArgs.benchmarkId, parsedArgs.candidatePath);
  const exitCode = result.ok ? 0 : isUsageOrValidationFailure(result) ? 2 : 1;

  return {
    exitCode,
    stdout: parsedArgs.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatHuman(result)}\n`,
    stderr: ""
  };
}
