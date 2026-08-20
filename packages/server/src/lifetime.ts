/**
 * Does the evidence behind a request survive the request?
 *
 * f270ee9 stamped every attestation with a 60-second `expiresAt` and stopped
 * there. That made staleness visible and left the two questions a long request
 * actually raises unanswered: what happens when a request admitted under valid
 * evidence runs past the TTL, and what happens when the backend restarts while
 * it runs.
 *
 * On this deployment those are not edge cases. A 32K prefill measures tens of
 * seconds and the 65536 tier measured 88.5 seconds worst case, so requests that
 * outlive a 60-second attestation are ordinary. Refusing them would discard
 * correct answers because a clock advanced — and would do it selectively to the
 * longest, most expensive, most context-heavy requests, which is precisely the
 * population a qualification campaign cannot afford to lose. Ignoring the
 * expiry would accept an answer from a process that is no longer the process
 * that was attested.
 *
 * Continuity resolves it. Elapsed time is not the question; identity is. A
 * backend that never restarted is still the backend that was attested, however
 * long it took. A backend that restarted is a different process — fresh
 * context, unattested load, unknown placement — and its output is
 * infrastructure-invalid regardless of how good it looks.
 *
 * Unknown continuity is treated as broken continuity. The alternative is to
 * accept an attempt because we could not tell whether it was valid, which is
 * the failure mode this whole phase exists to remove.
 */
import type { AttemptLifetime } from '@bokahli/contracts';

export interface AttemptLifetimeInputs {
  readonly admittedAt: string;
  readonly completedAt: string;
  readonly attestationObservedAt: string;
  readonly attestationExpiresAt: string;
  readonly instanceAtAdmission: string | null;
  readonly instanceAtCompletion: string | null;
}

function ms(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export function evaluateAttemptLifetime(inputs: AttemptLifetimeInputs): AttemptLifetime {
  const admitted = ms(inputs.admittedAt);
  const completed = ms(inputs.completedAt);
  const expires = ms(inputs.attestationExpiresAt);
  const reasons: string[] = [];

  // An unparseable timestamp is not a small problem here: every judgement below
  // is a comparison between two of them. Fail closed rather than compare NaN.
  if (admitted === null || completed === null || expires === null) {
    return {
      admittedAt: inputs.admittedAt,
      completedAt: inputs.completedAt,
      attestationObservedAt: inputs.attestationObservedAt,
      attestationExpiresAt: inputs.attestationExpiresAt,
      instanceAtAdmission: inputs.instanceAtAdmission,
      instanceAtCompletion: inputs.instanceAtCompletion,
      attestationValidAtAdmission: false,
      crossedAttestationTtl: false,
      instanceContinuous: false,
      revalidation: 'none',
      verdict: 'infrastructure-invalid',
      reasons: ['attempt timestamps are not parseable, so its lifetime cannot be established'],
    };
  }

  const validAtAdmission = admitted <= expires;
  if (!validAtAdmission) {
    reasons.push(
      'the attestation had already expired when this request was admitted, so it was ' +
        'served on evidence that was stale before any work started',
    );
  }

  const crossed = completed > expires;

  const instanceContinuous =
    inputs.instanceAtAdmission !== null &&
    inputs.instanceAtCompletion !== null &&
    inputs.instanceAtAdmission === inputs.instanceAtCompletion;

  if (inputs.instanceAtAdmission === null || inputs.instanceAtCompletion === null) {
    reasons.push(
      'the backend instance could not be established at ' +
        (inputs.instanceAtAdmission === null ? 'admission' : 'completion') +
        ', so continuity across this request is unknown; unknown continuity is not continuity',
    );
  } else if (!instanceContinuous) {
    // The decisive case. A restart between admission and completion means the
    // answer came from a process that was never attested: different load,
    // different context, possibly different placement.
    reasons.push(
      'the backend restarted while this request was executing, so the completion came ' +
        'from a process that was never attested for it',
    );
  }

  // The TTL alone never invalidates. Continuity does, in both directions:
  // without it the attempt is invalid whether or not the clock ran out, and
  // with it the attempt survives however long it took.
  const verdict = validAtAdmission && instanceContinuous ? 'valid' : 'infrastructure-invalid';

  if (crossed && instanceContinuous && validAtAdmission) {
    reasons.push(
      'this request outlived its attestation window and is still attributable: the ' +
        'backend instance that was attested at admission is the one that completed it',
    );
  }

  return {
    admittedAt: inputs.admittedAt,
    completedAt: inputs.completedAt,
    attestationObservedAt: inputs.attestationObservedAt,
    attestationExpiresAt: inputs.attestationExpiresAt,
    instanceAtAdmission: inputs.instanceAtAdmission,
    instanceAtCompletion: inputs.instanceAtCompletion,
    attestationValidAtAdmission: validAtAdmission,
    crossedAttestationTtl: crossed,
    instanceContinuous,
    revalidation: crossed && instanceContinuous ? 'instance-continuity' : 'none',
    verdict,
    reasons,
  };
}

/**
 * The escalation a caller receives when an attempt cannot be attributed.
 *
 * Shaped like `runtimeUnhealthyEscalation` deliberately: from the caller's side
 * these are the same event — Bokahli cannot stand behind what came back, so
 * nothing is returned as an answer. The difference is in the reason, and the
 * reason is what a qualification campaign needs in order to drop the attempt
 * without scoring it against the model.
 */
export function attemptInvalidDetail(l: AttemptLifetime): string {
  return (
    'this request completed but its result cannot be attributed to an attested ' +
    `backend: ${l.reasons.join('; ')}. The output was discarded rather than returned, ` +
    'because an unattributable completion is not a cheaper kind of answer — it is a ' +
    'different kind of claim.'
  );
}
