import { lstat, readFile } from "node:fs/promises";
import { runMockPipeline } from "../core/pipeline/mockPipeline.js";
import { loadTaskContractFromFile, TaskContractLoadError } from "../core/contracts/loader.js";
import type { ContextPacket } from "../core/context/contextPacket.js";
import { mockWorkerScenarios } from "../core/workers/mockWorker.js";
import type { MockWorkerScenario } from "../core/workers/types.js";

export interface MockPipelineRunCliResult {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

interface ParsedArgs {
  contractPath: string;
  contextPacketPath: string;
  scenario: MockWorkerScenario;
  benchmarkId?: string;
}

const usage = `Usage:
  scintilla mock-pipeline run --contract <path> --context-packet <path> --scenario <scenario> [--benchmark <benchmarkId>] [--json]
  scintilla mock-pipeline run --help

Options:
  --contract <path>        Local TaskContract JSON file.
  --context-packet <path>  Local ContextPacket JSON file.
  --scenario <scenario>    Mock worker scenario to run through the pipeline.
  --benchmark <benchmark>  Optional benchmark ID override.
  --json                   Print structured pipeline result as JSON. JSON output is the default.
  --help                   Show this help message.`;

const forbiddenExecutionFlags = new Set(["--model", "--ollama", "--execute", "--apply", "--write", "--edit", "--shell"]);

function usageResult(message: string): MockPipelineRunCliResult {
  return {
    exitCode: 2,
    stdout: "",
    stderr: `${message}\n\n${usage}\n`
  };
}

function parseArgs(args: readonly string[]): ParsedArgs | MockPipelineRunCliResult {
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
  let benchmarkId: string | undefined;

  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const arg = normalizedArgs[index];
    if (arg === undefined) {
      continue;
    }

    if (forbiddenExecutionFlags.has(arg)) {
      return usageResult(`${arg} is not supported by this deterministic mock pipeline command.`);
    }

    if (arg === "--json") {
      continue;
    }

    if (arg === "--contract" || arg === "--context-packet" || arg === "--scenario" || arg === "--benchmark") {
      const value = normalizedArgs[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return usageResult(`${arg} requires a value`);
      }

      if (arg === "--contract") {
        contractPath = value;
      } else if (arg === "--context-packet") {
        contextPacketPath = value;
      } else if (arg === "--benchmark") {
        benchmarkId = value;
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
    benchmarkId
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

export async function runMockPipelineCli(args: readonly string[]): Promise<MockPipelineRunCliResult> {
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
        stderr: `${error.errors.map((entry) => `${entry.code} ${entry.path}: ${entry.message}`).join("\n")}\n`
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

  const result = await runMockPipeline({
    contract,
    contextPacket,
    scenario: parsedArgs.scenario,
    benchmarkId: parsedArgs.benchmarkId
  });

  return {
    exitCode: result.ok ? 0 : 1,
    stdout: `${JSON.stringify(result, null, 2)}\n`,
    stderr: ""
  };
}
