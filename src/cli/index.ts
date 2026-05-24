#!/usr/bin/env node
import { runBenchmarksListCli } from "./benchmarks.js";

function usageError(message: string): never {
  process.stderr.write(`${message}\n\nUsage:\n  scintilla benchmarks list [--json]\n  scintilla benchmarks list --help\n`);
  process.exit(2);
}

const args = process.argv.slice(2);

if (args[0] !== "benchmarks" || args[1] !== "list") {
  usageError("Unknown command.");
}

const result = runBenchmarksListCli(args.slice(2));
if (result.stdout.length > 0) {
  process.stdout.write(result.stdout);
}
if (result.stderr.length > 0) {
  process.stderr.write(result.stderr);
}
process.exit(result.exitCode);
