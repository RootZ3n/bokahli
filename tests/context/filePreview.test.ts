import { cp, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { previewRepoFiles } from "../../src/index.js";

const fixtureRoot = path.resolve("tests/fixtures/simple-ts-repo");

async function createTempFixture(): Promise<string> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "scintilla-file-preview-"));
  const repoRoot = path.join(tempRoot, "repo");
  await cp(fixtureRoot, repoRoot, {
    recursive: true,
    verbatimSymlinks: true
  });
  return repoRoot;
}

describe("Ariadne file preview", () => {
  it("previews selected safe files", async () => {
    const result = await previewRepoFiles(fixtureRoot, ["src/index.ts", "README.md"]);

    expect(result.skipped).toEqual([]);
    expect(result.previews).toHaveLength(2);
    expect(result.previews[0]).toMatchObject({
      path: "src/index.ts",
      extension: ".ts",
      truncated: false
    });
    expect(result.previews[0]?.text).toContain("export function run");
    expect(result.previews[1]?.text).toContain("Simple TS Repo");
  });

  it("preserves requested order", async () => {
    const result = await previewRepoFiles(fixtureRoot, ["README.md", "src/util.ts", "config.json"]);

    expect(result.previews.map((preview) => preview.path)).toEqual(["README.md", "src/util.ts", "config.json"]);
  });

  it("skips absolute paths", async () => {
    const result = await previewRepoFiles(fixtureRoot, [path.join(fixtureRoot, "README.md")]);

    expect(result.previews).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({ reason: "absolute paths are not allowed" })]);
  });

  it("skips traversal paths", async () => {
    const result = await previewRepoFiles(fixtureRoot, ["../package.json"]);

    expect(result.previews).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({ path: "../package.json", reason: "path traversal is not allowed" })]);
  });

  it("does not follow symlinked files", async () => {
    const repoRoot = await createTempFixture();
    await symlink(path.join(repoRoot, "README.md"), path.join(repoRoot, "README-link.md"));

    const result = await previewRepoFiles(repoRoot, ["README-link.md"]);

    expect(result.previews).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({ path: "README-link.md", reason: expect.stringContaining("symlinks are not followed") })]);
  });

  it("skips directories", async () => {
    const result = await previewRepoFiles(fixtureRoot, ["src"]);

    expect(result.previews).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({ path: "src", reason: "directories cannot be previewed" })]);
  });

  it("skips unsupported extensions", async () => {
    const repoRoot = await createTempFixture();
    await writeFile(path.join(repoRoot, "notes.txt"), "not allowed\n", "utf8");

    const result = await previewRepoFiles(repoRoot, ["notes.txt"]);

    expect(result.previews).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({ path: "notes.txt", reason: "unsupported extension: .txt" })]);
  });

  it("truncates files over maxBytesPerFile", async () => {
    const repoRoot = await createTempFixture();
    await writeFile(path.join(repoRoot, "large.md"), "0123456789abcdef", "utf8");

    const result = await previewRepoFiles(repoRoot, ["large.md"], {
      maxBytesPerFile: 5
    });

    expect(result.previews[0]).toMatchObject({
      path: "large.md",
      bytesRead: 5,
      truncated: true,
      text: "01234"
    });
    expect(result.totalBytesRead).toBe(5);
  });

  it("enforces maxTotalBytes by truncating then skipping deterministically", async () => {
    const repoRoot = await createTempFixture();
    await writeFile(path.join(repoRoot, "first.md"), "abcdef", "utf8");
    await writeFile(path.join(repoRoot, "second.md"), "ghijkl", "utf8");

    const result = await previewRepoFiles(repoRoot, ["first.md", "second.md", "README.md"], {
      maxBytesPerFile: 10,
      maxTotalBytes: 8
    });

    expect(result.previews.map((preview) => [preview.path, preview.bytesRead, preview.truncated])).toEqual([
      ["first.md", 6, false],
      ["second.md", 2, true]
    ]);
    expect(result.skipped).toEqual([expect.objectContaining({ path: "README.md", reason: "total byte budget exceeded" })]);
    expect(result.totalBytesRead).toBe(8);
  });

  it("returns skipped reason for missing files", async () => {
    const result = await previewRepoFiles(fixtureRoot, ["missing.md"]);

    expect(result.previews).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({ path: "missing.md", reason: "file does not exist" })]);
  });

  it("does not mutate files", async () => {
    const filePath = path.join(fixtureRoot, "README.md");
    const before = {
      contents: await readFile(filePath, "utf8"),
      mtimeMs: (await stat(filePath)).mtimeMs
    };

    await previewRepoFiles(fixtureRoot, ["README.md"]);

    const after = {
      contents: await readFile(filePath, "utf8"),
      mtimeMs: (await stat(filePath)).mtimeMs
    };
    expect(after).toEqual(before);
  });

  it("preserves duplicate requested paths deterministically", async () => {
    const result = await previewRepoFiles(fixtureRoot, ["README.md", "README.md"]);

    expect(result.previews.map((preview) => preview.path)).toEqual(["README.md", "README.md"]);
    expect(result.skipped).toEqual([]);
  });

  it("does not escape repo root through a symlink parent", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "scintilla-file-preview-escape-"));
    const repoRoot = path.join(tempRoot, "repo");
    const outsideRoot = path.join(tempRoot, "outside");
    await mkdir(repoRoot);
    await mkdir(outsideRoot);
    await writeFile(path.join(outsideRoot, "secret.md"), "outside\n", "utf8");
    await symlink(outsideRoot, path.join(repoRoot, "linked"));

    const result = await previewRepoFiles(repoRoot, ["linked/secret.md"]);

    expect(result.previews).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({ path: "linked/secret.md", reason: expect.stringContaining("symlinks are not followed") })]);
  });

  it("reads JSON, Markdown, and TypeScript preview text as UTF-8", async () => {
    const repoRoot = await createTempFixture();
    await writeFile(path.join(repoRoot, "unicode.md"), "Hello π\n", "utf8");

    const result = await previewRepoFiles(repoRoot, ["config.json", "unicode.md", "src/util.ts"]);

    expect(result.previews.map((preview) => preview.text)).toEqual([
      expect.stringContaining("\"enabled\""),
      "Hello π\n",
      expect.stringContaining("export function double")
    ]);
  });
});
