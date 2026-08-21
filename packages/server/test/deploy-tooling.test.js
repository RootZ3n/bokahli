/**
 * Hostile tests for the deployment snapshot and restore tooling.
 *
 * These exist because the previous restore script had a defect that no test
 * could have missed and none was watching for: it selected the trees to
 * preserve with `find . -mindepth 2 -maxdepth 2 -type d -name dist`, and the
 * trees live at depth three. It matched nothing. The restore still appeared to
 * work — artifacts were copied back — but the step that saved the build being
 * replaced was a silent no-op, so a failed rollback would have destroyed the
 * only copy of what it was rolling back from.
 *
 * The lesson is not "check the depth". It is that a rollback tool is only worth
 * having if something adversarial has tried to break it. So every test here
 * attacks a specific way the tooling could lie: about what it captured, about
 * what it verified, about what it preserved, or about what it left behind when
 * it failed.
 *
 * Every test runs the real scripts against a disposable deployment root and a
 * fake HOME. No live service, no real credential file and no real rollback
 * store is touched, and nothing here runs a model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SNAPSHOT = path.join(REPO, 'scripts/deploy-snapshot.sh');
const RESTORE = path.join(REPO, 'scripts/deploy-restore.sh');

/**
 * The trees, asked of the inventory itself rather than retyped or parsed out of
 * it. If the test and the tool ever disagree about the list, the test is not
 * testing the tool.
 */
const inv = (fn) => spawnSync('bash', ['-c',
  `source ${JSON.stringify(path.join(REPO, 'scripts/deploy-inventory.sh'))}; ${fn}`],
  { encoding: 'utf-8' }).stdout.trim();
const TREES = inv('inv_trees').split('\n').filter(Boolean);
const PRE_VELUM = inv('inv_revision_trees pre-velum').split('\n').filter(Boolean);
const ID_CURRENT = inv('inv_id_of "$DEPLOY_REVISION_CURRENT"');
const ID_PRE_VELUM = inv('inv_id_of pre-velum');

/** A disposable world: a bokahli-shaped deployment root, a store, a fake HOME. */
function world(t, { seed = 'orig', trees = TREES } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bokahli-deploy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repo');
  const store = path.join(dir, 'store');
  const home = path.join(dir, 'home');

  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'bokahli', version: '0.0.0-test' }));
  for (const tree of trees) {
    fs.mkdirSync(path.join(root, tree), { recursive: true });
    fs.writeFileSync(path.join(root, tree, 'index.js'), `// ${seed} ${tree}\n`);
    fs.writeFileSync(path.join(root, tree, 'index.js.map'), `{"file":"${seed}"}\n`);
    fs.mkdirSync(path.join(root, tree, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, tree, 'sub', 'deep.js'), `// ${seed} deep ${tree}\n`);
  }
  fs.mkdirSync(path.join(home, '.config/bokahli'), { recursive: true });
  for (const f of ['shared.env', 'bokahli.env', 'runtime.env']) {
    fs.writeFileSync(path.join(home, '.config/bokahli', f), `SECRET_VALUE_${f}=do-not-capture-me\n`);
  }
  return { dir, root, store, home };
}

function run(script, args, w, opts = {}) {
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: w.home, BOKAHLI_ROLLBACK_STORE: w.store, ...(opts.env || {}) },
  });
}

const snap = (w, extra = []) =>
  run(SNAPSHOT, ['--kind', 'committed-fallback', '--source', w.root, '--store', w.store, ...extra], w);
const restore = (w, which, extra = []) =>
  run(RESTORE, [which, '--root', w.root, '--store', w.store, ...extra], w);

/** Every file under a tree set, as "relpath  sha256", sorted. The oracle. */
function fingerprint(root, trees = TREES) {
  const out = [];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const a = path.join(abs, e.name), r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(a, r);
      else out.push(`${r}  ${createHash('sha256').update(fs.readFileSync(a)).digest('hex')}`);
    }
  };
  for (const tree of trees) if (fs.existsSync(path.join(root, tree))) walk(path.join(root, tree), tree);
  return out.sort().join('\n');
}

const stampOf = (w) => fs.readdirSync(w.store).filter((n) => /^\d{8}T\d{6}Z$/.test(n)).sort().at(-1);
const readRecord = (w, stamp) => JSON.parse(fs.readFileSync(path.join(w.store, stamp, 'snapshot.json'), 'utf-8'));

/** Rewrite the record and re-seal it, so only the field under test is wrong. */
function reseal(w, stamp, mutate) {
  const p = path.join(w.store, stamp, 'snapshot.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
  mutate(j);
  const text = `${JSON.stringify(j, null, 2)}\n`;
  fs.writeFileSync(p, text);
  fs.writeFileSync(`${p}.sha256`, `${createHash('sha256').update(text).digest('hex')}\n`);
}

// ─── the inventory is the single source of truth ────────────────────────────

test('the canonical inventory holds exactly the seven deployable trees', () => {
  assert.equal(TREES.length, 7);
  assert.deepEqual(TREES, [
    'packages/contracts/dist', 'packages/catalog/dist', 'packages/qualification/dist',
    'packages/tasks/dist', 'packages/runtime/dist', 'packages/velum/dist', 'packages/server/dist',
  ]);
});

test('the original depth-3 defect: discovery by depth would have found nothing', (t) => {
  // The regression, stated as the arithmetic that caused it. Every tree is at
  // depth 3; the old restore looked at depth 2 and matched zero of seven.
  for (const tree of TREES) assert.equal(tree.split('/').length, 3, tree);
  const w = world(t);
  const atDepth2 = spawnSync('find', ['.', '-mindepth', '2', '-maxdepth', '2', '-type', 'd', '-name', 'dist'],
    { cwd: w.root, encoding: 'utf-8' }).stdout.trim();
  assert.equal(atDepth2, '', 'the old expression must match nothing — that was the bug');
  const atDepth3 = spawnSync('find', ['.', '-mindepth', '3', '-maxdepth', '3', '-type', 'd', '-name', 'dist'],
    { cwd: w.root, encoding: 'utf-8' }).stdout.trim().split('\n').filter(Boolean);
  assert.equal(atDepth3.length, 7);
});

test('snapshot captures every tree and every file exactly once', (t) => {
  const w = world(t);
  const r = snap(w);
  assert.equal(r.status, 0, r.stderr);
  const stamp = stampOf(w);
  const rec = readRecord(w, stamp);
  assert.equal(rec.treeCount, 7);
  assert.equal(rec.trees.length, 7);
  assert.deepEqual(rec.trees, TREES);
  assert.equal(rec.fileCount, 7 * 3);
  const manifest = fs.readFileSync(path.join(w.store, stamp, 'manifest.sha256'), 'utf-8')
    .trim().split('\n').map((l) => l.split(/\s+/)[1]);
  assert.equal(new Set(manifest).size, manifest.length, 'no file listed twice');
  assert.equal(fingerprint(path.join(w.store, stamp, 'artifacts')), fingerprint(w.root));
});

// ─── fail-closed on a malformed artifact inventory ──────────────────────────

test('a missing artifact tree fails closed', (t) => {
  const w = world(t);
  fs.rmSync(path.join(w.root, 'packages/velum/dist'), { recursive: true });
  const r = snap(w);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /artifact tree is missing: packages\/velum\/dist/);
});

test('an extra artifact tree outside the inventory fails closed', (t) => {
  const w = world(t);
  fs.mkdirSync(path.join(w.root, 'packages/rogue/dist'), { recursive: true });
  fs.writeFileSync(path.join(w.root, 'packages/rogue/dist/x.js'), 'x');
  const r = snap(w);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unexpected artifact tree not in the inventory: packages\/rogue\/dist/);
});

test('a symlinked artifact tree fails closed', (t) => {
  const w = world(t);
  const target = path.join(w.root, 'packages/velum/dist');
  const elsewhere = path.join(w.dir, 'elsewhere');
  fs.renameSync(target, elsewhere);
  fs.symlinkSync(elsewhere, target);
  const r = snap(w);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /artifact tree is a symlink|unexpected artifact tree/);
});

test('a symlink inside a tree that escapes it fails closed', (t) => {
  const w = world(t);
  fs.writeFileSync(path.join(w.dir, 'outside.txt'), 'outside');
  fs.symlinkSync(path.join(w.dir, 'outside.txt'), path.join(w.root, 'packages/tasks/dist/escape.js'));
  const r = snap(w);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /symlink escapes its artifact tree/);
});

test('a non-directory in a tree position fails closed', (t) => {
  const w = world(t);
  fs.rmSync(path.join(w.root, 'packages/catalog/dist'), { recursive: true });
  fs.writeFileSync(path.join(w.root, 'packages/catalog/dist'), 'not a directory');
  const r = snap(w);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /is not a directory|is missing/);
});

// ─── the snapshot must be intact, and for this repository ────────────────────

test('a corrupt manifest is refused', (t) => {
  const w = world(t);
  assert.equal(snap(w).status, 0);
  const stamp = stampOf(w);
  fs.appendFileSync(path.join(w.store, stamp, 'manifest.sha256'), 'deadbeef  packages/server/dist/extra.js\n');
  const r = restore(w, stamp, ['--dry-run']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /manifest.sha256 does not match the sealed record/);
});

test('a corrupt artifact file is refused', (t) => {
  const w = world(t);
  assert.equal(snap(w).status, 0);
  const stamp = stampOf(w);
  fs.writeFileSync(path.join(w.store, stamp, 'artifacts/packages/runtime/dist/index.js'), '// tampered\n');
  const r = restore(w, stamp, ['--dry-run']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /snapshot failed verification/);
});

test('an edited record is caught by its seal', (t) => {
  const w = world(t);
  assert.equal(snap(w).status, 0);
  const stamp = stampOf(w);
  const p = path.join(w.store, stamp, 'snapshot.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
  j.sourceCommit = 'f'.repeat(40);
  fs.writeFileSync(p, `${JSON.stringify(j, null, 2)}\n`); // deliberately not re-sealed
  const r = restore(w, stamp, ['--dry-run']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /does not match its seal/);
});

test('an extra file smuggled into the artifacts is caught', (t) => {
  const w = world(t);
  assert.equal(snap(w).status, 0);
  const stamp = stampOf(w);
  fs.writeFileSync(path.join(w.store, stamp, 'artifacts/packages/server/dist/smuggled.js'), 'x');
  const r = restore(w, stamp, ['--dry-run']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /but the manifest covers/);
});

for (const [name, mutate, expected] of [
  ['schema', (j) => { j.schema = 'bokahli-deploy-snapshot/999'; }, /schema .* is not/],
  ['inventory', (j) => { j.inventoryId = '0'.repeat(64); }, /inventory this tool does not know/],
  ['repository', (j) => { j.repoName = 'luak'; }, /is for repository 'luak'/],
  ['host', (j) => { j.host = 'some-other-machine'; }, /taken on host 'some-other-machine'/],
]) {
  test(`a snapshot from another ${name} is refused`, (t) => {
    const w = world(t);
    assert.equal(snap(w).status, 0);
    const stamp = stampOf(w);
    reseal(w, stamp, mutate);
    const r = restore(w, stamp, ['--dry-run']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, expected);
  });
}

test('a manifest path that traverses out of the inventory is refused', (t) => {
  const w = world(t);
  assert.equal(snap(w).status, 0);
  const stamp = stampOf(w);
  const mp = path.join(w.store, stamp, 'manifest.sha256');
  fs.writeFileSync(mp, `${fs.readFileSync(mp, 'utf-8').trim()}\ndeadbeef  ../../../../etc/passwd\n`);
  reseal(w, stamp, (j) => {
    j.manifestSha256 = createHash('sha256').update(fs.readFileSync(mp)).digest('hex');
    j.fileCount = fs.readFileSync(mp, 'utf-8').trim().split('\n').length;
  });
  const r = restore(w, stamp, ['--dry-run']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unsafe path|outside the inventory/);
});

test('a changed environment digest is refused before anything is touched', (t) => {
  const w = world(t);
  assert.equal(snap(w).status, 0);
  const stamp = stampOf(w);
  const before = fingerprint(w.root);
  fs.writeFileSync(path.join(w.home, '.config/bokahli/bokahli.env'), 'SECRET_VALUE_bokahli.env=rotated\n');
  const r = restore(w, stamp, []);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /configuration differs from the snapshot/);
  assert.equal(fingerprint(w.root), before, 'deployed build must be untouched');
});

// ─── credentials ────────────────────────────────────────────────────────────

test('no credential value is ever captured, only digests', (t) => {
  const w = world(t);
  assert.equal(snap(w).status, 0);
  const stamp = stampOf(w);
  const blob = spawnSync('grep', ['-rl', 'do-not-capture-me', path.join(w.store, stamp)], { encoding: 'utf-8' });
  assert.equal(blob.stdout.trim(), '', 'a credential value reached the snapshot');
  const rec = readRecord(w, stamp);
  assert.equal(rec.configs.length, 3);
  for (const c of rec.configs) assert.match(c.sha256, /^[0-9a-f]{64}$/);
});

test('the snapshot directory is owner-only', (t) => {
  const w = world(t);
  assert.equal(snap(w).status, 0);
  const stamp = stampOf(w);
  assert.equal(fs.statSync(path.join(w.store, stamp)).mode & 0o777, 0o700);
});

test('--kind is mandatory, so a fallback can never pose as the running build', (t) => {
  const w = world(t);
  const r = run(SNAPSHOT, ['--source', w.root, '--store', w.store], w);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--kind is required/);
  const bad = run(SNAPSHOT, ['--kind', 'whatever', '--source', w.root, '--store', w.store], w);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /unknown --kind/);
});

// ─── the happy path, proven byte-for-byte ───────────────────────────────────

test('a full round-trip restores all seven trees byte-for-byte', (t) => {
  const w = world(t, { seed: 'good' });
  assert.equal(snap(w).status, 0);
  const stamp = stampOf(w);
  const good = fingerprint(w.root);

  for (const tree of TREES) {
    fs.writeFileSync(path.join(w.root, tree, 'index.js'), `// BROKEN ${tree}\n`);
    fs.writeFileSync(path.join(w.root, tree, 'newfile.js'), '// should not survive\n');
  }
  assert.notEqual(fingerprint(w.root), good);

  const r = restore(w, stamp, []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fingerprint(w.root), good, 'every tree must come back byte-identical');
  for (const tree of TREES) {
    assert.ok(!fs.existsSync(path.join(w.root, tree, 'newfile.js')), `${tree} kept a stale file`);
  }
  assert.match(r.stdout, /installed 7 trees/);
});

test('the displaced build is actually preserved, with its own manifest', (t) => {
  const w = world(t);
  assert.equal(snap(w).status, 0);
  const stamp = stampOf(w);
  for (const tree of TREES) fs.writeFileSync(path.join(w.root, tree, 'index.js'), `// displaced ${tree}\n`);
  const displaced = fingerprint(w.root);

  const r = restore(w, stamp, []);
  assert.equal(r.status, 0, r.stderr);

  const failed = fs.readdirSync(w.store).filter((n) => n.startsWith('failed-'));
  assert.equal(failed.length, 1, 'exactly one preserved build');
  const aside = path.join(w.store, failed[0]);

  // This is the assertion the old tooling would have failed: all seven trees,
  // not zero.
  assert.equal(fingerprint(path.join(aside, 'artifacts')), displaced);
  const man = fs.readFileSync(path.join(aside, 'manifest.sha256'), 'utf-8').trim().split('\n');
  assert.equal(man.length, 7 * 3);
  const id = fs.readFileSync(path.join(aside, 'identity.txt'), 'utf-8');
  assert.match(id, /kind=displaced-build/);
  assert.match(id, /treeCount=7/);
  assert.match(id, /manifestSha256=[0-9a-f]{64}/);
});

// ─── failure leaves the deployment alone ────────────────────────────────────

test('a snapshot swapped after its own verification cannot land', (t) => {
  // Staging is verified in the staged location, not at the source, so content
  // that changes after the snapshot check still fails before any rename.
  // The watcher fires when the FIRST tree's staging appears and edits the LAST
  // tree's source — a genuine post-verification swap.
  const w = world(t);
  assert.equal(snap(w).status, 0);
  const stamp = stampOf(w);
  const before = fingerprint(w.root);
  const firstStaging = path.join(w.root, `${TREES[0]}.deploy-staging-`);
  const victim = path.join(w.store, stamp, 'artifacts', TREES[6], 'index.js');

  return new Promise((resolve, reject) => {
    const child = spawn('bash', [RESTORE, stamp, '--root', w.root, '--store', w.store],
      { env: { ...process.env, HOME: w.home, BOKAHLI_ROLLBACK_STORE: w.store }, encoding: 'utf-8' });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    const timer = setInterval(() => {
      const hit = fs.readdirSync(w.root === '' ? '.' : path.dirname(firstStaging))
        .some((n) => n.startsWith(`${path.basename(TREES[0])}.deploy-staging-`));
      if (hit) {
        clearInterval(timer);
        try { fs.writeFileSync(victim, '// swapped after verification\n'); } catch { /* raced */ }
      }
    }, 2);
    child.on('exit', (code) => {
      clearInterval(timer);
      try {
        assert.notEqual(code, 0, 'a post-verification swap must not be installed');
        assert.match(err, /staged copy failed verification|deployed build untouched/);
        assert.equal(fingerprint(w.root), before, 'deployed build must be untouched');
        resolve();
      } catch (e) { reject(e); }
    });
  });
});

test('an unwritable destination fails without changing the deployed build', (t) => {
  const w = world(t);
  assert.equal(snap(w).status, 0);
  const stamp = stampOf(w);
  const before = fingerprint(w.root);
  const parent = path.join(w.root, 'packages/velum');
  const mode = fs.statSync(parent).mode;
  fs.chmodSync(parent, 0o500);
  try {
    const r = restore(w, stamp, []);
    assert.notEqual(r.status, 0);
    assert.equal(fingerprint(w.root), before, 'deployed build must be untouched');
  } finally {
    fs.chmodSync(parent, mode);
  }
});

test('interrupted staging leaves the deployed build byte-identical', (t) => {
  const w = world(t);
  assert.equal(snap(w).status, 0);
  const stamp = stampOf(w);
  const before = fingerprint(w.root);

  return new Promise((resolve, reject) => {
    const child = spawn('bash', [RESTORE, stamp, '--root', w.root, '--store', w.store],
      { env: { ...process.env, HOME: w.home, BOKAHLI_ROLLBACK_STORE: w.store } });
    const timer = setInterval(() => {
      const staging = fs.readdirSync(path.join(w.root, 'packages/contracts'))
        .some((n) => n.startsWith('dist.deploy-staging-'));
      if (staging) { clearInterval(timer); child.kill('SIGKILL'); }
    }, 2);
    child.on('exit', () => {
      clearInterval(timer);
      try {
        assert.equal(fingerprint(w.root), before, 'deployed build must survive a kill during staging');
        const rec = restore(w, stamp, ['--recover']);
        assert.equal(rec.status, 0, rec.stderr);
        assert.equal(fingerprint(w.root), before);
        for (const tree of TREES) {
          const sibs = fs.readdirSync(path.dirname(path.join(w.root, tree)));
          assert.ok(!sibs.some((n) => n.includes('deploy-staging')), `${tree} left staging behind`);
        }
        resolve();
      } catch (e) { reject(e); }
    });
  });
});

test('interrupted replacement is recoverable and loses nothing', (t) => {
  const w = world(t);
  assert.equal(snap(w).status, 0);
  const stamp = stampOf(w);
  for (const tree of TREES) fs.writeFileSync(path.join(w.root, tree, 'index.js'), `// live ${tree}\n`);
  const live = fingerprint(w.root);

  return new Promise((resolve, reject) => {
    const child = spawn('bash', [RESTORE, stamp, '--root', w.root, '--store', w.store],
      { env: { ...process.env, HOME: w.home, BOKAHLI_ROLLBACK_STORE: w.store } });
    const timer = setInterval(() => {
      const mid = fs.readdirSync(path.join(w.root, 'packages/contracts'))
        .some((n) => n.startsWith('dist.displaced-'));
      if (mid) { clearInterval(timer); child.kill('SIGKILL'); }
    }, 1);
    child.on('exit', () => {
      clearInterval(timer);
      try {
        // A second restore must refuse to walk past the markers.
        const blocked = restore(w, stamp, []);
        if (blocked.status === 0) {
          // The kill landed outside the rename window; the restore completed.
          assert.equal(fingerprint(w.root), fingerprint(path.join(w.store, stamp, 'artifacts')));
          return resolve();
        }
        assert.match(blocked.stderr, /interrupted|--recover/);
        const rec = restore(w, stamp, ['--recover']);
        assert.equal(rec.status, 0, rec.stderr);
        for (const tree of TREES) assert.ok(fs.existsSync(path.join(w.root, tree)), `${tree} missing after recovery`);
        // Nothing was lost: the displaced build is preserved in the store even
        // though the replacement never finished.
        const failed = fs.readdirSync(w.store).filter((n) => n.startsWith('failed-'));
        assert.equal(failed.length, 1);
        assert.equal(fingerprint(path.join(w.store, failed[0], 'artifacts')), live);
        resolve();
      } catch (e) { reject(e); }
    });
  });
});

test('concurrent invocations are refused, not interleaved', (t) => {
  const w = world(t);
  assert.equal(snap(w).status, 0);
  const lock = path.join(w.store, '.lock');
  // Hold the lock the way the scripts do, then try both tools.
  const holder = spawn('flock', [lock, '-c', 'sleep 5'], { stdio: 'ignore' });
  t.after(() => holder.kill('SIGKILL'));
  return new Promise((resolve) => setTimeout(resolve, 300)).then(() => {
    const s = snap(w);
    const r = restore(w, stampOf(w), ['--dry-run']);
    holder.kill('SIGKILL');
    assert.notEqual(s.status, 0, 'a second snapshot must be refused');
    assert.match(s.stderr, /refusing to run concurrently/);
    assert.notEqual(r.status, 0, 'a concurrent restore must be refused');
    assert.match(r.stderr, /refusing to run concurrently/);
  });
});

// ─── verification modes do not mutate ───────────────────────────────────────

test('--verify and --dry-run change nothing', (t) => {
  const w = world(t);
  assert.equal(snap(w).status, 0);
  const stamp = stampOf(w);
  const before = fingerprint(w.root);
  const storeBefore = spawnSync('find', [w.store, '-type', 'f'], { encoding: 'utf-8' }).stdout;

  const v = run(SNAPSHOT, ['--verify', stamp, '--store', w.store], w);
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /all match manifest|files:\s+21/);

  const d = restore(w, stamp, ['--dry-run']);
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /nothing copied, nothing renamed, nothing restarted/);

  assert.equal(fingerprint(w.root), before);
  assert.equal(spawnSync('find', [w.store, '-type', 'f'], { encoding: 'utf-8' }).stdout, storeBefore);
});


// ─── inventory revisions ────────────────────────────────────────────────────

test('the inventory is a registry of named revisions, each closed and ordered', () => {
  assert.equal(TREES.length, 7);
  assert.equal(PRE_VELUM.length, 6);
  assert.ok(!PRE_VELUM.includes('packages/velum/dist'));
  // pre-velum is a strict subset: a revision may drop a tree, never invent one.
  for (const t of PRE_VELUM) assert.ok(TREES.includes(t), `${t} is not in the current revision`);
  assert.notEqual(ID_CURRENT, ID_PRE_VELUM);
  assert.match(ID_CURRENT, /^[0-9a-f]{64}$/);
  assert.equal(inv('inv_revision_for_id ' + ID_PRE_VELUM), 'pre-velum');
  assert.equal(inv('inv_revision_for_id 0000 || echo REFUSED'), 'REFUSED');
});

test('an unknown --inventory is refused', (t) => {
  const w = world(t);
  const r = run(SNAPSHOT, ['--kind', 'committed-fallback', '--source', w.root,
    '--store', w.store, '--inventory', 'invented'], w);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown --inventory 'invented'/);
});

test('a six-tree source snapshots under pre-velum and is refused under the current revision', (t) => {
  const w = world(t, { trees: PRE_VELUM });
  const wrong = snap(w);
  assert.notEqual(wrong.status, 0, 'the current revision must not accept a six-tree source');
  assert.match(wrong.stderr, /artifact tree is missing: packages\/velum\/dist/);

  const right = run(SNAPSHOT, ['--kind', 'committed-fallback', '--source', w.root,
    '--store', w.store, '--inventory', 'pre-velum'], w);
  assert.equal(right.status, 0, right.stderr);
  const rec = readRecord(w, stampOf(w));
  assert.equal(rec.inventoryRevision, 'pre-velum');
  assert.equal(rec.inventoryId, ID_PRE_VELUM);
  assert.equal(rec.treeCount, 6);
  assert.equal(rec.fileCount, 6 * 3);
});

test('restoring an older revision is refused without its exact id', (t) => {
  const w = world(t);
  const src = path.join(w.dir, 'six');
  fs.cpSync(w.root, src, { recursive: true });
  fs.rmSync(path.join(src, 'packages/velum'), { recursive: true });
  assert.equal(run(SNAPSHOT, ['--kind', 'committed-fallback', '--source', src,
    '--store', w.store, '--inventory', 'pre-velum'], w).status, 0);
  const stamp = stampOf(w);
  const before = fingerprint(w.root);

  const refused = restore(w, stamp, []);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /--accept-inventory/);
  assert.equal(fingerprint(w.root), before, 'nothing may move before the id is named');

  const wrongId = restore(w, stamp, ['--accept-inventory', '0'.repeat(64)]);
  assert.notEqual(wrongId.status, 0);
  assert.equal(fingerprint(w.root), before);
});

test('an accepted older revision restores six trees and retires the seventh', (t) => {
  const w = world(t);
  const src = path.join(w.dir, 'six');
  fs.cpSync(w.root, src, { recursive: true });
  fs.rmSync(path.join(src, 'packages/velum'), { recursive: true });
  for (const tree of PRE_VELUM) fs.writeFileSync(path.join(src, tree, 'index.js'), `// fallback ${tree}\n`);
  assert.equal(run(SNAPSHOT, ['--kind', 'committed-fallback', '--source', src,
    '--store', w.store, '--inventory', 'pre-velum'], w).status, 0);
  const stamp = stampOf(w);
  const displaced = fingerprint(w.root);

  const r = restore(w, stamp, ['--accept-inventory', ID_PRE_VELUM]);
  assert.equal(r.status, 0, r.stderr);

  // Exactly the fallback, not a mixture of two revisions.
  assert.equal(fingerprint(w.root, PRE_VELUM), fingerprint(src, PRE_VELUM));
  assert.ok(!fs.existsSync(path.join(w.root, 'packages/velum/dist')), 'the retired tree must be gone');
  assert.match(r.stdout, /retired packages\/velum\/dist/);

  // And nothing was lost: all seven displaced trees are preserved.
  const aside = path.join(w.store, fs.readdirSync(w.store).find((n) => n.startsWith('failed-')));
  assert.equal(fingerprint(path.join(aside, 'artifacts')), displaced);
  assert.ok(fs.existsSync(path.join(aside, 'artifacts/packages/velum/dist')));
  const id = fs.readFileSync(path.join(aside, 'identity.txt'), 'utf-8');
  assert.match(id, /restoredRevision=pre-velum/);
  assert.match(id, /treeCount=7/);
});

test('a record whose revision name and id disagree is refused', (t) => {
  const w = world(t);
  assert.equal(snap(w).status, 0);
  const stamp = stampOf(w);
  reseal(w, stamp, (j) => { j.inventoryRevision = 'pre-velum'; }); // id still says v2-velum
  const r = restore(w, stamp, ['--dry-run']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /names revision 'pre-velum' but its id is revision 'v2-velum'/);
});

test('neither script contains a destructive Git operation', () => {
  for (const f of ['scripts/deploy-snapshot.sh', 'scripts/deploy-restore.sh', 'scripts/deploy-inventory.sh']) {
    const src = fs.readFileSync(path.join(REPO, f), 'utf-8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    for (const bad of [
      /git\s+reset/, /git\s+checkout/, /git\s+clean/, /git\s+push/,
      /git\s+branch\s+-[dD]/, /git\s+update-ref/, /git\s+tag/, /git\s+commit/,
      /rm\s+-rf\s+"?\$(ROOT|SOURCE)"?[\s/]*$/m,
    ]) {
      assert.ok(!bad.test(code), `${f} matches ${bad}`);
    }
  }
});
