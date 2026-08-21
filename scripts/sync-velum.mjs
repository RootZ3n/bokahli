#!/usr/bin/env node
/**
 * Bokahli — vendor Velum's A32 injection engine, verbatim and pinned.
 *
 *   node scripts/sync-velum.mjs --check   (default; CI and tests)
 *   node scripts/sync-velum.mjs --sync    (re-vendor from the pinned source)
 *
 * ## Why vendored rather than depended upon
 *
 * Velum's A32 engine lives on `feature/a32-span-pike-v1`, which is not
 * published and, being a branch, is not an identity: what it names today is not
 * what it names tomorrow. A dependency on it would make Bokahli's prompt
 * injection boundary change without a Bokahli diff, which is the one property a
 * trust boundary must not have. npm is not an option either — the engine is
 * unreleased, and a floating semver range on a security-relevant matcher is the
 * same problem with a registry in front of it.
 *
 * So the sources are copied in, and every copy is bound:
 *
 *   - a sha256 per vendored file, checked on every run of the test suite;
 *   - the digest of the whole vendored set, so adding or removing a file is a
 *     failure and not a silent widening of what Bokahli compiles;
 *   - `REGISTRY_PAYLOAD_SHA256`, the digest Velum's own generator computes over
 *     its pattern rows, so a vendored registry that was edited after the copy
 *     fails here as well as there;
 *   - the source commit, when the vendored tree is at one.
 *
 * ## On `sourceCommit: null`
 *
 * The engine is vendored from a working tree whose commit does not exist yet:
 * the audit that produced these sources has not been committed, by instruction.
 * Recording a commit that is not real would be worse than recording none, so
 * the lock says `null` and `--check` still verifies every byte — content
 * digests do not need a commit to be meaningful. Once Velum's remediation
 * commit exists, `--sync` records it, and `requireCommit` in the lock flips to
 * true so that a future `null` becomes an error rather than a default.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const OUT_DIR = join(ROOT, "packages", "velum", "src", "vendor");
const LOCK = join(ROOT, "packages", "velum", "velum.lock.json");
const VELUM_REPO = process.env["BOKAHLI_VELUM_REPO"] ?? join(process.env["HOME"] ?? "", "repos/velum");

/** Bumped when the vendored layout or the lock schema changes. */
const GENERATOR_VERSION = "bokahli-velum-sync-1";

const EXPECTED_REMOTE = "git@github.com:RootZ3n/velum.git";

/**
 * Exactly these files, no more and no fewer.
 *
 * The A32 engine and the matcher underneath it. Deliberately absent: Velum's
 * `pii.ts`, `guard.ts`, `pipeline.ts` and `credential-buffer.ts`. Bokahli runs
 * on one machine for one operator and has no privacy problem to solve; vendoring
 * a redaction path would put code in the tree whose only possible use is to
 * modify the operator's own evidence.
 */
const VENDOR_ALLOWLIST = Object.freeze([
  "core/base64.ts",
  "core/bytes.ts",
  "core/pike/index.ts",
  "core/pike/program.ts",
  "core/pike/syntax.ts",
  "core/pike/vm.ts",
  "core/a32/categories.ts",
  "core/a32/detect.ts",
  "core/a32/fence.ts",
  "core/a32/index.ts",
  "core/a32/inspect.ts",
  "core/a32/normalize.ts",
  "core/a32/registry.ts",
]);

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function header(rel, commit) {
  return `/**
 * VENDORED FROM VELUM — DO NOT EDIT.
 *
 *   source: ${rel}
 *   commit: ${commit ?? "(uncommitted working tree; pinned by content digest)"}
 *   sync:   node scripts/sync-velum.mjs --sync
 *   verify: node scripts/sync-velum.mjs --check
 *
 * Edits here are erased by the next sync and fail \`--check\` before then. The
 * boundary that uses this engine is packages/server/src/trust.ts; the contract
 * it reports against is packages/contracts/src/velum.ts.
 */
`;
}

async function sourceCommit() {
  try {
    const { stdout: status } = await run("git", ["-C", VELUM_REPO, "status", "--porcelain"]);
    if (status.trim() !== "") return null; // a dirty tree has no identity
    const { stdout } = await run("git", ["-C", VELUM_REPO, "rev-parse", "HEAD"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function checkRemote() {
  try {
    const { stdout } = await run("git", ["-C", VELUM_REPO, "remote", "get-url", "origin"]);
    const url = stdout.trim();
    if (url !== EXPECTED_REMOTE) {
      throw new Error(`velum remote is ${url}, expected ${EXPECTED_REMOTE}`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("velum remote")) throw e;
    // Not a git repository, or no origin. Content digests still bind.
  }
}

/** The digest of the vendored set: names and contents, in a fixed order. */
function setDigest(files) {
  return sha256(files.map((f) => `${f.rel}${f.sha256}`).join(""));
}

async function readVendored() {
  const out = [];
  for (const rel of VENDOR_ALLOWLIST) {
    const body = await readFile(join(OUT_DIR, rel), "utf-8");
    out.push({ rel, body, sha256: sha256(body) });
  }
  // Refuse an extra file: a vendor directory nothing reviewed is a directory
  // whose contents nothing checks.
  const seen = new Set(VENDOR_ALLOWLIST);
  const walk = async (dir, prefix) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
      if (e.isDirectory()) await walk(join(dir, e.name), rel);
      else if (!seen.has(rel)) throw new Error(`unexpected file in the vendor tree: ${rel}`);
    }
  };
  await walk(OUT_DIR, "");
  return out;
}

/** Velum's own digest over its pattern rows, read out of the vendored registry. */
function registryPayloadSha256(registrySrc) {
  const m = registrySrc.match(/payloadSha256: "([0-9a-f]{64})"/);
  if (m === null) throw new Error("vendored registry has no payloadSha256; refusing an unpinnable registry");
  return m[1];
}

function detectorFacts(registrySrc) {
  const version = registrySrc.match(/REGISTRY_VERSION = "([^"]+)"/);
  const contract = registrySrc.match(/DETECTOR_CONTRACT_VERSION = "([^"]+)"/);
  const generator = registrySrc.match(/generatorVersion: "([^"]+)"/);
  const count = registrySrc.match(/patternCount: (\d+)/);
  const corrections = registrySrc.match(/correctionCount: (\d+)/);
  if (!version || !contract || !generator || !count || !corrections) {
    throw new Error("vendored registry is missing its provenance block");
  }
  // Deliberately not `generatorVersion`: that name belongs to this script, and
  // spreading Velum's into the same object silently overwrote it.
  return {
    registryVersion: version[1],
    detectorContractVersion: contract[1],
    registryGeneratorVersion: generator[1],
    patternCount: Number(count[1]),
    correctionCount: Number(corrections[1]),
  };
}

async function doSync() {
  await checkRemote();
  const commit = await sourceCommit();
  await rm(OUT_DIR, { recursive: true, force: true });
  const files = [];
  for (const rel of VENDOR_ALLOWLIST) {
    const body = await readFile(join(VELUM_REPO, "src", rel), "utf-8");
    const withHeader = header(`src/${rel}`, commit) + body;
    const dest = join(OUT_DIR, rel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, withHeader);
    files.push({ rel, body: withHeader, sha256: sha256(withHeader) });
  }
  const registry = files.find((f) => f.rel === "core/a32/registry.ts");
  const lock = {
    generatorVersion: GENERATOR_VERSION,
    remote: EXPECTED_REMOTE,
    sourceBranch: "feature/a32-span-pike-v1",
    sourceCommit: commit,
    /** Flip to true once a commit exists; then a null commit is an error. */
    requireCommit: false,
    sourcePrefix: "src",
    ...detectorFacts(registry.body),
    registryPayloadSha256: registryPayloadSha256(registry.body),
    vendorSetSha256: setDigest(files),
    files: Object.fromEntries(files.map((f) => [f.rel, { sha256: f.sha256 }])),
  };
  await writeFile(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(
    `vendored ${files.length} files from velum ${commit ?? "(working tree)"}; ` +
    `registry payload ${lock.registryPayloadSha256.slice(0, 12)}, set ${lock.vendorSetSha256.slice(0, 12)}`,
  );
}

async function doCheck() {
  const lock = JSON.parse(await readFile(LOCK, "utf-8"));
  const problems = [];
  if (lock.generatorVersion !== GENERATOR_VERSION) {
    problems.push(`lock generator ${lock.generatorVersion} != ${GENERATOR_VERSION}`);
  }
  if (lock.requireCommit === true && typeof lock.sourceCommit !== "string") {
    problems.push("lock requires a source commit and has none");
  }
  const files = await readVendored();
  for (const f of files) {
    const want = lock.files[f.rel]?.sha256;
    if (want === undefined) problems.push(`${f.rel} is vendored but not in the lock`);
    else if (want !== f.sha256) problems.push(`${f.rel} digest ${f.sha256.slice(0, 12)} != locked ${want.slice(0, 12)}`);
  }
  for (const rel of Object.keys(lock.files)) {
    if (!VENDOR_ALLOWLIST.includes(rel)) problems.push(`${rel} is locked but not on the allowlist`);
  }
  const set = setDigest(files);
  if (set !== lock.vendorSetSha256) problems.push(`vendor set digest ${set.slice(0, 12)} != locked ${String(lock.vendorSetSha256).slice(0, 12)}`);

  const registry = files.find((f) => f.rel === "core/a32/registry.ts");
  const payload = registryPayloadSha256(registry.body);
  if (payload !== lock.registryPayloadSha256) {
    problems.push(`registry payload ${payload.slice(0, 12)} != locked ${String(lock.registryPayloadSha256).slice(0, 12)}`);
  }
  const facts = detectorFacts(registry.body);
  for (const [k, v] of Object.entries(facts)) {
    if (lock[k] !== v) problems.push(`${k} is ${JSON.stringify(v)}, locked ${JSON.stringify(lock[k])}`);
  }

  if (problems.length > 0) {
    console.error("velum vendor check failed:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    `velum vendor ok: ${files.length} files, registry ${lock.registryVersion} ` +
    `(${lock.patternCount} patterns, ${lock.correctionCount} corrections), ` +
    `payload ${lock.registryPayloadSha256.slice(0, 12)}, commit ${lock.sourceCommit ?? "(none)"}`,
  );
}

const mode = process.argv.includes("--sync") ? "sync" : "check";
await (mode === "sync" ? doSync() : doCheck());
