#!/usr/bin/env node
import { runBenchmarksListCli } from "./benchmarks.js";
import { runCandidatesEvaluateCli } from "./evaluate.js";
import { runCandidatesValidateCli } from "./candidates.js";
import { runExamplesListCli } from "./examples.js";
import { runAriadnePacketCli, runAriadneScanCli } from "./ariadne.js";
import { runContextPacketsListCli } from "./contextPackets.js";
import { runContractsListCli } from "./contracts.js";
import { runMockPipelineCli } from "./mockPipeline.js";
import { runMockPipelineResultsListCli } from "./mockPipelineResults.js";
import { runMockWorkerCli } from "./mockWorker.js";

function usageError(message: string): never {
  process.stderr.write(
    `${message}\n\nUsage:\n  scintilla benchmarks list [--json]\n  scintilla benchmarks list --help\n  scintilla candidates validate --candidate <path> [--benchmark <benchmarkId>] [--json]\n  scintilla candidates validate --help\n  scintilla candidates evaluate --candidate <path> --benchmark <benchmarkId> [--json]\n  scintilla candidates evaluate --help\n  scintilla examples list [--benchmark <benchmarkId>] [--json]\n  scintilla examples list --help\n  scintilla context-packets list [--id <templateId>] [--task-type <taskType>] [--json]\n  scintilla context-packets list --help\n  scintilla contracts list [--id <templateId>] [--task-type <taskType>] [--json]\n  scintilla contracts list --help\n  scintilla mock-worker run --contract <path> --context-packet <path> --scenario <scenario> [--json]\n  scintilla mock-worker run --help\n  scintilla mock-pipeline run --contract <path> --context-packet <path> --scenario <scenario> [--benchmark <benchmarkId>] [--json]\n  scintilla mock-pipeline run --help\n  scintilla mock-pipeline-results list [--benchmark <benchmarkId>] [--status <status>] [--id <resultId>] [--json]\n  scintilla mock-pipeline-results list --help\n  scintilla ariadne scan --repo <path> [--json]\n  scintilla ariadne scan --help\n  scintilla ariadne packet --repo <path> --task-type <type> --goal <text> --allowed-file <path> --select <path> [--json]\n  scintilla ariadne packet --help\n`
  );
  process.exit(2);
}

const args = process.argv.slice(2);

const result =
  args[0] === "benchmarks" && args[1] === "list"
    ? runBenchmarksListCli(args.slice(2))
    : args[0] === "candidates" && args[1] === "validate"
      ? await runCandidatesValidateCli(args.slice(2))
      : args[0] === "candidates" && args[1] === "evaluate"
        ? await runCandidatesEvaluateCli(args.slice(2))
        : args[0] === "examples" && args[1] === "list"
          ? await runExamplesListCli(args.slice(2))
          : args[0] === "context-packets" && args[1] === "list"
            ? await runContextPacketsListCli(args.slice(2))
            : args[0] === "contracts" && args[1] === "list"
              ? await runContractsListCli(args.slice(2))
              : args[0] === "mock-worker" && args[1] === "run"
                ? await runMockWorkerCli(args.slice(2))
                : args[0] === "mock-pipeline" && args[1] === "run"
                  ? await runMockPipelineCli(args.slice(2))
                  : args[0] === "mock-pipeline-results" && args[1] === "list"
                    ? await runMockPipelineResultsListCli(args.slice(2))
                    : args[0] === "ariadne" && args[1] === "scan"
                      ? await runAriadneScanCli(args.slice(2))
                      : args[0] === "ariadne" && args[1] === "packet"
                        ? await runAriadnePacketCli(args.slice(2))
                        : usageError("Unknown command.");

if (result.stdout.length > 0) {
  process.stdout.write(result.stdout);
}
if (result.stderr.length > 0) {
  process.stderr.write(result.stderr);
}
process.exit(result.exitCode);
