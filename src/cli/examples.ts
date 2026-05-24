import {
  loadCandidateExampleManifest,
  type CandidateExampleManifest,
  type CandidateExampleManifestTemplate
} from "../core/examples/candidateManifest.js";

export interface ExamplesListCliResult {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

interface ParsedArgs {
  benchmarkId?: string;
  json: boolean;
}

const usage = `Usage:
  scintilla examples list [--benchmark <benchmarkId>] [--json]
  scintilla examples list --help

Options:
  --benchmark <benchmark>  Filter templates by benchmark id.
  --json                   Print machine-readable manifest output.
  --help                   Show this help message.`;

const forbiddenExecutionFlags = new Set(["--run", "--evaluate", "--apply", "--model", "--ollama"]);

function usageResult(message: string): ExamplesListCliResult {
  return {
    exitCode: 2,
    stdout: "",
    stderr: `${message}\n\n${usage}\n`
  };
}

function parseArgs(args: readonly string[]): ParsedArgs | ExamplesListCliResult {
  const normalizedArgs = args.filter((arg) => arg !== "--");

  if (normalizedArgs.includes("--help")) {
    return {
      exitCode: 0,
      stdout: `${usage}\n`,
      stderr: ""
    };
  }

  let benchmarkId: string | undefined;
  let json = false;

  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const arg = normalizedArgs[index];
    if (arg === undefined) {
      continue;
    }

    if (forbiddenExecutionFlags.has(arg)) {
      return usageResult(`${arg} is not supported by this read-only examples command.`);
    }

    if (arg === "--json") {
      json = true;
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

  return {
    benchmarkId,
    json
  };
}

function filterManifest(manifest: CandidateExampleManifest, benchmarkId?: string): CandidateExampleManifest {
  if (benchmarkId === undefined) {
    return manifest;
  }

  return {
    ...manifest,
    templates: manifest.templates.filter((template) => template.benchmarkId === benchmarkId)
  };
}

function formatTemplate(template: CandidateExampleManifestTemplate): string {
  return [
    template.id,
    `  benchmarkId: ${template.benchmarkId}`,
    `  path: ${template.path}`,
    `  expectedValidation: ${template.expectedValidation}`,
    `  expectedEvaluation: ${template.expectedEvaluation}`,
    `  description: ${template.description}`
  ].join("\n");
}

function formatHuman(manifest: CandidateExampleManifest): string {
  return manifest.templates.map(formatTemplate).join("\n\n");
}

export async function runExamplesListCli(args: readonly string[]): Promise<ExamplesListCliResult> {
  const parsedArgs = parseArgs(args);
  if ("exitCode" in parsedArgs) {
    return parsedArgs;
  }

  let manifest: CandidateExampleManifest;
  try {
    manifest = filterManifest(await loadCandidateExampleManifest(), parsedArgs.benchmarkId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 2,
      stdout: "",
      stderr: `Failed to load candidate example manifest: ${message}\n`
    };
  }

  if (manifest.templates.length === 0) {
    const message = `No candidate example templates found for benchmark: ${parsedArgs.benchmarkId ?? "all"}`;
    return {
      exitCode: 1,
      stdout: parsedArgs.json ? `${JSON.stringify(manifest, null, 2)}\n` : "",
      stderr: `${message}\n`
    };
  }

  return {
    exitCode: 0,
    stdout: parsedArgs.json ? `${JSON.stringify(manifest, null, 2)}\n` : `${formatHuman(manifest)}\n`,
    stderr: ""
  };
}
