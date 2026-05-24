import {
  loadContextPacketExampleManifest,
  type ContextPacketExampleManifest,
  type ContextPacketExampleManifestTemplate
} from "../core/examples/contextPacketManifest.js";

export interface ContextPacketsListCliResult {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

interface ParsedArgs {
  id?: string;
  taskType?: string;
  json: boolean;
}

const usage = `Usage:
  scintilla context-packets list [--id <templateId>] [--task-type <taskType>] [--json]
  scintilla context-packets list --help

Options:
  --id <templateId>       Filter templates by id.
  --task-type <taskType>  Filter templates by task type.
  --json                  Print machine-readable manifest output.
  --help                  Show this help message.`;

const forbiddenExecutionFlags = new Set(["--run", "--execute", "--apply", "--model", "--ollama", "--scan", "--build"]);

function usageResult(message: string): ContextPacketsListCliResult {
  return {
    exitCode: 2,
    stdout: "",
    stderr: `${message}\n\n${usage}\n`
  };
}

function parseArgs(args: readonly string[]): ParsedArgs | ContextPacketsListCliResult {
  const normalizedArgs = args.filter((arg) => arg !== "--");

  if (normalizedArgs.includes("--help")) {
    return {
      exitCode: 0,
      stdout: `${usage}\n`,
      stderr: ""
    };
  }

  let id: string | undefined;
  let taskType: string | undefined;
  let json = false;

  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const arg = normalizedArgs[index];
    if (arg === undefined) {
      continue;
    }

    if (forbiddenExecutionFlags.has(arg)) {
      return usageResult(`${arg} is not supported by this read-only context packet examples command.`);
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--id" || arg === "--task-type") {
      const value = normalizedArgs[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return usageResult(`${arg} requires a value`);
      }

      if (arg === "--id") {
        id = value;
      } else {
        taskType = value;
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
    id,
    taskType,
    json
  };
}

function filterManifest(manifest: ContextPacketExampleManifest, filters: Pick<ParsedArgs, "id" | "taskType">): ContextPacketExampleManifest {
  return {
    ...manifest,
    templates: manifest.templates.filter((template) => {
      if (filters.id !== undefined && template.id !== filters.id) {
        return false;
      }

      if (filters.taskType !== undefined && template.taskType !== filters.taskType) {
        return false;
      }

      return true;
    })
  };
}

function formatTemplate(template: ContextPacketExampleManifestTemplate): string {
  return [
    template.id,
    `  path: ${template.path}`,
    `  taskType: ${template.taskType}`,
    `  goal: ${template.goal}`,
    `  selectedPaths: ${template.selectedPaths.join(", ")}`,
    `  allowedFiles: ${template.allowedFiles.join(", ")}`,
    `  description: ${template.description}`
  ].join("\n");
}

function formatHuman(manifest: ContextPacketExampleManifest): string {
  return manifest.templates.map(formatTemplate).join("\n\n");
}

function noMatchesMessage(filters: Pick<ParsedArgs, "id" | "taskType">): string {
  const parts = [];
  if (filters.id !== undefined) {
    parts.push(`id: ${filters.id}`);
  }
  if (filters.taskType !== undefined) {
    parts.push(`taskType: ${filters.taskType}`);
  }

  return `No context packet templates found${parts.length > 0 ? ` for ${parts.join(", ")}` : ""}`;
}

export async function runContextPacketsListCli(args: readonly string[]): Promise<ContextPacketsListCliResult> {
  const parsedArgs = parseArgs(args);
  if ("exitCode" in parsedArgs) {
    return parsedArgs;
  }

  let manifest: ContextPacketExampleManifest;
  try {
    manifest = filterManifest(await loadContextPacketExampleManifest(), {
      id: parsedArgs.id,
      taskType: parsedArgs.taskType
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 2,
      stdout: "",
      stderr: `Failed to load context packet example manifest: ${message}\n`
    };
  }

  if (manifest.templates.length === 0) {
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
