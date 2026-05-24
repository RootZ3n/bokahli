#!/usr/bin/env node
import { runBenchmarksListCli } from "./benchmarks.js";
import { runCandidatesValidateCli } from "./candidates.js";

function usageError(message: string): never {
  process.stderr.write(
    `${message}\n\nUsage:\n  scintilla benchmarks list [--json]\n  scintilla benchmarks list --help\n  scintilla candidates validate --candidate <path> [--benchmark <benchmarkId>] [--json]\n  scintilla candidates validate --help\n`
  );
  process.exit(2);
}

const args = process.argv.slice(2);

const result =
  args[0] === "benchmarks" && args[1] === "list"
    ? runBenchmarksListCli(args.slice(2))
    : args[0] === "candidates" && args[1] === "validate"
      ? await runCandidatesValidateCli(args.slice(2))
      : usageError("Unknown command.");

if (result.stdout.length > 0) {
  process.stdout.write(result.stdout);
}
if (result.stderr.length > 0) {
  process.stderr.write(result.stderr);
}
process.exit(result.exitCode);
