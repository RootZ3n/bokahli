#!/usr/bin/env node
/**
 * Measure how far each artifact's cited line numbers sit from the truth.
 *
 * The citation lane already reports a validity rate, but a rate collapses two
 * very different failures into one number. A model that cites unrelated lines is
 * guessing; a model whose citations are all correct-but-shifted has read the
 * evidence properly and is counting from the wrong origin. The second is worse
 * for an operator, because every citation looks plausible, resolves to a real
 * line, and points at the wrong one — the reader has no local signal that
 * anything is wrong.
 *
 * So this reports the *distribution* of (actual line - cited line) rather than a
 * pass rate. A histogram concentrated at 0 is a model that can cite. A histogram
 * concentrated anywhere else is a model that cannot, however valid its output
 * looks, and the concentration is the evidence that it is systematic rather than
 * noisy.
 *
 * The prompt states the convention explicitly — `packet "<id>" (<label>): N
 * lines, numbered from 1` — so an offset is not an ambiguity the model had to
 * resolve. It was told.
 *
 * Only citations whose quote matches exactly one line are counted. A quote that
 * appears on several lines cannot establish an offset, and one that appears
 * nowhere is a different failure (unsupported citation) already counted by the
 * citation lane. Excluding both keeps this measuring the one thing it claims to.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ROOT = join(process.env.HOME, '.local/state/bokahli/campaign');
const LUAK = join(process.env.HOME, 'repos/luak/dist/core/local/fixtures');
const DIRS = ['stage-a', 'stage-b', 'stage-a-q9b', 'stage-b-completion'];

const triage = require_(join(LUAK, 'test-log-triage.js'));
const corpora = new Map();
for (const f of triage.TEST_LOG_TRIAGE_FIXTURES) corpora.set(f.id, f.logLines);

/**
 * Velum's fence escapes `<` and `>` as `\u{3c}` / `\u{3e}` before the evidence
 * reaches the model, so a model quoting verbatim quotes the escaped form. That
 * is a faithful quote of what it was shown, and matching it against the raw
 * corpus would score a correct citation as a miss. Undo the transport before
 * comparing — the question here is where the model looked, not how the bytes
 * were framed in flight.
 */
const unescapeTransport = (s) => s
  .replaceAll('\\u{3c}', '<').replaceAll('\\u{3e}', '>')
  .replaceAll('\u{3c}', '<').replaceAll('\u{3e}', '>');

const norm = (s) => unescapeTransport(String(s)).replace(/\s+/g, ' ').trim();

const out = new Map();

for (const dir of DIRS) {
  let names;
  try { names = readdirSync(join(ROOT, dir)); } catch { continue; }
  for (const name of names.sort()) {
    if (!name.endsWith('.records.completions.json')) continue;
    const stem = name.slice(0, -'.records.completions.json'.length);
    const parts = stem.split('.');
    const regime = parts.pop();
    const suite = parts.pop();
    const artifact = parts.join('.');
    if (suite !== 'local-l1-schema-grounding') continue; // only L1 has a line-numbered corpus

    const raw = JSON.parse(readFileSync(join(ROOT, dir, name), 'utf8'));
    const comps = Array.isArray(raw) ? raw : Object.values(raw).find(Array.isArray);
    if (!comps) continue;

    const key = `${artifact} ${regime}`;
    if (!out.has(key)) out.set(key, { hist: new Map(), resolvable: 0, unresolvable: 0 });
    const acc = out.get(key);

    for (const c of comps) {
      const lines = corpora.get(c.fixtureId);
      if (!lines) continue;
      let answer;
      try { answer = JSON.parse(c.text); } catch { continue; }
      for (const g of answer.failureGroups ?? []) {
        for (const cit of g.citations ?? []) {
          if (typeof cit?.startLine !== 'number' || typeof cit?.quote !== 'string') continue;
          // The quote may span several corpus lines; anchor on its first.
          const needle = norm(cit.quote.split('\n')[0]);
          if (needle.length === 0) continue;
          const hits = [];
          for (let i = 0; i < lines.length; i++) {
            if (norm(lines[i]).includes(needle)) hits.push(i + 1); // corpus is 1-based
          }
          if (hits.length !== 1) { acc.unresolvable++; continue; }
          acc.resolvable++;
          const offset = hits[0] - cit.startLine;
          acc.hist.set(offset, (acc.hist.get(offset) ?? 0) + 1);
        }
      }
    }
  }
}

console.log('Citation line-index offset, per artifact and regime (L1 only).');
console.log("The prompt states: 'packet \"<id>\" (<label>): N lines, numbered from 1'.");
console.log('offset = actual - cited. 0 means the model honoured that convention.\n');

for (const [key, acc] of [...out.entries()].sort()) {
  const hist = [...acc.hist.entries()].sort((a, b) => a[0] - b[0]);
  const total = acc.resolvable;
  const atZero = acc.hist.get(0) ?? 0;
  const verdict = total === 0 ? 'no resolvable citations'
    : atZero === total ? 'CORRECT — every citation on the stated origin'
      : atZero === 0 ? `SYSTEMATIC — not one citation of ${total} is correctly indexed`
        : `MIXED — ${atZero}/${total} correct`;
  console.log(`${key.padEnd(40)} ${String(total).padStart(3)} resolvable  ${verdict}`);
  console.log(`${' '.repeat(40)} histogram ${JSON.stringify(Object.fromEntries(hist))}`
    + (acc.unresolvable > 0 ? `  (+${acc.unresolvable} unresolvable, not counted)` : ''));
}
