/**
 * Grounding validation for typed task results.
 *
 * A task result is *grounded* when every claim in it can be traced to a span of
 * text the caller supplied. This module is what decides that, and it is the
 * only place in Bokahli that judges the content of a model's output.
 *
 * The distinction it enforces is narrow and mechanical, which is the point. It
 * does not assess whether an answer is insightful, well-written, or correct in
 * the world. It checks four things a machine can check without judgement:
 *
 *   1. Did the model cite anything at all?
 *   2. Does the cited span exist in what the caller sent?
 *   3. If the model quoted, does the quote actually appear there?
 *   4. Are claims presented as observation actually distinguished from claims
 *      presented as inference?
 *
 * A result that fails any of these is rejected. That is deliberately harsh: an
 * ungrounded triage of a test log is not a slightly worse triage, it is a
 * fluent guess wearing the shape of an answer, and the shape is exactly what
 * makes it dangerous.
 *
 * Nothing here reads the filesystem. `repo_reconnaissance` is validated against
 * the evidence packet the caller supplied and against nothing else; a citation
 * to a real file that is not in the packet is as invalid as a citation to a
 * file that does not exist.
 */
import {
  MAX_LOG_BYTES,
  MAX_LOG_LINES,
  MAX_PACKET_BYTES,
  MAX_PACKET_FILES,
  REPO_RECONNAISSANCE_CONTRACT_VERSION,
  TEST_LOG_TRIAGE_CONTRACT_VERSION,
  type Citation,
  type GroundingViolation,
  type Inference,
  type ObservedFact,
  type RepoEvidencePacket,
  type RepoReconnaissanceRequest,
  type RepoReconnaissanceResult,
  type TaskValidation,
  type TestLogTriageRequest,
  type TestLogTriageResult,
} from '@bokahli/contracts';

/** Output schema versions this build can produce and validate. */
export const SUPPORTED_OUTPUT_SCHEMA_VERSIONS: readonly string[] = ['1.0.0'];

class Violations {
  readonly #list: GroundingViolation[] = [];

  add(
    code: GroundingViolation['code'],
    detail: string,
    field: string | null = null,
    citation: Citation | null = null,
  ): void {
    this.#list.push({ code, detail, field, citation });
  }

  result(): TaskValidation {
    if (this.#list.length === 0) return { valid: true, violations: [] };
    return { valid: false, violations: this.#list };
  }
}

function checkVersions(
  v: Violations,
  contractVersion: string,
  expectedContract: string,
  outputSchemaVersion: string,
): void {
  if (contractVersion !== expectedContract) {
    v.add(
      'CONTRACT_VERSION_UNSUPPORTED',
      `this build implements task contract ${expectedContract}, not ${contractVersion}. ` +
        'A different contract is a different question, and results are not portable across it.',
      'contractVersion',
    );
  }
  if (!SUPPORTED_OUTPUT_SCHEMA_VERSIONS.includes(outputSchemaVersion)) {
    v.add(
      'CONTRACT_VERSION_UNSUPPORTED',
      `output schema ${outputSchemaVersion} is not one this build produces ` +
        `(${SUPPORTED_OUTPUT_SCHEMA_VERSIONS.join(', ')})`,
      'outputSchemaVersion',
    );
  }
}

function checkConfidence(v: Violations, value: number | null, field: string): void {
  if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1)) {
    v.add('MALFORMED_RESULT', `${field} must be between 0 and 1, or null`, field);
  }
}

// ---------------------------------------------------------------------------
// test_log_triage
// ---------------------------------------------------------------------------

export function validateTestLogTriageRequest(req: TestLogTriageRequest): TaskValidation {
  const v = new Violations();
  const bytes = Buffer.byteLength(req.logText, 'utf8');
  if (bytes > MAX_LOG_BYTES) {
    v.add(
      'INPUT_BOUND_EXCEEDED',
      `logText is ${bytes} bytes, over the ${MAX_LOG_BYTES}-byte bound. Bounds are ` +
        'refused rather than silently truncated: a triage of a log the caller did not ' +
        'know was cut short is worse than no triage.',
      'logText',
    );
  }
  const lines = countLines(req.logText);
  if (lines > MAX_LOG_LINES) {
    v.add('INPUT_BOUND_EXCEEDED', `logText is ${lines} lines, over the ${MAX_LOG_LINES}-line bound`, 'logText');
  }
  if (req.logText.length === 0) {
    v.add('MALFORMED_RESULT', 'logText must not be empty', 'logText');
  }
  for (const [k, val] of Object.entries(req.budgets)) {
    if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) {
      v.add('MALFORMED_RESULT', `budgets.${k} must be a positive number`, `budgets.${k}`);
    }
  }
  return v.result();
}

/**
 * Validate a triage result against the exact log it was produced from.
 *
 * The request is required, not optional: a citation can only be checked against
 * the text it points into, and validating a result without its input would be
 * checking its shape while assuming the very thing at issue.
 */
export function validateTestLogTriageResult(
  req: TestLogTriageRequest,
  res: TestLogTriageResult,
): TaskValidation {
  const v = new Violations();
  checkVersions(v, res.contractVersion, TEST_LOG_TRIAGE_CONTRACT_VERSION, res.outputSchemaVersion);

  if (res.taskClass !== 'test_log_triage') {
    v.add('MALFORMED_RESULT', 'taskClass must be test_log_triage', 'taskClass');
  }

  const logLines = req.logText.split('\n');
  const cite = (c: Citation, field: string): void => checkLogCitation(v, c, logLines, field);

  // Outcome consistency. Each outcome makes a different promise, and a result
  // that makes two of them at once is not interpretable.
  switch (res.outcome) {
    case 'ANSWERED':
      if (res.failureGroups.length === 0) {
        v.add(
          'OUTCOME_INCONSISTENT',
          'outcome is ANSWERED but no failure group was returned. A log with nothing wrong ' +
            'in it is an abstention with reason INSUFFICIENT_EVIDENCE, not an empty answer.',
          'failureGroups',
        );
      }
      if (res.abstention !== null) {
        v.add('OUTCOME_INCONSISTENT', 'outcome is ANSWERED but an abstention was also returned', 'abstention');
      }
      if (res.escalation !== null) {
        v.add('OUTCOME_INCONSISTENT', 'outcome is ANSWERED but an escalation was also returned', 'escalation');
      }
      break;
    case 'ABSTAINED':
      if (res.abstention === null) {
        v.add(
          'OUTCOME_INCONSISTENT',
          'outcome is ABSTAINED but no abstention was given. Declining to answer is ' +
            'legitimate; declining to say why is not.',
          'abstention',
        );
      }
      if (res.failureGroups.length > 0) {
        v.add('OUTCOME_INCONSISTENT', 'outcome is ABSTAINED but failure groups were returned', 'failureGroups');
      }
      break;
    case 'ESCALATE':
      if (res.escalation === null) {
        v.add('OUTCOME_INCONSISTENT', 'outcome is ESCALATE but no escalation was given', 'escalation');
      }
      if (res.failureGroups.length > 0) {
        v.add('OUTCOME_INCONSISTENT', 'outcome is ESCALATE but failure groups were returned', 'failureGroups');
      }
      break;
    default:
      v.add('MALFORMED_RESULT', `unknown outcome: ${String(res.outcome)}`, 'outcome');
  }

  const seenGroupIds = new Set<string>();
  res.failureGroups.forEach((g, i) => {
    const at = `failureGroups[${i}]`;
    if (!g.groupId) v.add('MALFORMED_RESULT', `${at}.groupId is required`, `${at}.groupId`);
    else if (seenGroupIds.has(g.groupId)) {
      v.add('MALFORMED_RESULT', `${at}.groupId is duplicated`, `${at}.groupId`);
    } else seenGroupIds.add(g.groupId);

    if (g.citations.length === 0) {
      v.add(
        'CITATION_MISSING',
        `${at} cites nothing. Every failure group must point at the lines it is about — ` +
          'a classification with no span behind it cannot be checked by the person who has to act on it.',
        `${at}.citations`,
      );
    }
    g.citations.forEach((c, j) => cite(c, `${at}.citations[${j}]`));

    checkObserved(v, g.observed, `${at}.observed`, cite);
    if (g.probableCause) checkInference(v, g.probableCause, `${at}.probableCause`, cite);
    checkConfidence(v, g.confidence, `${at}.confidence`);
    checkFactInferenceSeparation(v, g.observed, g.probableCause ? [g.probableCause] : [], at);
  });

  return v.result();
}

function checkLogCitation(v: Violations, c: Citation, lines: readonly string[], field: string): void {
  if (c.path !== null) {
    v.add(
      'CITATION_UNKNOWN_PATH',
      'a test-log citation has no path: there is exactly one document, the supplied log',
      field,
      c,
    );
    return;
  }
  if (!checkRange(v, c, field)) return;
  if (c.endLine > lines.length) {
    v.add(
      'CITATION_OUT_OF_RANGE',
      `cites lines ${c.startLine}-${c.endLine} of a ${lines.length}-line log`,
      field,
      c,
    );
    return;
  }
  checkQuote(v, c, lines.slice(c.startLine - 1, c.endLine).join('\n'), field);
}

// ---------------------------------------------------------------------------
// repo_reconnaissance
// ---------------------------------------------------------------------------

export function validateRepoReconnaissanceRequest(req: RepoReconnaissanceRequest): TaskValidation {
  const v = new Violations();
  const p = req.packet;

  if (!req.question) v.add('MALFORMED_RESULT', 'question must not be empty', 'question');
  if (!p.packetId) v.add('MALFORMED_RESULT', 'packet.packetId is required', 'packet.packetId');

  if (p.files.length > MAX_PACKET_FILES) {
    v.add(
      'INPUT_BOUND_EXCEEDED',
      `packet carries ${p.files.length} files, over the ${MAX_PACKET_FILES} bound`,
      'packet.files',
    );
  }
  let bytes = 0;
  for (const f of p.files) for (const e of f.excerpts) bytes += Buffer.byteLength(e.text, 'utf8');
  if (bytes > MAX_PACKET_BYTES) {
    v.add(
      'INPUT_BOUND_EXCEEDED',
      `packet excerpts total ${bytes} bytes, over the ${MAX_PACKET_BYTES} bound`,
      'packet.files',
    );
  }

  if (p.allowedPaths.length === 0) {
    v.add(
      'MALFORMED_RESULT',
      'packet.allowedPaths must not be empty. An empty allowlist is ambiguous between ' +
        '"everything" and "nothing", and the safe reading of an ambiguous allowlist is ' +
        'not one a caller should have to guess at.',
      'packet.allowedPaths',
    );
  }

  p.files.forEach((f, i) => {
    if (!f.path) {
      v.add('MALFORMED_RESULT', `packet.files[${i}].path is required`, `packet.files[${i}].path`);
      return;
    }
    if (!isSafeRelativePath(f.path)) {
      v.add(
        'MALFORMED_RESULT',
        `packet.files[${i}].path must be a relative path without ".." segments`,
        `packet.files[${i}].path`,
      );
    }
    if (!isPathAllowed(f.path, p.allowedPaths)) {
      v.add(
        'CITATION_PATH_NOT_ALLOWED',
        `packet.files[${i}].path is outside packet.allowedPaths — the packet contradicts its own allowlist`,
        `packet.files[${i}].path`,
      );
    }
    f.excerpts.forEach((e, j) => {
      const at = `packet.files[${i}].excerpts[${j}]`;
      if (!Number.isInteger(e.startLine) || e.startLine < 1 || e.endLine < e.startLine) {
        v.add('MALFORMED_RESULT', `${at} has an invalid line range`, at);
        return;
      }
      const supplied = e.text.split('\n').length;
      const declared = e.endLine - e.startLine + 1;
      if (supplied !== declared) {
        v.add(
          'MALFORMED_RESULT',
          `${at} declares lines ${e.startLine}-${e.endLine} (${declared} lines) but carries ${supplied}. ` +
            'A citation into this excerpt would land on the wrong line.',
          at,
        );
      }
    });
  });

  return v.result();
}

export function validateRepoReconnaissanceResult(
  req: RepoReconnaissanceRequest,
  res: RepoReconnaissanceResult,
): TaskValidation {
  const v = new Violations();
  checkVersions(v, res.contractVersion, REPO_RECONNAISSANCE_CONTRACT_VERSION, res.outputSchemaVersion);

  if (res.taskClass !== 'repo_reconnaissance') {
    v.add('MALFORMED_RESULT', 'taskClass must be repo_reconnaissance', 'taskClass');
  }

  const packet = req.packet;
  const cite = (c: Citation, field: string): void => checkPacketCitation(v, c, packet, field);

  switch (res.outcome) {
    case 'ANSWERED': {
      if (res.answer === null || res.answer.length === 0) {
        v.add('OUTCOME_INCONSISTENT', 'outcome is ANSWERED but no answer was given', 'answer');
      }
      const anyCitation =
        res.relevantFiles.some((f) => f.citations.length > 0) ||
        res.relevantSymbols.some((s) => s.citations.length > 0) ||
        res.observed.some((o) => o.citations.length > 0);
      if (!anyCitation) {
        v.add(
          'CITATION_MISSING',
          'outcome is ANSWERED but nothing in the result cites the evidence packet. An ' +
            'answer about a repository that points at none of the supplied text is ' +
            'indistinguishable from an answer about a different repository.',
          'relevantFiles',
        );
      }
      if (res.abstention !== null) {
        v.add('OUTCOME_INCONSISTENT', 'outcome is ANSWERED but an abstention was also returned', 'abstention');
      }
      if (res.escalation !== null) {
        v.add('OUTCOME_INCONSISTENT', 'outcome is ANSWERED but an escalation was also returned', 'escalation');
      }
      break;
    }
    case 'ABSTAINED':
      if (res.abstention === null) {
        v.add('OUTCOME_INCONSISTENT', 'outcome is ABSTAINED but no abstention was given', 'abstention');
      }
      if (res.answer !== null) {
        v.add('OUTCOME_INCONSISTENT', 'outcome is ABSTAINED but an answer was also returned', 'answer');
      }
      break;
    case 'ESCALATE':
      if (res.escalation === null) {
        v.add('OUTCOME_INCONSISTENT', 'outcome is ESCALATE but no escalation was given', 'escalation');
      }
      break;
    default:
      v.add('MALFORMED_RESULT', `unknown outcome: ${String(res.outcome)}`, 'outcome');
  }

  res.relevantFiles.forEach((f, i) => {
    const at = `relevantFiles[${i}]`;
    if (f.citations.length === 0) {
      v.add('CITATION_MISSING', `${at} names a file without citing anything in it`, `${at}.citations`);
    }
    f.citations.forEach((c, j) => cite(c, `${at}.citations[${j}]`));
    if (f.citations.some((c) => c.path !== null && c.path !== f.path)) {
      v.add('MALFORMED_RESULT', `${at} cites a span in a different file than it names`, `${at}.citations`);
    }
  });

  res.relevantSymbols.forEach((s, i) => {
    const at = `relevantSymbols[${i}]`;
    if (s.citations.length === 0) {
      v.add(
        'CITATION_MISSING',
        `${at} names a symbol without citing where it is defined or used`,
        `${at}.citations`,
      );
    }
    s.citations.forEach((c, j) => cite(c, `${at}.citations[${j}]`));
  });

  res.relationships.forEach((r, i) => {
    const at = `relationships[${i}]`;
    if (r.basis === 'OBSERVED' && r.citations.length === 0) {
      v.add(
        'CITATION_MISSING',
        `${at} claims an OBSERVED relationship with no citation. If it was observed, the ` +
          'text that shows it can be named; if it cannot, the basis is INFERRED.',
        `${at}.citations`,
      );
    }
    r.citations.forEach((c, j) => cite(c, `${at}.citations[${j}]`));
  });

  checkObserved(v, res.observed, 'observed', cite);
  res.inferences.forEach((inf, i) => checkInference(v, inf, `inferences[${i}]`, cite));
  checkFactInferenceSeparation(v, res.observed, res.inferences, '');

  // Coverage must describe the packet it was given, not a different one.
  if (res.coverage.filesInPacket !== packet.files.length) {
    v.add(
      'MALFORMED_RESULT',
      `coverage.filesInPacket says ${res.coverage.filesInPacket} but the packet carries ${packet.files.length}`,
      'coverage.filesInPacket',
    );
  }
  if (res.coverage.filesExamined > packet.files.length) {
    v.add(
      'MALFORMED_RESULT',
      'coverage.filesExamined exceeds the number of files supplied',
      'coverage.filesExamined',
    );
  }

  return v.result();
}

function checkPacketCitation(
  v: Violations,
  c: Citation,
  packet: RepoEvidencePacket,
  field: string,
): void {
  if (c.path === null) {
    v.add('CITATION_UNKNOWN_PATH', 'a repository citation must name the file it points into', field, c);
    return;
  }
  if (!checkRange(v, c, field)) return;

  const file = packet.files.find((f) => f.path === c.path);
  if (!file) {
    v.add(
      'CITATION_UNKNOWN_PATH',
      `cites "${c.path}", which is not in the evidence packet. Bokahli reads only what it ` +
        'was given; a citation to a file that exists on disk but was not supplied is not ' +
        'grounded in anything Bokahli saw.',
      field,
      c,
    );
    return;
  }
  if (!isPathAllowed(c.path, packet.allowedPaths)) {
    v.add(
      'CITATION_PATH_NOT_ALLOWED',
      `cites "${c.path}", which is outside the caller's allowedPaths`,
      field,
      c,
    );
    return;
  }

  const excerpt = file.excerpts.find((e) => c.startLine >= e.startLine && c.endLine <= e.endLine);
  if (!excerpt) {
    v.add(
      'CITATION_OUT_OF_RANGE',
      `cites lines ${c.startLine}-${c.endLine} of "${c.path}", which no supplied excerpt covers`,
      field,
      c,
    );
    return;
  }
  const lines = excerpt.text.split('\n');
  const from = c.startLine - excerpt.startLine;
  const to = c.endLine - excerpt.startLine;
  checkQuote(v, c, lines.slice(from, to + 1).join('\n'), field);
}

// ---------------------------------------------------------------------------
// shared checks
// ---------------------------------------------------------------------------

function checkRange(v: Violations, c: Citation, field: string): boolean {
  if (
    !Number.isInteger(c.startLine) ||
    !Number.isInteger(c.endLine) ||
    c.startLine < 1 ||
    c.endLine < c.startLine
  ) {
    v.add(
      'CITATION_MALFORMED',
      `line range ${c.startLine}-${c.endLine} is not a valid 1-based inclusive span`,
      field,
      c,
    );
    return false;
  }
  return true;
}

/**
 * A quote is checked by containment rather than equality.
 *
 * Requiring equality would fail any citation of a whole line for a phrase
 * within it, which is the common and useful case. Containment still catches the
 * failure that matters: text the model produced that is not in the input at
 * all.
 */
function checkQuote(v: Violations, c: Citation, spanText: string, field: string): void {
  if (c.quote === null) return;
  if (!spanText.includes(c.quote)) {
    v.add(
      'CITATION_QUOTE_MISMATCH',
      `the quoted text does not appear in the cited span. Quoted: ${JSON.stringify(
        truncate(c.quote),
      )}; span says: ${JSON.stringify(truncate(spanText))}`,
      field,
      c,
    );
  }
}

function checkObserved(
  v: Violations,
  facts: readonly ObservedFact[],
  field: string,
  cite: (c: Citation, f: string) => void,
): void {
  facts.forEach((f, i) => {
    const at = `${field}[${i}]`;
    if (!f.statement) v.add('MALFORMED_RESULT', `${at}.statement is required`, `${at}.statement`);
    if (f.citations.length === 0) {
      v.add(
        'CITATION_MISSING',
        `${at} is stated as an observed fact but cites nothing. An uncited observation is ` +
          'an inference that has been relabelled.',
        `${at}.citations`,
      );
    }
    f.citations.forEach((c, j) => cite(c, `${at}.citations[${j}]`));
  });
}

function checkInference(
  v: Violations,
  inf: Inference,
  field: string,
  cite: (c: Citation, f: string) => void,
): void {
  if (!inf.statement) v.add('MALFORMED_RESULT', `${field}.statement is required`, `${field}.statement`);
  inf.basedOn.forEach((c, j) => cite(c, `${field}.basedOn[${j}]`));
  checkConfidence(v, inf.confidence, `${field}.confidence`);
}

/**
 * The same statement may not appear as both an observation and an inference.
 *
 * This is the one check here that is about honesty rather than arithmetic, and
 * it is kept mechanical on purpose: whether a claim is *really* an observation
 * is not decidable, but whether the model asserted the identical sentence in
 * both roles is. Doing so collapses the distinction the contract exists to
 * preserve, so it is refused.
 */
function checkFactInferenceSeparation(
  v: Violations,
  facts: readonly ObservedFact[],
  inferences: readonly Inference[],
  prefix: string,
): void {
  const observed = new Set(facts.map((f) => normalise(f.statement)));
  inferences.forEach((inf, i) => {
    if (observed.has(normalise(inf.statement))) {
      v.add(
        'INFERENCE_PRESENTED_AS_FACT',
        `"${truncate(inf.statement)}" is given both as an observed fact and as an inference. ` +
          'Observation and inference are separate fields because a consumer must be able to ' +
          'tell what the input said from what the model concluded.',
        prefix ? `${prefix}.inferences[${i}]` : `inferences[${i}]`,
      );
    }
  });
}

function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');
}

function truncate(s: string, n = 120): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function countLines(s: string): number {
  return s.split('\n').length;
}

function isSafeRelativePath(p: string): boolean {
  if (p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:[\\/]/.test(p)) return false;
  return !p.split(/[/\\]/).includes('..');
}

/**
 * Allowlist matching on path segments, never on raw prefixes.
 *
 * `src` must not admit `srcret/secrets.ts`. Comparing whole segments is the
 * difference between an allowlist and a string that looks like one.
 */
export function isPathAllowed(path: string, allowed: readonly string[]): boolean {
  if (!isSafeRelativePath(path)) return false;
  const parts = path.split('/');
  return allowed.some((entry) => {
    const e = entry.replace(/\/+$/, '');
    if (e === path) return true;
    const eParts = e.split('/');
    if (eParts.length > parts.length) return false;
    return eParts.every((seg, i) => parts[i] === seg);
  });
}
