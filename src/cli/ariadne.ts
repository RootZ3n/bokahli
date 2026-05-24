import { buildContextPacket, type ContextPacket, type ContextPacketPromptQuality } from "../core/context/contextPacket.js";
import { buildRepoContextMap, type RepoContextMap } from "../core/context/repoMap.js";
import { scanRepoContext } from "../core/context/repoScanner.js";

export interface AriadneScanCliResult {
  exitCode: 0 | 2;
  stdout: string;
  stderr: string;
}

export type AriadnePacketCliResult = AriadneScanCliResult;

interface ParsedScanArgs {
  repo: string;
  json: boolean;
}

interface ParsedPacketArgs {
  repo: string;
  taskType: string;
  goal: string;
  selectedPaths: string[];
  allowedFiles: string[];
  forbiddenFiles: string[];
  verificationRequired: string[];
  benchmarkId?: string;
  promptQuality?: ContextPacketPromptQuality;
  maxBytesPerFile?: number;
  maxTotalPreviewBytes?: number;
  maxPacketChars?: number;
}

const scanUsage = `Usage:
  scintilla ariadne scan --repo <path> [--json]
  scintilla ariadne scan --help

Options:
  --repo <path>  Repository root to scan.
  --json         Print the full repo context map as JSON.
  --help         Show this help message.`;

const packetUsage = `Usage:
  scintilla ariadne packet --repo <path> --task-type <type> --goal <text> --allowed-file <path> --select <path> [options]
  scintilla ariadne packet --help

Options:
  --repo <path>                     Repository root to scan.
  --task-type <type>                Task type label for the context packet.
  --goal <text>                     Task goal for the worker.
  --select <path>                   Relative path to preview. Can be repeated.
  --allowed-file <path>             Relative path allowed for the task. Can be repeated.
  --forbidden-file <path>           Relative path forbidden for the task. Can be repeated.
  --verification <text>             Verification requirement. Can be repeated.
  --benchmark <benchmarkId>         Optional benchmark id.
  --prompt-quality <P0|P1|P2|P3|P4> Optional prompt quality label.
  --max-bytes-per-file <number>     Preview byte limit per file.
  --max-total-preview-bytes <number> Total preview byte budget.
  --max-packet-chars <number>       Approximate JSON packet character budget.
  --json                            Accepted for consistency; packet output is JSON by default.
  --help                            Show this help message.`;

const forbiddenExecutionFlags = new Set(["--run", "--execute", "--model", "--ollama", "--apply"]);
const rootErrorCodes = new Set(["root_not_found", "root_lstat_failed", "root_is_symlink", "root_not_directory"]);
const promptQualities = new Set(["P0", "P1", "P2", "P3", "P4"]);

function usageResult(message: string, usage: string): AriadneScanCliResult {
  return {
    exitCode: 2,
    stdout: "",
    stderr: `${message}\n\n${usage}\n`
  };
}

function parseScanArgs(args: readonly string[]): ParsedScanArgs | AriadneScanCliResult {
  const normalizedArgs = args.filter((arg) => arg !== "--");

  if (normalizedArgs.includes("--help")) {
    return {
      exitCode: 0,
      stdout: `${scanUsage}\n`,
      stderr: ""
    };
  }

  let repo: string | undefined;
  let json = false;

  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const arg = normalizedArgs[index];
    if (arg === undefined) {
      continue;
    }

    if (forbiddenExecutionFlags.has(arg)) {
      return usageResult(`${arg} is not supported by this read-only Ariadne scan command.`, scanUsage);
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--repo") {
      const value = normalizedArgs[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return usageResult("--repo requires a repository path", scanUsage);
      }
      repo = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      return usageResult(`Unknown flag: ${arg}`, scanUsage);
    }

    return usageResult(`Unexpected argument: ${arg}`, scanUsage);
  }

  if (repo === undefined) {
    return usageResult("--repo is required", scanUsage);
  }

  return {
    repo,
    json
  };
}

function parsePositiveInteger(value: string, flag: string): number | AriadneScanCliResult {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return usageResult(`${flag} must be a positive integer`, packetUsage);
  }

  return parsed;
}

function parsePacketArgs(args: readonly string[]): ParsedPacketArgs | AriadnePacketCliResult {
  const normalizedArgs = args.filter((arg) => arg !== "--");

  if (normalizedArgs.includes("--help")) {
    return {
      exitCode: 0,
      stdout: `${packetUsage}\n`,
      stderr: ""
    };
  }

  let repo: string | undefined;
  let taskType: string | undefined;
  let goal: string | undefined;
  let benchmarkId: string | undefined;
  let promptQuality: ContextPacketPromptQuality | undefined;
  let maxBytesPerFile: number | undefined;
  let maxTotalPreviewBytes: number | undefined;
  let maxPacketChars: number | undefined;
  const selectedPaths: string[] = [];
  const allowedFiles: string[] = [];
  const forbiddenFiles: string[] = [];
  const verificationRequired: string[] = [];

  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const arg = normalizedArgs[index];
    if (arg === undefined) {
      continue;
    }

    if (forbiddenExecutionFlags.has(arg)) {
      return usageResult(`${arg} is not supported by this read-only Ariadne packet command.`, packetUsage);
    }

    if (arg === "--json") {
      continue;
    }

    const valueFlags = new Set([
      "--repo",
      "--task-type",
      "--goal",
      "--select",
      "--allowed-file",
      "--forbidden-file",
      "--verification",
      "--benchmark",
      "--prompt-quality",
      "--max-bytes-per-file",
      "--max-total-preview-bytes",
      "--max-packet-chars"
    ]);

    if (valueFlags.has(arg)) {
      const value = normalizedArgs[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return usageResult(`${arg} requires a value`, packetUsage);
      }

      if (arg === "--repo") {
        repo = value;
      } else if (arg === "--task-type") {
        taskType = value;
      } else if (arg === "--goal") {
        goal = value;
      } else if (arg === "--select") {
        selectedPaths.push(value);
      } else if (arg === "--allowed-file") {
        allowedFiles.push(value);
      } else if (arg === "--forbidden-file") {
        forbiddenFiles.push(value);
      } else if (arg === "--verification") {
        verificationRequired.push(value);
      } else if (arg === "--benchmark") {
        benchmarkId = value;
      } else if (arg === "--prompt-quality") {
        if (!promptQualities.has(value)) {
          return usageResult("--prompt-quality must be one of P0, P1, P2, P3, P4", packetUsage);
        }
        promptQuality = value as ContextPacketPromptQuality;
      } else if (arg === "--max-bytes-per-file") {
        const parsed = parsePositiveInteger(value, arg);
        if (typeof parsed !== "number") {
          return parsed;
        }
        maxBytesPerFile = parsed;
      } else if (arg === "--max-total-preview-bytes") {
        const parsed = parsePositiveInteger(value, arg);
        if (typeof parsed !== "number") {
          return parsed;
        }
        maxTotalPreviewBytes = parsed;
      } else if (arg === "--max-packet-chars") {
        const parsed = parsePositiveInteger(value, arg);
        if (typeof parsed !== "number") {
          return parsed;
        }
        maxPacketChars = parsed;
      }

      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      return usageResult(`Unknown flag: ${arg}`, packetUsage);
    }

    return usageResult(`Unexpected argument: ${arg}`, packetUsage);
  }

  if (repo === undefined) {
    return usageResult("--repo is required", packetUsage);
  }
  if (taskType === undefined) {
    return usageResult("--task-type is required", packetUsage);
  }
  if (goal === undefined) {
    return usageResult("--goal is required", packetUsage);
  }
  if (selectedPaths.length === 0) {
    return usageResult("--select is required at least once", packetUsage);
  }
  if (allowedFiles.length === 0) {
    return usageResult("--allowed-file is required at least once", packetUsage);
  }

  return {
    repo,
    taskType,
    goal,
    selectedPaths,
    allowedFiles,
    forbiddenFiles,
    verificationRequired,
    benchmarkId,
    promptQuality,
    maxBytesPerFile,
    maxTotalPreviewBytes,
    maxPacketChars
  };
}

function formatScripts(scripts: Readonly<Record<string, string>>): string[] {
  const entries = Object.entries(scripts).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return ["scripts: 0"];
  }

  return [`scripts: ${entries.length}`, ...entries.map(([name, command]) => `  ${name}: ${command}`)];
}

export function formatRepoContextMapHuman(map: RepoContextMap): string {
  const lines = [
    `root: ${map.root}`,
    `package manager: ${map.packageManager}`,
    ...formatScripts(map.scripts),
    `total files: ${map.totals.files}`,
    "section counts:",
    `  source: ${map.totals.source}`,
    `  tests: ${map.totals.tests}`,
    `  docs: ${map.totals.docs}`,
    `  config: ${map.totals.config}`,
    `  other: ${map.totals.other}`,
    `  ignoredContext: ${map.totals.ignoredDirs}`
  ];

  if (map.warnings.length > 0) {
    lines.push("warnings:");
    lines.push(...map.warnings.map((warning) => `  - ${warning}`));
  }

  return lines.join("\n");
}

export async function runAriadneScanCli(args: readonly string[]): Promise<AriadneScanCliResult> {
  const parsedArgs = parseScanArgs(args);
  if ("exitCode" in parsedArgs) {
    return parsedArgs;
  }

  const snapshot = await scanRepoContext(parsedArgs.repo);
  const rootWarnings = snapshot.warnings.filter((warning) => rootErrorCodes.has(warning.code));
  if (rootWarnings.length > 0) {
    return {
      exitCode: 2,
      stdout: parsedArgs.json ? `${JSON.stringify(buildRepoContextMap(snapshot), null, 2)}\n` : "",
      stderr: rootWarnings.map((warning) => `${warning.code}: ${warning.message}`).join("\n") + "\n"
    };
  }

  const map = buildRepoContextMap(snapshot);
  return {
    exitCode: 0,
    stdout: parsedArgs.json ? `${JSON.stringify(map, null, 2)}\n` : `${formatRepoContextMapHuman(map)}\n`,
    stderr: ""
  };
}

export async function runAriadnePacketCli(args: readonly string[]): Promise<AriadnePacketCliResult> {
  const parsedArgs = parsePacketArgs(args);
  if ("exitCode" in parsedArgs) {
    return parsedArgs;
  }

  const snapshot = await scanRepoContext(parsedArgs.repo);
  const rootWarnings = snapshot.warnings.filter((warning) => rootErrorCodes.has(warning.code));
  if (rootWarnings.length > 0) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: rootWarnings.map((warning) => `${warning.code}: ${warning.message}`).join("\n") + "\n"
    };
  }

  const repoMap = buildRepoContextMap(snapshot);
  const packet: ContextPacket = await buildContextPacket({
    repoRoot: parsedArgs.repo,
    repoMap,
    task: {
      benchmarkId: parsedArgs.benchmarkId,
      taskType: parsedArgs.taskType,
      promptQuality: parsedArgs.promptQuality,
      goal: parsedArgs.goal,
      allowedFiles: parsedArgs.allowedFiles,
      forbiddenFiles: parsedArgs.forbiddenFiles,
      verificationRequired: parsedArgs.verificationRequired
    },
    selectedPaths: parsedArgs.selectedPaths,
    budgets: {
      maxBytesPerFile: parsedArgs.maxBytesPerFile,
      maxTotalPreviewBytes: parsedArgs.maxTotalPreviewBytes,
      maxPacketChars: parsedArgs.maxPacketChars
    }
  });

  return {
    exitCode: 0,
    stdout: `${JSON.stringify(packet, null, 2)}\n`,
    stderr: ""
  };
}
