import { cp, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepoContext } from "../../src/index.js";

const fixtureRoot = path.resolve("tests/fixtures/simple-ts-repo");

async function createTempFixture(): Promise<string> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "scintilla-repo-scanner-"));
  const repoRoot = path.join(tempRoot, "repo");
  await cp(fixtureRoot, repoRoot, {
    recursive: true,
    verbatimSymlinks: true
  });
  return repoRoot;
}

function filePaths(snapshot: Awaited<ReturnType<typeof scanRepoContext>>): string[] {
  return snapshot.files.map((file) => file.path);
}

describe("Ariadne repo scanner", () => {
  it("scans fixture repo and finds TypeScript, JSON, and Markdown files", async () => {
    const snapshot = await scanRepoContext(fixtureRoot);

    expect(filePaths(snapshot)).toEqual(
      expect.arrayContaining(["README.md", "config.json", "package.json", "src/index.ts", "src/util.ts"])
    );
    expect(snapshot.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "README.md", extension: ".md" }),
        expect.objectContaining({ path: "config.json", extension: ".json" }),
        expect.objectContaining({ path: "src/index.ts", extension: ".ts" })
      ])
    );
  });

  it("ignores node_modules, .git, dist, and coverage directories", async () => {
    const repoRoot = await createTempFixture();
    await mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await writeFile(path.join(repoRoot, ".git/ignored"), "ignored\n", "utf8");

    const snapshot = await scanRepoContext(repoRoot);
    const paths = filePaths(snapshot);

    expect(paths).not.toContain("node_modules/ignored.js");
    expect(paths).not.toContain(".git/ignored");
    expect(paths).not.toContain("dist/ignored.js");
    expect(paths).not.toContain("coverage/ignored.json");
    expect(snapshot.ignoredDirs).toEqual(expect.arrayContaining(["node_modules", ".git", "dist", "coverage"]));
  });

  it("detects package manager and package scripts", async () => {
    const snapshot = await scanRepoContext(fixtureRoot);

    expect(snapshot.packageManager).toBe("pnpm");
    expect(snapshot.scripts).toEqual({
      build: "tsc -p tsconfig.json",
      test: "vitest run"
    });
  });

  it("does not follow symlinked files", async () => {
    const repoRoot = await createTempFixture();
    await symlink(path.join(repoRoot, "src/index.ts"), path.join(repoRoot, "src/index-link.ts"));

    const snapshot = await scanRepoContext(repoRoot);

    expect(filePaths(snapshot)).not.toContain("src/index-link.ts");
    expect(snapshot.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "symlink_skipped", path: "src/index-link.ts" })]));
  });

  it("does not follow symlinked directories", async () => {
    const repoRoot = await createTempFixture();
    await symlink(path.join(repoRoot, "src"), path.join(repoRoot, "linked-src"));

    const snapshot = await scanRepoContext(repoRoot);

    expect(filePaths(snapshot)).not.toContain("linked-src/index.ts");
    expect(snapshot.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "symlink_skipped", path: "linked-src" })]));
  });

  it("allows missing package.json", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "scintilla-repo-scanner-empty-"));
    await writeFile(path.join(repoRoot, "README.md"), "# Empty\n", "utf8");

    const snapshot = await scanRepoContext(repoRoot);

    expect(snapshot.packageManager).toBe("unknown");
    expect(snapshot.scripts).toEqual({});
    expect(filePaths(snapshot)).toEqual(["README.md"]);
  });

  it("returns deterministic file order", async () => {
    const first = await scanRepoContext(fixtureRoot);
    const second = await scanRepoContext(fixtureRoot);

    expect(filePaths(first)).toEqual([...filePaths(first)].sort((left, right) => left.localeCompare(right)));
    expect(filePaths(first)).toEqual(filePaths(second));
  });

  it("returns a structured warning for a missing root", async () => {
    const snapshot = await scanRepoContext(path.join(tmpdir(), "scintilla-missing-root"));

    expect(snapshot.files).toEqual([]);
    expect(snapshot.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "root_not_found" })]));
  });

  it("returns a structured warning for a non-directory root", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "scintilla-repo-scanner-file-"));
    const filePath = path.join(tempRoot, "not-a-directory.ts");
    await writeFile(filePath, "export const value = 1;\n", "utf8");

    const snapshot = await scanRepoContext(filePath);

    expect(snapshot.files).toEqual([]);
    expect(snapshot.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "root_not_directory" })]));
  });

  it("does not read full file contents into the snapshot", async () => {
    const snapshot = await scanRepoContext(fixtureRoot);
    const file = snapshot.files.find((entry) => entry.path === "src/index.ts");

    expect(file).toBeDefined();
    expect(file).not.toHaveProperty("content");
    expect(file).not.toHaveProperty("contents");
    expect(Object.keys(file ?? {}).sort()).toEqual(["extension", "mtimeMs", "path", "sizeBytes"]);
  });
});
