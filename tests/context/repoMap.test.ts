import { describe, expect, it } from "vitest";
import { buildRepoContextMap, type RepoContextSnapshot } from "../../src/index.js";

function file(path: string, sizeBytes = 10): RepoContextSnapshot["files"][number] {
  const extension = path.includes(".") ? path.slice(path.lastIndexOf(".")) : "";
  return {
    path,
    extension,
    sizeBytes,
    mtimeMs: 1000
  };
}

function snapshot(files: RepoContextSnapshot["files"]): RepoContextSnapshot {
  return {
    generatedAt: "2026-05-23T00:00:00.000Z",
    root: "/repo",
    packageManager: "pnpm",
    scripts: {
      build: "tsc",
      test: "vitest run"
    },
    files,
    ignoredDirs: ["node_modules", ".git", "dist"],
    warnings: [
      {
        code: "symlink_skipped",
        message: "symlink was not followed",
        path: "linked-src"
      }
    ]
  };
}

function allSectionPaths(map: ReturnType<typeof buildRepoContextMap>): string[] {
  return [
    ...map.sections.source.map((entry) => entry.path),
    ...map.sections.tests.map((entry) => entry.path),
    ...map.sections.docs.map((entry) => entry.path),
    ...map.sections.config.map((entry) => entry.path),
    ...map.sections.other.map((entry) => entry.path)
  ];
}

describe("Ariadne repo map summarizer", () => {
  it("groups source files into source", () => {
    const map = buildRepoContextMap(snapshot([file("src/index.ts"), file("lib/client.jsx")]));

    expect(map.sections.source.map((entry) => entry.path)).toEqual(["lib/client.jsx", "src/index.ts"]);
    expect(map.sections.source[0]?.reason).toContain("source code");
  });

  it("groups .test.ts files and tests paths into tests", () => {
    const map = buildRepoContextMap(snapshot([file("src/math.test.ts"), file("tests/config.json"), file("test/helper.js")]));

    expect(map.sections.tests.map((entry) => entry.path)).toEqual(["src/math.test.ts", "test/helper.js", "tests/config.json"]);
  });

  it("groups README and docs Markdown into docs", () => {
    const map = buildRepoContextMap(snapshot([file("README.md"), file("docs/USAGE.md"), file("docs/schema.json")]));

    expect(map.sections.docs.map((entry) => entry.path)).toEqual(["README.md", "docs/USAGE.md", "docs/schema.json"]);
  });

  it("groups package, tsconfig, vitest config, and config files into config", () => {
    const map = buildRepoContextMap(
      snapshot([
        file("package.json"),
        file("tsconfig.build.json"),
        file("vitest.config.ts"),
        file("eslint.config.js"),
        file("scintilla.config.json"),
        file("config/settings.json")
      ])
    );

    expect(map.sections.config.map((entry) => entry.path)).toEqual([
      "config/settings.json",
      "eslint.config.js",
      "package.json",
      "scintilla.config.json",
      "tsconfig.build.json",
      "vitest.config.ts"
    ]);
  });

  it("places every file in exactly one section", () => {
    const files = [file("src/index.ts"), file("tests/index.test.ts"), file("README.md"), file("package.json"), file("assets/data.md5")];
    const map = buildRepoContextMap(snapshot(files));
    const paths = allSectionPaths(map);

    expect(paths).toHaveLength(files.length);
    expect(new Set(paths).size).toBe(files.length);
  });

  it("orders files deterministically by path within sections", () => {
    const map = buildRepoContextMap(snapshot([file("src/z.ts"), file("src/a.ts"), file("src/m.ts")]));

    expect(map.sections.source.map((entry) => entry.path)).toEqual(["src/a.ts", "src/m.ts", "src/z.ts"]);
  });

  it("computes totals from section counts and bytes", () => {
    const map = buildRepoContextMap(
      snapshot([file("src/index.ts", 5), file("tests/index.test.ts", 7), file("README.md", 11), file("package.json", 13), file("data.txt", 17)])
    );

    expect(map.totals).toEqual({
      files: 5,
      source: 1,
      tests: 1,
      docs: 1,
      config: 1,
      other: 1,
      ignoredDirs: 3,
      totalBytes: 53
    });
  });

  it("summarizes ignored directories", () => {
    const map = buildRepoContextMap(snapshot([]));

    expect(map.sections.ignoredContext).toEqual([
      expect.objectContaining({ path: ".git", reason: expect.stringContaining("ignored") }),
      expect.objectContaining({ path: "dist", reason: expect.stringContaining("ignored") }),
      expect.objectContaining({ path: "node_modules", reason: expect.stringContaining("ignored") })
    ]);
  });

  it("preserves scanner warnings as strings", () => {
    const map = buildRepoContextMap(snapshot([]));

    expect(map.warnings).toEqual(["symlink_skipped: linked-src: symlink was not followed"]);
  });

  it("operates only on synthetic snapshots", () => {
    const map = buildRepoContextMap(snapshot([file("src/index.ts")]));

    expect(map.root).toBe("/repo");
    expect(map.sections.source[0]).toMatchObject({
      path: "src/index.ts",
      reason: expect.any(String)
    });
  });

  it("uses classification priority so tests fixture JSON classifies as tests", () => {
    const map = buildRepoContextMap(snapshot([file("tests/fixtures/config.json")]));

    expect(map.sections.tests.map((entry) => entry.path)).toEqual(["tests/fixtures/config.json"]);
    expect(map.sections.config).toEqual([]);
  });

  it("handles missing or empty snapshot files", () => {
    const map = buildRepoContextMap(snapshot([]));

    expect(map.sections.source).toEqual([]);
    expect(map.sections.tests).toEqual([]);
    expect(map.sections.docs).toEqual([]);
    expect(map.sections.config).toEqual([]);
    expect(map.sections.other).toEqual([]);
    expect(map.totals.files).toBe(0);
  });
});
