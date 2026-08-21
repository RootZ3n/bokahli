#!/usr/bin/env node
/**
 * Bokahli — write each artifact's measured operational profile into the catalog.
 *
 * The catalog's `operational` block carries what the runtime is *configured*
 * with. This adds what it was *measured* to do: cold load, VRAM held, host
 * resident set, and prefill/decode rates — taken from the fastest stable
 * profile the placement campaign recorded for that artifact, and from nowhere
 * else.
 *
 * `measuredAt` stops being null at the same moment the numbers arrive, and only
 * then. An artifact with no stable measured profile keeps its nulls, because
 * null here means "nobody has timed this" and a plausible number would be worse
 * than an honest gap — a `LOCAL_MODEL_SWAP_REQUIRED` escalation quotes these to
 * a caller deciding whether a swap is worth it.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
// The catalog is named by flag, never inferred from position. Defaulting it and
// then filtering "everything else that ends in .json" made the default path its
// own input the moment nobody passed the flag.
const ci = argv.indexOf('--catalog');
const catalogPath = ci >= 0 ? argv[ci + 1] : 'catalog/artifacts.json';
// `ci + 1` is only a real index when the flag was actually given. With ci = -1
// this excluded argv[0] — silently dropping the first placement file, which is
// how Gemma 12B briefly appeared to have no stable profile when it had one.
const catalogArgIndex = ci >= 0 ? ci + 1 : -1;
const inputs = argv.filter((a, i) => a.endsWith('.json') && i !== catalogArgIndex);
if (inputs.length === 0) {
  console.error('usage: apply-operational-profiles.mjs <placement.json>... [--catalog <file>]');
  process.exit(2);
}

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

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
let changed = 0;
for (const a of catalog.artifacts) {
  const hit = best.get(a.modelId);
  if (hit === undefined) {
    console.log(`  ${a.modelId.padEnd(26)} no stable measured profile — nulls kept`);
    continue;
  }
  const { r } = hit;
  const s = r.summary;
  a.operational = {
    ...a.operational,
    servedContextTokens: r.profile.ctx,
    maxConcurrentRequests: r.profile.slots ?? 1,
    measuredAt: r.finishedAt ?? r.startedAt,
    coldLoadSeconds: Number((r.start.coldLoadMs / 1000).toFixed(2)),
    vramMiB: s.vramHeldMiB ?? null,
    hostRssGiB: s.rssBytes.median === null ? null : Number((s.rssBytes.median / 2 ** 30).toFixed(2)),
    decodeTokensPerSecond: s.decodeTokensPerSecond.median === null ? null
      : Number(s.decodeTokensPerSecond.median.toFixed(1)),
    prefillTokensPerSecond: s.prefillTokensPerSecond.median === null ? null
      : Number(s.prefillTokensPerSecond.median.toFixed(1)),
    measurementNote:
      `Measured exclusively (one model resident) on the fastest stable profile: ` +
      `${r.profile.label.split(':: ')[1]}. Prefill and decode are llama.cpp's own timings by way ` +
      `of Bokahli telemetry over ${s.decodeTokensPerSecond.n} runs, each with a distinct prompt ` +
      `prefix so nothing is served from KV cache. Cold load is the wall time of a service start, ` +
      `which returns only after /health answers and GPU placement is asserted.`,
  };
  changed += 1;
  console.log(`  ${a.modelId.padEnd(26)} cold ${a.operational.coldLoadSeconds}s  ` +
    `decode ${a.operational.decodeTokensPerSecond} t/s  vram ${a.operational.vramMiB} MiB  ` +
    `rss ${a.operational.hostRssGiB} GiB`);
}
writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`\nupdated ${changed} of ${catalog.artifacts.length} artifacts`);
