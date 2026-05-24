import { readFile, stat, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAriadneScanCli } from "../../src/cli/ariadne.js";
import type { RepoContextMap } from "../../src/index.js";

const fixtureRoot = "tests/fixtures/simple-ts-repo";

describe("Ariadne scan CLI", () => {
  it("ariadne scan --repo fixture exits 0", async () => {
    const result = await runAriadneScanCli(["--repo", fixtureRoot]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("root:");
  });

  it("human output includes section counts", async () => {
    const result = await runAriadneScanCli(["--repo", fixtureRoot]);

    expect(result.stdout).toContain("package manager: pnpm");
    expect(result.stdout).toContain("scripts: 2");
    expect(result.stdout).toContain("total files:");
    expect(result.stdout).toContain("section counts:");
    expect(result.stdout).toContain("  source:");
    expect(result.stdout).toContain("  tests:");
    expect(result.stdout).toContain("  docs:");
    expect(result.stdout).toContain("  config:");
    expect(result.stdout).toContain("  other:");
    expect(result.stdout).toContain("  ignoredContext:");
  });

  it("--json emits parseable RepoContextMap", async () => {
    const result = await runAriadneScanCli(["--repo", fixtureRoot, "--json"]);
    const parsed = JSON.parse(result.stdout) as RepoContextMap;

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(parsed.root).toContain("tests/fixtures/simple-ts-repo");
    expect(parsed.packageManager).toBe("pnpm");
    expect(parsed.sections.source.map((entry) => entry.path)).toEqual(expect.arrayContaining(["src/index.ts", "src/util.ts"]));
  });

  it("--help exits 0", async () => {
    const result = await runAriadneScanCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("scintilla ariadne scan");
  });

  it("missing --repo exits 2", async () => {
    const result = await runAriadneScanCli([]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--repo is required");
  });

  it("unknown flag exits 2", async () => {
    const result = await runAriadneScanCli(["--repo", fixtureRoot, "--bad"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown flag: --bad");
  });

  it("forbidden execution and model flags exit 2", async () => {
    for (const flag of ["--model", "--ollama", "--execute", "--apply"]) {
      const result = await runAriadneScanCli(["--repo", fixtureRoot, flag]);

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`${flag} is not supported by this read-only Ariadne scan command`);
    }
  });

  it("non-directory repo exits 2", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scintilla-ariadne-cli-"));
    const filePath = path.join(dir, "not-a-repo.ts");
    await writeFile(filePath, "export const value = 1;\n", "utf8");

    const result = await runAriadneScanCli(["--repo", filePath]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("root_not_directory");
  });

  it("does not mutate fixture repo", async () => {
    const packagePath = path.join(fixtureRoot, "package.json");
    const before = {
      contents: await readFile(packagePath, "utf8"),
      mtimeMs: (await stat(packagePath)).mtimeMs
    };

    await runAriadneScanCli(["--repo", fixtureRoot, "--json"]);

    const after = {
      contents: await readFile(packagePath, "utf8"),
      mtimeMs: (await stat(packagePath)).mtimeMs
    };
    expect(after).toEqual(before);
  });

  it("does not add shell execution or direct file content reads to the CLI", async () => {
    const source = await readFile("src/cli/ariadne.ts", "utf8");

    expect(source).not.toContain("child_process");
    expect(source).not.toContain("execFile");
    expect(source).not.toContain("spawn");
    expect(source).not.toContain("readFile");
  });
});
