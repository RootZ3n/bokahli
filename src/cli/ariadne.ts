import { buildRepoContextMap, type RepoContextMap } from "../core/context/repoMap.js";
import { scanRepoContext } from "../core/context/repoScanner.js";

export interface AriadneScanCliResult {
  exitCode: 0 | 2;
  stdout: string;
  stderr: string;
}

interface ParsedArgs {
  repo: string;
  json: boolean;
}

const usage = `Usage:
  scintilla ariadne scan --repo <path> [--json]
  scintilla ariadne scan --help

Options:
  --repo <path>  Repository root to scan.
  --json         Print the full repo context map as JSON.
  --help         Show this help message.`;

const forbiddenExecutionFlags = new Set(["--run", "--execute", "--model", "--ollama", "--apply"]);
const rootErrorCodes = new Set(["root_not_found", "root_lstat_failed", "root_is_symlink", "root_not_directory"]);

function usageResult(message: string): AriadneScanCliResult {
  return {
    exitCode: 2,
    stdout: "",
    stderr: `${message}\n\n${usage}\n`
  };
}

function parseArgs(args: readonly string[]): ParsedArgs | AriadneScanCliResult {
  const normalizedArgs = args.filter((arg) => arg !== "--");

  if (normalizedArgs.includes("--help")) {
    return {
      exitCode: 0,
      stdout: `${usage}\n`,
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
      return usageResult(`${arg} is not supported by this read-only Ariadne scan command.`);
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--repo") {
      const value = normalizedArgs[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return usageResult("--repo requires a repository path");
      }
      repo = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      return usageResult(`Unknown flag: ${arg}`);
    }

    return usageResult(`Unexpected argument: ${arg}`);
  }

  if (repo === undefined) {
    return usageResult("--repo is required");
  }

  return {
    repo,
    json
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
  const parsedArgs = parseArgs(args);
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
