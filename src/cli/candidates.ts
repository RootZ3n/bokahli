import { readFile } from "node:fs/promises";
import { loadCandidateResultFromFile, type CandidateLoadError } from "../core/benchmark/candidateLoader.js";

export interface CandidatesValidateCliResult {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

interface ParsedArgs {
  candidatePath: string;
  benchmarkId?: string;
  json: boolean;
}

interface CandidateValidationCliPayload {
  ok: boolean;
  source: "file";
  benchmarkId?: string;
  errors: CandidateLoadError[];
}

const usage = `Usage:
  scintilla candidates validate --candidate <path> [--benchmark <benchmarkId>] [--json]
  scintilla candidates validate --help

Options:
  --candidate <path>       Local candidate JSON file to validate.
  --benchmark <benchmark>  Expected benchmark id.
  --json                   Print machine-readable validation result.
  --help                   Show this help message.`;

const forbiddenExecutionFlags = new Set(["--run", "--evaluate", "--apply", "--verify"]);

function usageResult(message: string): CandidatesValidateCliResult {
  return {
    exitCode: 2,
    stdout: "",
    stderr: `${message}\n\n${usage}\n`
  };
}

function parseArgs(args: readonly string[]): ParsedArgs | CandidatesValidateCliResult {
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
      return usageResult(`${arg} is not supported by this read-only validation command.`);
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

  return {
    candidatePath,
    benchmarkId,
    json
  };
}

async function readBenchmarkIdIfPossible(candidatePath: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(candidatePath, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { benchmarkId?: unknown }).benchmarkId === "string") {
      return (parsed as { benchmarkId: string }).benchmarkId;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function isValidationFailure(errors: readonly CandidateLoadError[]): boolean {
  return errors.length > 0 && errors.every((error) => error.code === "candidate_validation_error");
}

function formatErrors(errors: readonly CandidateLoadError[]): string {
  return errors.map((error) => `- ${error.code}${error.path === undefined ? "" : ` ${error.path}`}: ${error.message}`).join("\n");
}

function formatHuman(payload: CandidateValidationCliPayload): string {
  if (payload.ok) {
    return [`VALID`, `source: ${payload.source}`, payload.benchmarkId === undefined ? undefined : `benchmarkId: ${payload.benchmarkId}`]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  return [`INVALID`, `source: ${payload.source}`, payload.benchmarkId === undefined ? undefined : `benchmarkId: ${payload.benchmarkId}`, "errors:", formatErrors(payload.errors)]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export async function runCandidatesValidateCli(args: readonly string[]): Promise<CandidatesValidateCliResult> {
  const parsedArgs = parseArgs(args);
  if ("exitCode" in parsedArgs) {
    return parsedArgs;
  }

  const result = await loadCandidateResultFromFile(parsedArgs.candidatePath, {
    supportedBenchmarkIds: parsedArgs.benchmarkId === undefined ? undefined : [parsedArgs.benchmarkId]
  });

  if (result.ok) {
    const payload: CandidateValidationCliPayload = {
      ok: true,
      source: "file",
      benchmarkId: result.candidate.benchmarkId,
      errors: []
    };

    return {
      exitCode: 0,
      stdout: parsedArgs.json ? `${JSON.stringify(payload, null, 2)}\n` : `${formatHuman(payload)}\n`,
      stderr: ""
    };
  }

  const benchmarkId = await readBenchmarkIdIfPossible(parsedArgs.candidatePath);
  const payload: CandidateValidationCliPayload = {
    ok: false,
    source: "file",
    benchmarkId,
    errors: result.errors
  };
  const exitCode = isValidationFailure(result.errors) ? 1 : 2;

  return {
    exitCode,
    stdout: parsedArgs.json ? `${JSON.stringify(payload, null, 2)}\n` : `${formatHuman(payload)}\n`,
    stderr: ""
  };
}
