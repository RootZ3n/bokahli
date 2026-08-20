/**
 * Typed task contracts.
 *
 * The question these tests keep asking is the same one in two shapes: can this
 * claim be traced back to text the caller supplied? A triage that cites a line
 * that does not exist, a reconnaissance that cites a file it was never given, a
 * quote that is not in the span it points at — each is fluent, plausible, and
 * ungrounded, and each must be rejected on exactly that basis.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPathAllowed,
  validateRepoReconnaissanceRequest,
  validateRepoReconnaissanceResult,
  validateTestLogTriageRequest,
  validateTestLogTriageResult,
} from '../dist/validate.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const LOG = [
  'Running 3 tests',                                        // 1
  'PASS  src/auth.test.ts > signs a token',                 // 2
  'FAIL  src/db.test.ts > connects to postgres',            // 3
  '  Error: connect ECONNREFUSED 127.0.0.1:5432',           // 4
  '      at TCPConnectWrap.afterConnect (node:net:1607:16)',// 5
  'FAIL  src/db.test.ts > runs a migration',                // 6
  '  Error: connect ECONNREFUSED 127.0.0.1:5432',           // 7
  '2 failed, 1 passed',                                     // 8
].join('\n');

const BUDGETS = { maxContextTokens: 8192, maxOutputTokens: 1024, deadlineMs: 30_000 };

function triageRequest(overrides = {}) {
  return {
    taskClass: 'test_log_triage',
    contractVersion: '1.0.0',
    outputSchemaVersion: '1.0.0',
    logText: LOG,
    source: { tool: 'vitest', command: 'npm test', exitCode: 1, capturedAt: null },
    budgets: BUDGETS,
    ...overrides,
  };
}

function cite(startLine, endLine, quote = null, path = null) {
  return { path, startLine, endLine, quote };
}

function groundedTriage(overrides = {}) {
  return {
    taskClass: 'test_log_triage',
    contractVersion: '1.0.0',
    outputSchemaVersion: '1.0.0',
    outcome: 'ANSWERED',
    failureGroups: [
      {
        groupId: 'g1',
        classification: 'DEPENDENCY_OR_IMPORT_FAILURE',
        citations: [cite(4, 4, 'ECONNREFUSED 127.0.0.1:5432'), cite(7, 7)],
        observed: [
          {
            statement: 'Both failures report ECONNREFUSED against 127.0.0.1:5432',
            citations: [cite(4, 4, 'ECONNREFUSED'), cite(7, 7)],
          },
        ],
        probableCause: {
          statement: 'No PostgreSQL server was listening on the test port',
          basedOn: [cite(4, 4)],
          confidence: 0.8,
        },
        suggestedAction: {
          kind: 'CHECK_ENVIRONMENT',
          detail: 'Confirm a postgres instance is listening on 127.0.0.1:5432',
          rationale: 'Both failing tests fail at connection time, not at assertion time',
        },
        affectedTests: ['src/db.test.ts > connects to postgres', 'src/db.test.ts > runs a migration'],
        confidence: 0.85,
      },
    ],
    coverage: { truncated: false, omitted: [], note: null },
    abstention: null,
    escalation: null,
    ...overrides,
  };
}

const PACKET = {
  packetId: 'pkt-1',
  packetHash: null,
  repoRef: 'example/repo',
  commit: 'deadbeef',
  files: [
    {
      path: 'src/server.ts',
      contentSha256: null,
      totalLines: 200,
      excerpts: [
        { startLine: 10, endLine: 12, text: "import { auth } from './auth.js';\nexport function start() {\n  return auth();" },
      ],
    },
    {
      path: 'src/auth.ts',
      contentSha256: null,
      totalLines: 40,
      excerpts: [{ startLine: 1, endLine: 2, text: 'export function auth() {\n  return true;' }],
    },
  ],
  allowedPaths: ['src'],
  truncated: false,
  omittedPaths: [{ path: 'src/secrets.ts', reason: 'excluded by the caller' }],
};

function reconRequest(overrides = {}) {
  return {
    taskClass: 'repo_reconnaissance',
    contractVersion: '1.0.0',
    outputSchemaVersion: '1.0.0',
    question: 'Where is authentication wired in?',
    packet: PACKET,
    budgets: BUDGETS,
    ...overrides,
  };
}

function groundedRecon(overrides = {}) {
  return {
    taskClass: 'repo_reconnaissance',
    contractVersion: '1.0.0',
    outputSchemaVersion: '1.0.0',
    outcome: 'ANSWERED',
    answer: 'start() in src/server.ts calls auth() from src/auth.ts.',
    relevantFiles: [
      {
        path: 'src/server.ts',
        whyRelevant: 'Calls auth() from its start function',
        citations: [cite(10, 12, "import { auth }", 'src/server.ts')],
      },
    ],
    relevantSymbols: [
      { name: 'auth', kind: 'function', path: 'src/auth.ts', citations: [cite(1, 2, 'export function auth', 'src/auth.ts')] },
    ],
    relationships: [
      {
        from: 'src/server.ts',
        to: 'src/auth.ts',
        kind: 'imports',
        basis: 'OBSERVED',
        citations: [cite(10, 10, "import { auth } from './auth.js';", 'src/server.ts')],
      },
    ],
    observed: [
      { statement: 'src/server.ts imports auth from ./auth.js', citations: [cite(10, 10, null, 'src/server.ts')] },
    ],
    inferences: [
      { statement: 'Authentication is enforced at startup rather than per request', basedOn: [cite(11, 12, null, 'src/server.ts')], confidence: 0.5 },
    ],
    coverage: {
      truncated: false,
      omitted: [],
      note: null,
      filesInPacket: 2,
      filesExamined: 2,
      omittedContext: ['src/secrets.ts was withheld by the caller'],
    },
    abstention: null,
    escalation: null,
    ...overrides,
  };
}

const codes = (r) => (r.valid ? [] : r.violations.map((v) => v.code));

// ---------------------------------------------------------------------------
// test_log_triage — accepting grounded output
// ---------------------------------------------------------------------------

test('a grounded triage is accepted', () => {
  assert.equal(validateTestLogTriageRequest(triageRequest()).valid, true);
  const r = validateTestLogTriageResult(triageRequest(), groundedTriage());
  assert.equal(r.valid, true, JSON.stringify(r.violations, null, 2));
});

test('a log over the byte bound is refused, not truncated', () => {
  const r = validateTestLogTriageRequest(triageRequest({ logText: 'x'.repeat(2_000_000) }));
  assert.deepEqual(codes(r), ['INPUT_BOUND_EXCEEDED']);
});

// ---------------------------------------------------------------------------
// test_log_triage — rejecting ungrounded output
// ---------------------------------------------------------------------------

test('a failure group with no citation is rejected', () => {
  const bad = groundedTriage();
  bad.failureGroups[0].citations = [];
  assert.ok(codes(validateTestLogTriageResult(triageRequest(), bad)).includes('CITATION_MISSING'));
});

test('a citation past the end of the log is rejected', () => {
  const bad = groundedTriage();
  bad.failureGroups[0].citations = [cite(400, 401)];
  const r = validateTestLogTriageResult(triageRequest(), bad);
  assert.ok(codes(r).includes('CITATION_OUT_OF_RANGE'));
  assert.match(r.violations[0].detail, /8-line log/);
});

test('a quote that is not in the cited span is rejected', () => {
  const bad = groundedTriage();
  // Plausible, wrong, and exactly what an ungrounded model produces.
  bad.failureGroups[0].citations = [cite(4, 4, 'Error: EACCES permission denied')];
  assert.ok(codes(validateTestLogTriageResult(triageRequest(), bad)).includes('CITATION_QUOTE_MISMATCH'));
});

test('a quote from elsewhere in the log does not excuse a wrong citation', () => {
  const bad = groundedTriage();
  // Line 2 is the PASS line; the quote is real text, from the wrong line.
  bad.failureGroups[0].citations = [cite(2, 2, 'ECONNREFUSED')];
  assert.ok(codes(validateTestLogTriageResult(triageRequest(), bad)).includes('CITATION_QUOTE_MISMATCH'));
});

test('an inverted or zero line range is rejected', () => {
  const bad = groundedTriage();
  bad.failureGroups[0].citations = [cite(7, 3)];
  assert.ok(codes(validateTestLogTriageResult(triageRequest(), bad)).includes('CITATION_MALFORMED'));
  const bad2 = groundedTriage();
  bad2.failureGroups[0].citations = [cite(0, 1)];
  assert.ok(codes(validateTestLogTriageResult(triageRequest(), bad2)).includes('CITATION_MALFORMED'));
});

test('an observed fact with no citation is rejected', () => {
  const bad = groundedTriage();
  bad.failureGroups[0].observed[0].citations = [];
  const r = validateTestLogTriageResult(triageRequest(), bad);
  assert.ok(codes(r).includes('CITATION_MISSING'));
  assert.match(r.violations[0].detail, /inference that has been relabelled/);
});

test('the same statement cannot be both an observation and an inference', () => {
  const bad = groundedTriage();
  bad.failureGroups[0].probableCause.statement =
    'Both failures report ECONNREFUSED against 127.0.0.1:5432.';
  assert.ok(
    codes(validateTestLogTriageResult(triageRequest(), bad)).includes('INFERENCE_PRESENTED_AS_FACT'),
  );
});

test('a triage carrying no probable cause is still valid', () => {
  // Declining to guess at a cause is allowed; the observed facts stand alone.
  const ok = groundedTriage();
  ok.failureGroups[0].probableCause = null;
  ok.failureGroups[0].confidence = null;
  assert.equal(validateTestLogTriageResult(triageRequest(), ok).valid, true);
});

test('a confidence outside 0..1 is rejected', () => {
  const bad = groundedTriage();
  bad.failureGroups[0].confidence = 1.5;
  assert.ok(codes(validateTestLogTriageResult(triageRequest(), bad)).includes('MALFORMED_RESULT'));
});

test('an unsupported contract version is rejected', () => {
  const bad = groundedTriage({ contractVersion: '0.1.0' });
  assert.ok(
    codes(validateTestLogTriageResult(triageRequest(), bad)).includes('CONTRACT_VERSION_UNSUPPORTED'),
  );
});

// ---------------------------------------------------------------------------
// outcomes: abstention and escalation
// ---------------------------------------------------------------------------

test('an explicit abstention is accepted', () => {
  const abstained = groundedTriage({
    outcome: 'ABSTAINED',
    failureGroups: [],
    abstention: {
      reason: 'INSUFFICIENT_EVIDENCE',
      detail: 'The log records that tests failed but carries no error output.',
      wouldNeed: ['the stderr of the failing run'],
    },
  });
  assert.equal(validateTestLogTriageResult(triageRequest(), abstained).valid, true);
});

test('an abstention that declines to say why is rejected', () => {
  const bad = groundedTriage({ outcome: 'ABSTAINED', failureGroups: [], abstention: null });
  const r = validateTestLogTriageResult(triageRequest(), bad);
  assert.ok(codes(r).includes('OUTCOME_INCONSISTENT'));
  assert.match(r.violations[0].detail, /declining to say why is not/);
});

test('an abstention cannot also return findings', () => {
  const bad = groundedTriage({
    outcome: 'ABSTAINED',
    abstention: { reason: 'AMBIGUOUS_INPUT', detail: 'unclear', wouldNeed: [] },
  });
  assert.ok(codes(validateTestLogTriageResult(triageRequest(), bad)).includes('OUTCOME_INCONSISTENT'));
});

test('an explicit escalation is accepted', () => {
  const escalated = groundedTriage({
    outcome: 'ESCALATE',
    failureGroups: [],
    escalation: {
      reason: 'INPUT_EXCEEDS_BUDGET',
      detail: 'The log exceeds the context budget for this route.',
      retryableLocal: false,
    },
  });
  assert.equal(validateTestLogTriageResult(triageRequest(), escalated).valid, true);
});

test('ANSWERED with nothing to say is rejected as an outcome mismatch', () => {
  const bad = groundedTriage({ failureGroups: [] });
  const r = validateTestLogTriageResult(triageRequest(), bad);
  assert.ok(codes(r).includes('OUTCOME_INCONSISTENT'));
  assert.match(r.violations[0].detail, /abstention with reason INSUFFICIENT_EVIDENCE/);
});

// ---------------------------------------------------------------------------
// repo_reconnaissance
// ---------------------------------------------------------------------------

test('a grounded reconnaissance is accepted', () => {
  assert.equal(validateRepoReconnaissanceRequest(reconRequest()).valid, true);
  const r = validateRepoReconnaissanceResult(reconRequest(), groundedRecon());
  assert.equal(r.valid, true, JSON.stringify(r.violations, null, 2));
});

test('a citation to a file that is not in the packet is rejected', () => {
  const bad = groundedRecon();
  bad.relevantFiles[0].citations = [cite(1, 2, null, 'src/database.ts')];
  bad.relevantFiles[0].path = 'src/database.ts';
  const r = validateRepoReconnaissanceResult(reconRequest(), bad);
  assert.ok(codes(r).includes('CITATION_UNKNOWN_PATH'));
  assert.match(r.violations[0].detail, /Bokahli reads only what it was given/);
});

test('a citation outside the caller allowlist is rejected even if supplied', () => {
  const packet = {
    ...PACKET,
    files: [
      ...PACKET.files,
      { path: 'secrets/keys.ts', contentSha256: null, totalLines: 3, excerpts: [{ startLine: 1, endLine: 1, text: 'const KEY = 1;' }] },
    ],
  };
  const req = reconRequest({ packet });
  // The packet itself is now inconsistent with its allowlist, and says so.
  assert.ok(codes(validateRepoReconnaissanceRequest(req)).includes('CITATION_PATH_NOT_ALLOWED'));

  const bad = groundedRecon();
  bad.relevantFiles[0] = {
    path: 'secrets/keys.ts',
    whyRelevant: 'holds the key',
    citations: [cite(1, 1, null, 'secrets/keys.ts')],
  };
  assert.ok(
    codes(validateRepoReconnaissanceResult(req, bad)).includes('CITATION_PATH_NOT_ALLOWED'),
  );
});

test('a citation into a region of a file that was not supplied is rejected', () => {
  const bad = groundedRecon();
  // The file is in the packet, but only lines 10-12 were sent.
  bad.relevantFiles[0].citations = [cite(150, 151, null, 'src/server.ts')];
  assert.ok(codes(validateRepoReconnaissanceResult(reconRequest(), bad)).includes('CITATION_OUT_OF_RANGE'));
});

test('a citation with no path is rejected for a repository task', () => {
  const bad = groundedRecon();
  bad.relevantFiles[0].citations = [cite(10, 12)];
  assert.ok(codes(validateRepoReconnaissanceResult(reconRequest(), bad)).includes('CITATION_UNKNOWN_PATH'));
});

test('an OBSERVED relationship with no citation is rejected', () => {
  const bad = groundedRecon();
  bad.relationships[0].citations = [];
  const r = validateRepoReconnaissanceResult(reconRequest(), bad);
  assert.ok(codes(r).includes('CITATION_MISSING'));
  assert.match(r.violations[0].detail, /the basis is INFERRED/);
});

test('an INFERRED relationship may stand without a citation', () => {
  const ok = groundedRecon();
  ok.relationships[0] = { ...ok.relationships[0], basis: 'INFERRED', citations: [] };
  assert.equal(validateRepoReconnaissanceResult(reconRequest(), ok).valid, true);
});

test('an answer that cites nothing at all is rejected', () => {
  const bad = groundedRecon({ relevantFiles: [], relevantSymbols: [], observed: [] });
  const r = validateRepoReconnaissanceResult(reconRequest(), bad);
  assert.ok(codes(r).includes('CITATION_MISSING'));
  assert.match(r.violations[0].detail, /a different repository/);
});

test('coverage must describe the packet that was actually supplied', () => {
  const bad = groundedRecon();
  bad.coverage = { ...bad.coverage, filesInPacket: 99 };
  assert.ok(codes(validateRepoReconnaissanceResult(reconRequest(), bad)).includes('MALFORMED_RESULT'));
});

test('an excerpt whose declared range does not match its text is rejected', () => {
  const packet = {
    ...PACKET,
    files: [{ path: 'src/a.ts', contentSha256: null, totalLines: 9, excerpts: [{ startLine: 1, endLine: 5, text: 'one line only' }] }],
  };
  const r = validateRepoReconnaissanceRequest(reconRequest({ packet }));
  assert.ok(codes(r).includes('MALFORMED_RESULT'));
  assert.match(r.violations[0].detail, /land on the wrong line/);
});

test('an empty allowlist is rejected as ambiguous', () => {
  const r = validateRepoReconnaissanceRequest(reconRequest({ packet: { ...PACKET, allowedPaths: [] } }));
  assert.ok(codes(r).includes('MALFORMED_RESULT'));
});

test('reconnaissance abstention and escalation are accepted', () => {
  const abstained = groundedRecon({
    outcome: 'ABSTAINED',
    answer: null,
    abstention: {
      reason: 'INSUFFICIENT_EVIDENCE',
      detail: 'The packet does not include the routing layer.',
      wouldNeed: ['src/routes/**'],
    },
  });
  assert.equal(validateRepoReconnaissanceResult(reconRequest(), abstained).valid, true);

  const escalated = groundedRecon({
    outcome: 'ESCALATE',
    answer: null,
    escalation: { reason: 'CAPABILITY_UNSUPPORTED', detail: 'no local route', retryableLocal: false },
  });
  assert.equal(validateRepoReconnaissanceResult(reconRequest(), escalated).valid, true);
});

// ---------------------------------------------------------------------------
// allowlist matching
// ---------------------------------------------------------------------------

test('the allowlist matches whole path segments, never raw prefixes', () => {
  assert.equal(isPathAllowed('src/auth.ts', ['src']), true);
  assert.equal(isPathAllowed('src/a/b/c.ts', ['src/a']), true);
  assert.equal(isPathAllowed('srcret/secrets.ts', ['src']), false, 'prefix matching would leak this');
  assert.equal(isPathAllowed('other/x.ts', ['src']), false);
  assert.equal(isPathAllowed('src/../secrets.ts', ['src']), false);
  assert.equal(isPathAllowed('/etc/passwd', ['/etc']), false, 'absolute paths are never allowed');
  assert.equal(isPathAllowed('src/exact.ts', ['src/exact.ts']), true);
});
