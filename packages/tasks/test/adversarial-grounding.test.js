/**
 * Adversarial grounding.
 *
 * Built from raw literals rather than the happy-path helpers in
 * `task-contracts.test.js`, because the interesting inputs are the ones a
 * well-meaning constructor would never produce: an empty quote, a citation to a
 * line that exists only because the log ended in a newline, two files at the
 * same path with different contents, a path spelled `src/./a.ts`.
 *
 * Each of these once passed. Each was a way for output that cites nothing real
 * to be reported as grounded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPathAllowed,
  validateRepoReconnaissanceRequest,
  validateRepoReconnaissanceResult,
  validateTestLogTriageResult,
} from '../dist/validate.js';

const BUDGETS = { maxContextTokens: 8192, maxOutputTokens: 1024, deadlineMs: 30_000 };
const codes = (r) => (r.valid ? [] : r.violations.map((v) => v.code));

function triageReq(logText) {
  return {
    taskClass: 'test_log_triage',
    contractVersion: '1.0.0',
    outputSchemaVersion: '1.0.0',
    logText,
    source: null,
    budgets: BUDGETS,
  };
}

function triageRes(citations) {
  return {
    taskClass: 'test_log_triage',
    contractVersion: '1.0.0',
    outputSchemaVersion: '1.0.0',
    outcome: 'ANSWERED',
    failureGroups: [
      {
        groupId: 'g1',
        classification: 'UNCLASSIFIED',
        citations,
        observed: [{ statement: 'something happened', citations }],
        probableCause: null,
        suggestedAction: null,
        affectedTests: [],
        confidence: null,
      },
    ],
    coverage: { truncated: false, omitted: [], note: null },
    abstention: null,
    escalation: null,
  };
}

const cite = (startLine, endLine, quote = null, path = null) => ({ path, startLine, endLine, quote });

// ---------------------------------------------------------------------------
// test_log_triage
// ---------------------------------------------------------------------------

test('an empty quote is refused rather than matching everything', () => {
  // `''` is a substring of every string, so an empty quote passes any
  // containment check while asserting nothing at all.
  const r = validateTestLogTriageResult(triageReq('alpha\nbravo'), triageRes([cite(1, 1, '')]));
  assert.ok(codes(r).includes('CITATION_QUOTE_MISMATCH'));
  assert.match(r.violations[0].detail, /asserts nothing/);
});

test('a log ending in a newline does not gain a phantom citable line', () => {
  // "alpha\nbravo\n".split('\n') has three elements, the last empty.
  const r = validateTestLogTriageResult(triageReq('alpha\nbravo\n'), triageRes([cite(3, 3)]));
  assert.ok(codes(r).includes('CITATION_OUT_OF_RANGE'));
  // The two real lines still work.
  assert.equal(
    validateTestLogTriageResult(triageReq('alpha\nbravo\n'), triageRes([cite(2, 2, 'bravo')])).valid,
    true,
  );
});

test('CRLF logs cite and quote correctly', () => {
  const log = 'alpha\r\nbravo\r\ncharlie';
  assert.equal(validateTestLogTriageResult(triageReq(log), triageRes([cite(2, 2, 'bravo')])).valid, true);
  const wrong = validateTestLogTriageResult(triageReq(log), triageRes([cite(1, 1, 'bravo')]));
  assert.ok(codes(wrong).includes('CITATION_QUOTE_MISMATCH'));
});

test('a real quote at the wrong line is caught', () => {
  const log = 'ERROR: boom\nall fine here\nERROR: boom';
  const wrong = validateTestLogTriageResult(triageReq(log), triageRes([cite(2, 2, 'ERROR: boom')]));
  assert.ok(codes(wrong).includes('CITATION_QUOTE_MISMATCH'));
  // Cited where it actually appears, it is accepted — twice over, since the
  // same text legitimately occurs on two lines.
  for (const line of [1, 3]) {
    assert.equal(
      validateTestLogTriageResult(triageReq(log), triageRes([cite(line, line, 'ERROR: boom')])).valid,
      true,
    );
  }
});

test('degenerate line ranges are refused', () => {
  for (const [label, c] of [
    ['reversed', cite(5, 2)],
    ['zero', cite(0, 1)],
    ['negative', cite(-3, -1)],
    ['fractional', cite(1.5, 2)],
    ['NaN', cite(NaN, NaN)],
    ['-0', cite(-0, -0)],
  ]) {
    const r = validateTestLogTriageResult(triageReq('a\nb\nc'), triageRes([c]));
    assert.ok(codes(r).includes('CITATION_MALFORMED'), `${label} must be malformed`);
  }
  const huge = validateTestLogTriageResult(triageReq('a\nb'), triageRes([cite(1, 1e308)]));
  assert.ok(codes(huge).includes('CITATION_OUT_OF_RANGE'));
});

test('multibyte text is cited by line, not by byte', () => {
  const log = 'ok: 🔥🔥🔥\nfail: 日本語のエラー\ndone';
  assert.equal(
    validateTestLogTriageResult(triageReq(log), triageRes([cite(2, 2, '日本語のエラー')])).valid,
    true,
  );
  const wrong = validateTestLogTriageResult(triageReq(log), triageRes([cite(1, 1, '日本語のエラー')]));
  assert.ok(codes(wrong).includes('CITATION_QUOTE_MISMATCH'));
});

test('overlapping and unsorted citations are each checked on their own merits', () => {
  const log = 'one\ntwo\nthree\nfour';
  const overlapping = [cite(2, 3, 'two'), cite(1, 4, 'three'), cite(3, 3, 'three')];
  assert.equal(validateTestLogTriageResult(triageReq(log), triageRes(overlapping)).valid, true);
  const oneBad = [cite(3, 3, 'three'), cite(1, 1, 'four')];
  assert.ok(
    codes(validateTestLogTriageResult(triageReq(log), triageRes(oneBad))).includes(
      'CITATION_QUOTE_MISMATCH',
    ),
  );
});

test('an answer with no citation anywhere is refused', () => {
  const res = triageRes([]);
  res.failureGroups[0].observed = [];
  const r = validateTestLogTriageResult(triageReq('a\nb'), res);
  assert.ok(codes(r).includes('CITATION_MISSING'));
});

// ---------------------------------------------------------------------------
// repo_reconnaissance
// ---------------------------------------------------------------------------

function packet(files, allowedPaths = ['src']) {
  return {
    packetId: 'pkt',
    packetHash: null,
    repoRef: null,
    commit: null,
    files,
    allowedPaths,
    truncated: false,
    omittedPaths: [],
  };
}

const file = (path, startLine, text) => ({
  path,
  contentSha256: null,
  totalLines: 100,
  excerpts: [{ startLine, endLine: startLine + text.split('\n').length - 1, text }],
});

function reconReq(p) {
  return {
    taskClass: 'repo_reconnaissance',
    contractVersion: '1.0.0',
    outputSchemaVersion: '1.0.0',
    question: 'where is X?',
    packet: p,
    budgets: BUDGETS,
  };
}

function reconRes(path, citations, filesInPacket = 1) {
  return {
    taskClass: 'repo_reconnaissance',
    contractVersion: '1.0.0',
    outputSchemaVersion: '1.0.0',
    outcome: 'ANSWERED',
    answer: 'here',
    relevantFiles: [{ path, whyRelevant: 'because', citations }],
    relevantSymbols: [],
    relationships: [],
    observed: [],
    inferences: [],
    coverage: {
      truncated: false, omitted: [], note: null,
      filesInPacket, filesExamined: 1, omittedContext: [],
    },
    abstention: null,
    escalation: null,
  };
}

test('two files at the same path are refused as ambiguous', () => {
  const p = packet([file('src/a.ts', 1, 'const SAFE = 1;'), file('src/a.ts', 1, 'const EVIL = 2;')]);
  const r = validateRepoReconnaissanceRequest(reconReq(p));
  assert.ok(codes(r).includes('MALFORMED_RESULT'));
  assert.match(r.violations[0].detail, /array position/);
});

test('aliased path spellings are refused rather than normalised', () => {
  // Each of these names the same file as "src/a.ts" while comparing as a
  // different string, which is how one packet ends up holding a file twice.
  for (const alias of ['src//a.ts', 'src/./a.ts', './src/a.ts', 'src/a.ts/']) {
    const r = validateRepoReconnaissanceRequest(reconReq(packet([file(alias, 1, 'x')])));
    assert.ok(codes(r).includes('MALFORMED_RESULT'), `${alias} must be refused`);
  }
});

test('traversal and absolute paths never resolve', () => {
  for (const bad of ['../secrets.ts', 'src/../../etc/passwd', '/etc/passwd', '~/.ssh/id_ed25519']) {
    assert.equal(isPathAllowed(bad, ['src', '/etc', '~']), false, `${bad} must not be allowed`);
  }
});

test('the allowlist matches whole segments only', () => {
  assert.equal(isPathAllowed('src/a.ts', ['src']), true);
  assert.equal(isPathAllowed('srcret/secrets.ts', ['src']), false);
  assert.equal(isPathAllowed('src', ['src']), true);
  assert.equal(isPathAllowed('SRC/a.ts', ['src']), false, 'case is not folded');
});

test('a citation into a file that was withheld is refused', () => {
  const p = {
    ...packet([file('src/a.ts', 1, 'x')]),
    omittedPaths: [{ path: 'src/secret.ts', reason: 'withheld' }],
  };
  const r = validateRepoReconnaissanceResult(
    reconReq(p),
    reconRes('src/secret.ts', [cite(1, 1, null, 'src/secret.ts')]),
  );
  assert.ok(codes(r).includes('CITATION_UNKNOWN_PATH'));
});

test('a citation past the supplied excerpt is refused even within a supplied file', () => {
  const p = packet([file('src/a.ts', 10, 'ten\neleven')]);
  const r = validateRepoReconnaissanceResult(
    reconReq(p),
    reconRes('src/a.ts', [cite(50, 51, null, 'src/a.ts')]),
  );
  assert.ok(codes(r).includes('CITATION_OUT_OF_RANGE'));
});

test('a citation spanning two adjacent excerpts is refused', () => {
  const p = packet([
    {
      path: 'src/a.ts',
      contentSha256: null,
      totalLines: 20,
      excerpts: [
        { startLine: 1, endLine: 2, text: 'one\ntwo' },
        { startLine: 3, endLine: 4, text: 'three\nfour' },
      ],
    },
  ]);
  const r = validateRepoReconnaissanceResult(
    reconReq(p),
    reconRes('src/a.ts', [cite(2, 3, null, 'src/a.ts')]),
  );
  assert.ok(codes(r).includes('CITATION_OUT_OF_RANGE'));
});

test('an excerpt whose declared range disagrees with its text is refused', () => {
  const p = packet([
    {
      path: 'src/a.ts',
      contentSha256: null,
      totalLines: 20,
      excerpts: [{ startLine: 1, endLine: 9, text: 'only one line' }],
    },
  ]);
  const r = validateRepoReconnaissanceRequest(reconReq(p));
  assert.ok(codes(r).includes('MALFORMED_RESULT'));
  assert.match(r.violations[0].detail, /wrong line/);
});

test('validation is deterministic: the same input always gives the same verdict', () => {
  const p = packet([file('src/a.ts', 1, 'const x = 1;')]);
  const res = reconRes('src/a.ts', [cite(1, 1, 'const x', 'src/a.ts')]);
  const first = JSON.stringify(validateRepoReconnaissanceResult(reconReq(p), res));
  for (let i = 0; i < 5; i++) {
    assert.equal(JSON.stringify(validateRepoReconnaissanceResult(reconReq(p), res)), first);
  }
});

test('nothing is repaired: an invalid result stays invalid and is not rewritten', () => {
  const p = packet([file('src/a.ts', 1, 'const x = 1;')]);
  const res = reconRes('src/a.ts', [cite(1, 1, 'const NOPE', 'src/a.ts')]);
  const snapshot = JSON.stringify(res);
  const r = validateRepoReconnaissanceResult(reconReq(p), res);
  assert.equal(r.valid, false);
  assert.equal(JSON.stringify(res), snapshot, 'the result object must come back untouched');
});
