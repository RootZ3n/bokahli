#!/usr/bin/env node
/**
 * Bokahli — write one profile file per artifact, from measured results only.
 *
 * The Stage runs need a placement to load each candidate on, and it has to be
 * the one the measurements chose rather than the one somebody remembers being
 * fast. This reads every placement result file it is given, keeps the profiles
 * that completed every run, ranks them by decode rate, and writes the winner as
 * a plan `measure-placement.mjs --swap-only` can load.
 *
 * Decode, not prefill: decode is what a caller waits through for a long answer,
 * and prefill is paid once and bounded by the context tier. A profile that did
 * not complete every run is not eligible however fast its completed runs were —
 * a rate measured over the attempts that survived is not a rate.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const outDir = argv[argv.indexOf('--out-dir') + 1];
const inputs = argv.filter((a) => a.endsWith('.json'));
if (!outDir || inputs.length === 0) {
  console.error('usage: select-profiles.mjs <placement.json>... --out-dir <dir>');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const best = new Map();
for (const p of inputs) {
  for (const r of JSON.parse(readFileSync(p, 'utf8')).results) {
    if (r.aborted || r.summary?.stable !== true) continue;
    const decode = r.summary.decodeTokensPerSecond?.median;
    if (typeof decode !== 'number') continue;
    const cur = best.get(r.profile.modelId);
    if (cur === undefined || decode > cur.decode) best.set(r.profile.modelId, { decode, r });
  }
}

for (const [modelId, { decode, r }] of best) {
  const file = join(outDir, `${modelId}.profile.json`);
  writeFileSync(file, `${JSON.stringify({ profiles: [r.profile] }, null, 2)}\n`);
  console.log(`${modelId}: ${r.profile.label}  decode ${decode.toFixed(1)} tok/s  → ${file}`);
}
if (best.size === 0) console.error('no stable profile was measured for any artifact');
