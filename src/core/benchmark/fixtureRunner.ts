import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { validateBenchmarkCandidateResult } from "./candidateValidation.js";
import { verifyConfigSingleFileEdit } from "./configSingleFileEditVerifier.js";
import { verifyContextRetrievalOnly } from "./contextRetrievalOnlyVerifier.js";
import { verifyDocsSingleFileEdit } from "./docsSingleFileEditVerifier.js";
import { verifyScopeViolationDetection } from "./scopeViolationDetectionVerifier.js";
import {
  benchmarkFixtures,
  type BenchmarkCandidateResult,
  type BenchmarkFixtureMetadata,
  type BenchmarkVerificationResult
} from "./fixtures.js";
import { benchmarkRegistry } from "./registry.js";

export interface LoadedBenchmarkFixture {
  metadata: BenchmarkFixtureMetadata;
  files: Readonly<Record<string, string>>;
}

export type BenchmarkVerifier = (
  candidate: BenchmarkCandidateResult,
  fixture: LoadedBenchmarkFixture
) => BenchmarkVerificationResult | Promise<BenchmarkVerificationResult>;

export interface BenchmarkFixtureRunnerOptions {
  fixtureRoot?: string;
  fixtures?: readonly BenchmarkFixtureMetadata[];
  verifiers?: Readonly<Record<string, BenchmarkVerifier>>;
}

const defaultVerifiers: Readonly<Record<string, BenchmarkVerifier>> = {
  configSingleFileEditVerifier: verifyConfigSingleFileEdit,
  contextRetrievalOnlyVerifier: verifyContextRetrievalOnly,
  docsSingleFileEditVerifier: verifyDocsSingleFileEdit,
  scopeViolationDetectionVerifier: verifyScopeViolationDetection
};

function failedResult(benchmarkId: string, failedChecks: string[], evidence: string[] = []): BenchmarkVerificationResult {
  return {
    ok: false,
    benchmarkId,
    passedChecks: [],
    failedChecks,
    evidence
  };
}

function resolveFixtureDir(fixtureRoot: string, fixturePath: string): string {
  return path.resolve(fixtureRoot, fixturePath);
}

function resolveFixtureFile(fixtureDir: string, relativeFilePath: string): string | undefined {
  if (path.isAbsolute(relativeFilePath) || relativeFilePath.includes("..")) {
    return undefined;
  }

  const resolvedPath = path.resolve(fixtureDir, relativeFilePath);
  const fixtureDirWithSeparator = fixtureDir.endsWith(path.sep) ? fixtureDir : `${fixtureDir}${path.sep}`;

  if (!resolvedPath.startsWith(fixtureDirWithSeparator)) {
    return undefined;
  }

  return resolvedPath;
}

async function loadFixtureFiles(metadata: BenchmarkFixtureMetadata, fixtureRoot: string): Promise<LoadedBenchmarkFixture | BenchmarkVerificationResult> {
  const fixtureDir = resolveFixtureDir(fixtureRoot, metadata.fixturePath);
  const files: Record<string, string> = {};

  try {
    const fixtureDirStats = await lstat(fixtureDir);
    if (!fixtureDirStats.isDirectory() || fixtureDirStats.isSymbolicLink()) {
      return failedResult(metadata.benchmarkId, [`fixture path is not a readable directory: ${metadata.fixturePath}`]);
    }

    for (const file of [...metadata.allowedFiles].sort()) {
      const resolvedFile = resolveFixtureFile(fixtureDir, file);
      if (resolvedFile === undefined) {
        return failedResult(metadata.benchmarkId, [`fixture allowlist file path is invalid: ${file}`]);
      }

      const fileStats = await lstat(resolvedFile);
      if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
        return failedResult(metadata.benchmarkId, [`fixture file is not a readable regular file: ${file}`]);
      }

      files[file] = await readFile(resolvedFile, "utf8");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failedResult(metadata.benchmarkId, [`failed to load fixture files for ${metadata.benchmarkId}`], [message]);
  }

  return { metadata, files };
}

export async function runBenchmarkFixture(
  benchmarkId: string,
  candidate: unknown,
  options: BenchmarkFixtureRunnerOptions = {}
): Promise<BenchmarkVerificationResult> {
  const fixtures = options.fixtures ?? benchmarkFixtures;
  const verifiers: Readonly<Record<string, BenchmarkVerifier>> = options.verifiers ?? defaultVerifiers;
  const fixtureRoot = options.fixtureRoot ?? process.cwd();
  const metadata = fixtures.find((fixture) => fixture.benchmarkId === benchmarkId);

  if (metadata === undefined) {
    const knownBenchmark = benchmarkRegistry.some((benchmark) => benchmark.id === benchmarkId);
    return failedResult(
      benchmarkId,
      [knownBenchmark ? `fixture metadata is missing for benchmark: ${benchmarkId}` : `unknown benchmark fixture: ${benchmarkId}`],
      [`available executable fixtures: ${fixtures.map((fixture) => fixture.benchmarkId).sort().join(", ") || "none"}`]
    );
  }

  const validation = validateBenchmarkCandidateResult(candidate, {
    supportedBenchmarkIds: benchmarkRegistry.map((benchmark) => benchmark.id)
  });
  const safeCandidateBenchmarkId =
    typeof candidate === "object" && candidate !== null && typeof (candidate as { benchmarkId?: unknown }).benchmarkId === "string"
      ? (candidate as { benchmarkId: string }).benchmarkId
      : benchmarkId;

  if (!validation.ok) {
    return failedResult(
      safeCandidateBenchmarkId,
      ["candidate_validation", ...validation.errors.map((error) => `${error.code}: ${error.path}`)],
      validation.errors.map((error) => error.message)
    );
  }

  if (validation.candidate.benchmarkId !== benchmarkId) {
    return failedResult(validation.candidate.benchmarkId, ["candidate_validation", `candidate benchmarkId does not match requested benchmarkId: ${benchmarkId}`], [
      `candidate benchmarkId: ${validation.candidate.benchmarkId}`,
      `requested benchmarkId: ${benchmarkId}`
    ]);
  }

  const loadedFixture = await loadFixtureFiles(metadata, fixtureRoot);
  if ("ok" in loadedFixture) {
    return loadedFixture;
  }

  const verifier = verifiers[metadata.verifierId];
  if (verifier === undefined) {
    return failedResult(benchmarkId, [`no verifier exists for benchmark: ${benchmarkId}`], [`missing verifier id: ${metadata.verifierId}`]);
  }

  const result = await verifier(validation.candidate, loadedFixture);
  return {
    ...result,
    evidence: [
      `loaded fixture ${metadata.fixturePath}`,
      `loaded fixture files: ${Object.keys(loadedFixture.files).sort().join(", ")}`,
      ...result.evidence
    ]
  };
}
