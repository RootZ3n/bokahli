import { lstat, readFile } from "node:fs/promises";
import { runMockWorker, mockWorkerScenarios } from "../core/workers/mockWorker.js";
import { loadTaskContractFromFile, TaskContractLoadError } from "../core/contracts/loader.js";
import type { ContextPacket } from "../core/context/contextPacket.js";
import type { MockWorkerScenario, WorkerResult } from "../core/workers/types.js";

export interface MockWorkerRunCliResult {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

interface ParsedArgs {
  contractPath: string;
  contextPacketPath: string;
  scenario: MockWorkerScenario;
  json: boolean;
  candidateOnly: boolean;
}

const usage = `Usage:
  scintilla mock-worker run --contract <path> --context-packet <path> --scenario <scenario> [--json] [--candidate-only]
  scintilla mock-worker run --help

Options:
  --contract <path>        Local TaskContract JSON file.
  --context-packet <path>  Local ContextPacket JSON file.
  --scenario <scenario>    Mock worker scenario to emit.
  --json                   Print machine-readable worker result.
  --candidate-only         Print only emitted candidate JSON. Implies JSON output.
  --help                   Show this help message.`;

const forbiddenExecutionFlags = new Set(["--run", "--execute", "--apply", "--model", "--ollama", "--evaluate", "--verify"]);

function usageResult(message: string): MockWorkerRunCliResult {
  return {
    exitCode: 2,
    stdout: "",
    stderr: `${message}\n\n${usage}\n`
  };
}

function parseArgs(args: readonly string[]): ParsedArgs | MockWorkerRunCliResult {
  const normalizedArgs = args.filter((arg) => arg !== "--");

  if (normalizedArgs.includes("--help")) {
    return {
      exitCode: 0,
      stdout: `${usage}\n`,
      stderr: ""
    };
  }

  let contractPath: string | undefined;
  let contextPacketPath: string | undefined;
  let scenario: MockWorkerScenario | undefined;
  let json = false;
  let candidateOnly = false;

  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const arg = normalizedArgs[index];
    if (arg === undefined) {
      continue;
    }

    if (forbiddenExecutionFlags.has(arg)) {
      return usageResult(`${arg} is not supported by this deterministic mock worker command.`);
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--candidate-only") {
      candidateOnly = true;
      continue;
    }

    if (arg === "--contract" || arg === "--context-packet" || arg === "--scenario") {
      const value = normalizedArgs[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return usageResult(`${arg} requires a value`);
      }

      if (arg === "--contract") {
        contractPath = value;
      } else if (arg === "--context-packet") {
        contextPacketPath = value;
      } else if (mockWorkerScenarios.includes(value as MockWorkerScenario)) {
        scenario = value as MockWorkerScenario;
      } else {
        return usageResult(`Unknown mock worker scenario: ${value}`);
      }

      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      return usageResult(`Unknown flag: ${arg}`);
    }

    return usageResult(`Unexpected argument: ${arg}`);
  }

  if (contractPath === undefined) {
    return usageResult("--contract is required");
  }
  if (contextPacketPath === undefined) {
    return usageResult("--context-packet is required");
  }
  if (scenario === undefined) {
    return usageResult("--scenario is required");
  }

  return {
    contractPath,
    contextPacketPath,
    scenario,
    json,
    candidateOnly
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateContextPacketShape(value: unknown): value is ContextPacket {
  if (!isPlainObject(value)) {
    return false;
  }

  const task = value["task"];
  const constraints = value["constraints"];
  const selectedPreviews = value["selectedPreviews"];
  const skippedPreviews = value["skippedPreviews"];
  const repoSummary = value["repoSummary"];
  const truncation = value["truncation"];
  const warnings = value["warnings"];

  return (
    typeof value["generatedAt"] === "string" &&
    typeof value["repoRoot"] === "string" &&
    isPlainObject(task) &&
    typeof task["taskType"] === "string" &&
    typeof task["goal"] === "string" &&
    Array.isArray(task["allowedFiles"]) &&
    isPlainObject(repoSummary) &&
    Array.isArray(selectedPreviews) &&
    Array.isArray(skippedPreviews) &&
    isPlainObject(constraints) &&
    Array.isArray(constraints["allowedFiles"]) &&
    Array.isArray(constraints["forbiddenFiles"]) &&
    constraints["workerAuthority"] === "propose_only" &&
    constraints["verifierDeterminesTruth"] === true &&
    isPlainObject(truncation) &&
    Array.isArray(warnings)
  );
}

async function loadContextPacketFromFile(filePath: string): Promise<ContextPacket> {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`context packet file could not be inspected: ${message}`);
  }

  if (stats.isSymbolicLink()) {
    throw new Error("context packet file must not be a symlink");
  }

  if (!stats.isFile()) {
    throw new Error("context packet path must be a file");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`context packet JSON could not be parsed: ${message}`);
  }

  if (!validateContextPacketShape(parsed)) {
    throw new Error("context packet JSON does not match the expected packet shape");
  }

  return parsed;
}

function formatHuman(result: WorkerResult): string {
  if (result.ok) {
    return [
      "CANDIDATE_EMITTED",
      `scenario: ${result.scenario}`,
      `benchmarkId: ${result.candidate.benchmarkId}`,
      `changedFiles: ${result.candidate.changedFiles.join(", ")}`
    ].join("\n");
  }

  if (result.candidate !== undefined) {
    const candidate = isPlainObject(result.candidate) ? result.candidate : {};
    const benchmarkId = typeof candidate["benchmarkId"] === "string" ? candidate["benchmarkId"] : "(missing)";
    const changedFiles = Array.isArray(candidate["changedFiles"]) ? candidate["changedFiles"].join(", ") : "(invalid)";
    return ["CANDIDATE_EMITTED", `scenario: ${result.scenario}`, `benchmarkId: ${benchmarkId}`, `changedFiles: ${changedFiles}`].join("\n");
  }

  return ["NO_CANDIDATE", `scenario: ${result.scenario}`, `reason: ${result.reason}`].join("\n");
}

export async function runMockWorkerCli(args: readonly string[]): Promise<MockWorkerRunCliResult> {
  const parsedArgs = parseArgs(args);
  if ("exitCode" in parsedArgs) {
    return parsedArgs;
  }

  let contract;
  try {
    contract = await loadTaskContractFromFile(parsedArgs.contractPath);
  } catch (error) {
    if (error instanceof TaskContractLoadError) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: error.errors.map((entry) => `${entry.code} ${entry.path}: ${entry.message}`).join("\n") + "\n"
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 2,
      stdout: "",
      stderr: `${message}\n`
    };
  }

  let contextPacket;
  try {
    contextPacket = await loadContextPacketFromFile(parsedArgs.contextPacketPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 2,
      stdout: "",
      stderr: `${message}\n`
    };
  }

  const result = runMockWorker({
    contract,
    contextPacket,
    scenario: parsedArgs.scenario
  });
  const hasCandidate = result.candidate !== undefined;

  if (parsedArgs.candidateOnly) {
    if (!hasCandidate) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Mock worker emitted no candidate for scenario ${result.scenario}${result.ok ? "" : `: ${result.reason}`}\n`
      };
    }

    return {
      exitCode: 0,
      stdout: `${JSON.stringify(result.candidate, null, 2)}\n`,
      stderr: ""
    };
  }

  return {
    exitCode: hasCandidate ? 0 : 1,
    stdout: parsedArgs.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatHuman(result)}\n`,
    stderr: ""
  };
}
