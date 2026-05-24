export type RepoPackageManager = "pnpm" | "npm" | "yarn" | "bun" | "unknown";

export interface RepoContextFileEntry {
  readonly path: string;
  readonly extension: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

export interface RepoContextWarning {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface RepoContextSnapshot {
  readonly generatedAt: string;
  readonly root: string;
  readonly packageManager: RepoPackageManager;
  readonly scripts: Readonly<Record<string, string>>;
  readonly files: readonly RepoContextFileEntry[];
  readonly ignoredDirs: readonly string[];
  readonly warnings: readonly RepoContextWarning[];
}
