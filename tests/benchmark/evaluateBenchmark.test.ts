import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateBenchmarkCandidateFromFile,
  evaluateBenchmarkCandidateFromJsonString,
  type BenchmarkVerifier
} from "../../src/index.js";

const passingCandidate = {
  benchmarkId: "docs_single_file_edit",
  changedFiles: ["README.md"],
  fileContents: {
    "README.md": "# Fixture\n\n## Usage\nRun the default command.\n\nUse `npm run doctor` to check setup.\n"
  },
  notes: ["Diff evidence: README.md changed to mention npm run doctor."]
};

const failingCandidate = {
  benchmarkId: "docs_single_file_edit",
  changedFiles: ["README.md"],
  fileContents: {
    "README.md": "# Fixture\n\n## Usage\nRun the default command.\n"
  }
};

const passingConfigCandidate = {
  benchmarkId: "config_single_file_edit",
  changedFiles: ["scintilla.config.json"],
  fileContents: {
    "scintilla.config.json": JSON.stringify(
      {
        auditEverySteps: 3,
        allowMultiFileWorkerTasks: false,
        defaultModelTier: "tier_1"
      },
      null,
      2
    )
  },
  notes: ["Diff evidence: scintilla.config.json changed auditEverySteps."]
};

const passingContextCandidate = {
  benchmarkId: "context_retrieval_only",
  changedFiles: [],
  fileContents: {},
  evidence: [
    {
      file: "docs/ARCHITECTURE.md",
      reason: "Ariadne is the repo context keeper.",
      quote: "Ariadne is the repo context keeper."
    },
    {
      file: "src/audit/drift.ts",
      reason: "detectDrift is the drift detection function.",
      quote: "export function detectDrift"
    }
  ]
};

const passingScopeCandidate = {
  benchmarkId: "scope_violation_detection",
  changedFiles: ["src/allowed.ts", "src/forbidden.ts"],
  fileContents: {
    "src/allowed.ts": "allowed update",
    "src/forbidden.ts": "forbidden update"
  },
  audit: {
    verdict: "STOP_UNSAFE",
    reason: "src/forbidden.ts is a forbidden out-of-scope file because only src/allowed.ts was allowed.",
    flaggedFiles: ["src/forbidden.ts"]
  },
  notes: ["Audit detected forbidden scope expansion."]
};

const passingDriftCandidate = {
  benchmarkId: "drift_detection",
  changedFiles: [],
  fileContents: {},
  drift: {
    detected: true,
    summary: "Documentation and configuration disagree about audit frequency: docs say 5, config says 3.",
    expected: "Docs say audits run every 5 steps.",
    observed: "Config says auditEverySteps is 3.",
    evidenceFiles: ["docs/USAGE.md", "src/config/defaults.ts"]
  },
  evidence: [
    {
      file: "docs/USAGE.md",
      reason: "Documentation says audits run every 5 steps.",
      quote: "every 5 steps"
    },
    {
      file: "src/config/defaults.ts",
      reason: "Code default sets audit frequency to 3.",
      quote: "defaultAuditEverySteps = 3"
    }
  ]
};

async function createTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "scintilla-evaluate-benchmark-"));
}

describe("benchmark evaluation API", () => {
  it("returns ok:true for a valid JSON string passing candidate", async () => {
    const result = await evaluateBenchmarkCandidateFromJsonString("docs_single_file_edit", JSON.stringify(passingCandidate));

    expect(result.ok).toBe(true);
    expect(result.benchmarkId).toBe("docs_single_file_edit");
    expect(result.source).toBe("string");
    if (result.ok) {
      expect(result.verification.ok).toBe(true);
    }
  });

  it("returns ok:false at verify stage for valid JSON string failing candidate", async () => {
    const result = await evaluateBenchmarkCandidateFromJsonString("docs_single_file_edit", JSON.stringify(failingCandidate));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("verify");
      expect(result.verification?.ok).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ message: 'README.md must contain "npm run doctor"' })]));
    }
  });

  it("returns ok:false before verifier dispatch for malformed JSON strings", async () => {
    let verifierCalled = false;
    const verifier: BenchmarkVerifier = () => {
      verifierCalled = true;
      return {
        ok: true,
        benchmarkId: "docs_single_file_edit",
        passedChecks: [],
        failedChecks: [],
        evidence: []
      };
    };

    const result = await evaluateBenchmarkCandidateFromJsonString("docs_single_file_edit", "{ bad json", {
      fixtureRunner: {
        verifiers: {
          docsSingleFileEditVerifier: verifier
        }
      }
    });

    expect(result.ok).toBe(false);
    expect(verifierCalled).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("load");
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "json_parse_error" })]));
      expect(result.verification).toBeUndefined();
    }
  });

  it("returns ok:false before verifier dispatch for invalid candidate shape", async () => {
    let verifierCalled = false;
    const result = await evaluateBenchmarkCandidateFromJsonString(
      "docs_single_file_edit",
      JSON.stringify({
        benchmarkId: "docs_single_file_edit",
        fileContents: {
          "README.md": "Use `npm run doctor`."
        }
      }),
      {
        fixtureRunner: {
          verifiers: {
            docsSingleFileEditVerifier: () => {
              verifierCalled = true;
              return {
                ok: true,
                benchmarkId: "docs_single_file_edit",
                passedChecks: [],
                failedChecks: [],
                evidence: []
              };
            }
          }
        }
      }
    );

    expect(result.ok).toBe(false);
    expect(verifierCalled).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("validate");
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "candidate_validation_error" })]));
      expect(result.verification).toBeUndefined();
    }
  });

  it("returns ok:true for a passing file candidate", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "candidate.json");
    await writeFile(filePath, JSON.stringify(passingCandidate), "utf8");

    const result = await evaluateBenchmarkCandidateFromFile("docs_single_file_edit", filePath, {
      allowedCandidateRoots: [dir]
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe("file");
  });

  it("returns ok:true for config_single_file_edit through JSON string evaluation", async () => {
    const result = await evaluateBenchmarkCandidateFromJsonString("config_single_file_edit", JSON.stringify(passingConfigCandidate));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verification.passedChecks).toContain("auditEverySteps is exactly 3");
    }
  });

  it("returns ok:true for context_retrieval_only through JSON string evaluation", async () => {
    const result = await evaluateBenchmarkCandidateFromJsonString("context_retrieval_only", JSON.stringify(passingContextCandidate));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verification.passedChecks).toContain("changedFiles is empty");
      expect(result.verification.passedChecks).toContain("architecture evidence references Ariadne or repo context keeper");
    }
  });

  it("returns ok:true for scope_violation_detection through JSON string evaluation", async () => {
    const result = await evaluateBenchmarkCandidateFromJsonString("scope_violation_detection", JSON.stringify(passingScopeCandidate));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verification.passedChecks).toContain("audit verdict stops or rolls back unsafe work");
      expect(result.verification.passedChecks).toContain("audit flags src/forbidden.ts");
    }
  });

  it("returns ok:true for drift_detection through JSON string evaluation", async () => {
    const result = await evaluateBenchmarkCandidateFromJsonString("drift_detection", JSON.stringify(passingDriftCandidate));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verification.passedChecks).toContain("drift.detected is true");
      expect(result.verification.passedChecks).toContain("drift report mentions value 5");
    }
  });

  it("returns ok:false for malformed file candidate", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "candidate.json");
    await writeFile(filePath, "{ bad json", "utf8");

    const result = await evaluateBenchmarkCandidateFromFile("docs_single_file_edit", filePath, {
      allowedCandidateRoots: [dir]
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("load");
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "json_parse_error" })]));
    }
  });

  it("returns structured failure for unknown benchmark ids", async () => {
    const result = await evaluateBenchmarkCandidateFromJsonString("unknown_benchmark", JSON.stringify(passingCandidate));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("verify");
      expect(result.verification?.failedChecks).toContain("unknown benchmark fixture: unknown_benchmark");
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ message: "unknown benchmark fixture: unknown_benchmark" })]));
    }
  });

  it("returns mismatch failure before verifier dispatch", async () => {
    let verifierCalled = false;
    const result = await evaluateBenchmarkCandidateFromJsonString("docs_single_file_edit", JSON.stringify({ ...passingCandidate, benchmarkId: "config_single_file_edit" }), {
      fixtureRunner: {
        verifiers: {
          docsSingleFileEditVerifier: () => {
            verifierCalled = true;
            return {
              ok: true,
              benchmarkId: "docs_single_file_edit",
              passedChecks: [],
              failedChecks: [],
              evidence: []
            };
          }
        }
      }
    });

    expect(result.ok).toBe(false);
    expect(verifierCalled).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("verify");
      expect(result.verification?.failedChecks).toContain("candidate_validation");
      expect(result.verification?.failedChecks).toContain("candidate benchmarkId does not match requested benchmarkId: docs_single_file_edit");
    }
  });

  it("does not mutate candidate files", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "candidate.json");
    const contents = JSON.stringify(passingCandidate, null, 2);
    await writeFile(filePath, contents, "utf8");

    await evaluateBenchmarkCandidateFromFile("docs_single_file_edit", filePath, {
      allowedCandidateRoots: [dir]
    });

    expect(await readFile(filePath, "utf8")).toBe(contents);
  });

  it("does not call verifier when load fails", async () => {
    let verifierCalled = false;
    const result = await evaluateBenchmarkCandidateFromJsonString("docs_single_file_edit", "", {
      fixtureRunner: {
        verifiers: {
          docsSingleFileEditVerifier: () => {
            verifierCalled = true;
            return {
              ok: true,
              benchmarkId: "docs_single_file_edit",
              passedChecks: [],
              failedChecks: [],
              evidence: []
            };
          }
        }
      }
    });

    expect(result.ok).toBe(false);
    expect(verifierCalled).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("load");
      expect(result.verification).toBeUndefined();
    }
  });

  it("does not call config verifier when validation fails", async () => {
    let verifierCalled = false;
    const result = await evaluateBenchmarkCandidateFromJsonString(
      "config_single_file_edit",
      JSON.stringify({
        benchmarkId: "config_single_file_edit",
        fileContents: {
          "scintilla.config.json": passingConfigCandidate.fileContents["scintilla.config.json"]
        }
      }),
      {
        fixtureRunner: {
          verifiers: {
            configSingleFileEditVerifier: () => {
              verifierCalled = true;
              return {
                ok: true,
                benchmarkId: "config_single_file_edit",
                passedChecks: [],
                failedChecks: [],
                evidence: []
              };
            }
          }
        }
      }
    );

    expect(result.ok).toBe(false);
    expect(verifierCalled).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("validate");
    }
  });
});
