import {
  loadMockPipelineResultManifest,
  type MockPipelineResultManifest,
  type MockPipelineResultManifestEntry
} from "../core/examples/mockPipelineResultManifest.js";

export interface MockPipelineResultsListCliResult {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

interface ParsedArgs {
  benchmarkId?: string;
  status?: string;
  id?: string;
  json: boolean;
}

const usage = `Usage:
  scintilla mock-pipeline-results list [--benchmark <benchmarkId>] [--status <status>] [--id <resultId>] [--json]
  scintilla mock-pipeline-results list --help

Options:
  --benchmark <benchmarkId>  Filter result fixtures by benchmark id.
  --status <status>          Filter result fixtures by expected status.
  --id <resultId>            Filter result fixtures by id.
  --json                     Print machine-readable manifest output.
  --help                     Show this help message.`;

const forbiddenExecutionFlags = new Set([
  "--run",
  "--execute",
  "--apply",
  "--model",
  "--ollama",
  "--scan",
  "--build",
  "--evaluate",
  "--validate"
]);

function usageResult(message: string): MockPipelineResultsListCliResult {
  return {
    exitCode: 2,
    stdout: "",
    stderr: `${message}\n\n${usage}\n`
  };
}

function parseArgs(args: readonly string[]): ParsedArgs | MockPipelineResultsListCliResult {
  const normalizedArgs = args.filter((arg) => arg !== "--");

  if (normalizedArgs.includes("--help")) {
    return {
      exitCode: 0,
      stdout: `${usage}\n`,
      stderr: ""
    };
  }

  let benchmarkId: string | undefined;
  let status: string | undefined;
  let id: string | undefined;
  let json = false;

  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const arg = normalizedArgs[index];
    if (arg === undefined) {
      continue;
    }

    if (forbiddenExecutionFlags.has(arg)) {
      return usageResult(`${arg} is not supported by this read-only mock-pipeline result examples command.`);
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--benchmark" || arg === "--status" || arg === "--id") {
      const value = normalizedArgs[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return usageResult(`${arg} requires a value`);
      }

      if (arg === "--benchmark") {
        benchmarkId = value;
      } else if (arg === "--status") {
        status = value;
      } else {
        id = value;
      }

      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      return usageResult(`Unknown flag: ${arg}`);
    }

    return usageResult(`Unexpected argument: ${arg}`);
  }

  return {
    benchmarkId,
    status,
    id,
    json
  };
}

function filterManifest(manifest: MockPipelineResultManifest, filters: Omit<ParsedArgs, "json">): MockPipelineResultManifest {
  return {
    ...manifest,
    results: manifest.results.filter((entry) => {
      if (filters.id !== undefined && entry.id !== filters.id) {
        return false;
      }

      if (filters.benchmarkId !== undefined && entry.benchmarkId !== filters.benchmarkId) {
        return false;
      }

      if (filters.status !== undefined && entry.expectedStatus !== filters.status) {
        return false;
      }

      return true;
    })
  };
}

function formatEntry(entry: MockPipelineResultManifestEntry): string {
  return [
    entry.id,
    `  path: ${entry.path}`,
    `  benchmarkId: ${entry.benchmarkId}`,
    `  scenario: ${entry.scenario}`,
    `  expectedStatus: ${entry.expectedStatus}`,
    `  description: ${entry.description}`
  ].join("\n");
}

function formatHuman(manifest: MockPipelineResultManifest): string {
  return manifest.results.map(formatEntry).join("\n\n");
}

function noMatchesMessage(filters: Omit<ParsedArgs, "json">): string {
  const parts = [];
  if (filters.id !== undefined) {
    parts.push(`id: ${filters.id}`);
  }
  if (filters.benchmarkId !== undefined) {
    parts.push(`benchmarkId: ${filters.benchmarkId}`);
  }
  if (filters.status !== undefined) {
    parts.push(`status: ${filters.status}`);
  }

  return `No mock-pipeline result fixtures found${parts.length > 0 ? ` for ${parts.join(", ")}` : ""}`;
}

export async function runMockPipelineResultsListCli(args: readonly string[]): Promise<MockPipelineResultsListCliResult> {
  const parsedArgs = parseArgs(args);
  if ("exitCode" in parsedArgs) {
    return parsedArgs;
  }

  let manifest: MockPipelineResultManifest;
  try {
    manifest = filterManifest(await loadMockPipelineResultManifest(), {
      id: parsedArgs.id,
      benchmarkId: parsedArgs.benchmarkId,
      status: parsedArgs.status
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 2,
      stdout: "",
      stderr: `Failed to load mock-pipeline result manifest: ${message}\n`
    };
  }

  if (manifest.results.length === 0) {
    return {
      exitCode: 1,
      stdout: parsedArgs.json ? `${JSON.stringify(manifest, null, 2)}\n` : "",
      stderr: `${noMatchesMessage(parsedArgs)}\n`
    };
  }

  return {
    exitCode: 0,
    stdout: parsedArgs.json ? `${JSON.stringify(manifest, null, 2)}\n` : `${formatHuman(manifest)}\n`,
    stderr: ""
  };
}
