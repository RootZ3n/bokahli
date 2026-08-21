/**
 * The client-facing contract: what ikbi, Hermes and the Trio may rely on.
 *
 * Bokahli's internal types change freely. This file is the subset that does
 * not, because other repositories are now written against it. A client that
 * switches on an escalation reason, or branches on whether an outcome is
 * `ROUTED`, has encoded these strings into its own control flow — and it does
 * so on a different machine, on a different release cadence, sometimes over a
 * phone's network. Renaming a member here is not a refactor; it is a silent
 * behaviour change in software that is not in this repository.
 *
 * ## Why a digest rather than a version number
 *
 * A version constant records intent and nothing else. Someone adds a member to
 * `EscalateReason`, the constant still reads `/1`, and every client keeps
 * claiming compatibility with a surface that no longer matches. The failure is
 * not caught at the boundary; it is caught by a client falling through a switch
 * statement in production.
 *
 * `CLIENT_CONTRACT_DIGEST` is a hash over the enumerated surface below, pinned
 * by a test. Any change to the surface changes the digest and fails that test,
 * which forces the change to be deliberate: bump the version, update the pin,
 * and — the part that actually matters — go and look at the clients.
 *
 * ## What is deliberately not frozen
 *
 * Prose. `detail`, `note` and `authorityNote` carry human-readable explanation
 * and are expected to improve. A client that parses them has made a mistake
 * this file cannot prevent, and freezing them would stop the explanations from
 * ever getting better.
 *
 * Field *additions* to response objects are compatible and do not move the
 * digest, because the surface enumerated here is the set of things a client may
 * switch on. Adding `swap` to an escalation broke nothing; renaming
 * `REQUIREMENTS_UNMET` would break everything.
 */

import { createHash } from 'node:crypto';

/** Bumped only alongside a deliberate change to the surface below. */
export const CLIENT_CONTRACT_VERSION = 'bokahli.client/1' as const;

/**
 * Route modes a client may request.
 *
 * `EXACT` names an artifact and its digest and accepts no substitute — it is
 * the mode for a caller who needs reproducibility rather than an answer.
 * `PROFILE` states requirements. `AUTO` asks Bokahli to choose.
 */
export const CLIENT_ROUTE_MODES = ['AUTO', 'PROFILE', 'EXACT'] as const;

/** Terminal outcome kinds. Every request ends as exactly one of these. */
export const CLIENT_OUTCOME_KINDS = ['ROUTED', 'ESCALATE', 'REFUSED'] as const;

/**
 * Escalation reasons a client may branch on.
 *
 * The distinctions here are the ones a client needs to act differently on, and
 * collapsing any two of them would take a decision away from the caller:
 *
 * - `REQUIREMENTS_UNMET` vs `LOCAL_MODEL_SWAP_REQUIRED` — "nothing installed
 *   can serve this" vs "something can, and it is not loaded". The first is a
 *   reason to fall back to a remote provider; the second is a reason to ask an
 *   operator to swap. A client that treats them alike either gives up when it
 *   need not, or waits for a swap that will never help.
 * - `NO_QUALIFIED_LOCAL_ROUTE` vs `MODEL_NOT_QUALIFIED_FOR_TASK` — "nothing
 *   here is qualified at all" vs "nothing here is qualified *for this*".
 * - `RUNTIME_UNHEALTHY` is a health condition and carries `retryableLocal`.
 *   The others are not retryable by repeating the request.
 */
export const CLIENT_ESCALATE_REASONS = [
  'NO_LOCAL_CANDIDATES',
  'NO_QUALIFIED_LOCAL_ROUTE',
  'REQUIREMENTS_UNMET',
  'CONTEXT_EXCEEDS_LOCAL_CAPABILITY',
  'CAPABILITY_UNSUPPORTED',
  'MODEL_NOT_QUALIFIED_FOR_TASK',
  'LOCAL_MODEL_SWAP_REQUIRED',
  'RUNTIME_UNHEALTHY',
] as const;

/**
 * Refusal reasons. A refusal is not an escalation: it means the request as
 * stated cannot be honoured, and re-routing it elsewhere would not be honouring
 * it either. `EXACT_*` refusals in particular must never be answered by
 * substituting a different artifact.
 */
export const CLIENT_REFUSE_REASONS = [
  'EXACT_IDENTITY_UNKNOWN',
  'EXACT_IDENTITY_NOT_PUBLIC',
  'EXACT_DIGEST_MISMATCH',
] as const;

/**
 * Qualification states.
 *
 * `INSTALLED_UNQUALIFIED` is the default and the honest state of every artifact
 * on this deployment. A client must not read it as "probably fine" — it means
 * Bokahli makes no claim, and a client that needs a claim should require one.
 */
export const CLIENT_QUALIFICATION_STATUSES = [
  'INSTALLED_UNQUALIFIED',
  'QUALIFIED',
  'DISQUALIFIED',
] as const;

/**
 * Endpoints clients call. Paths are part of the contract; a moved endpoint is
 * as breaking as a renamed field.
 */
export const CLIENT_ENDPOINTS = [
  'POST /v1/bokahli/chat',
  'POST /v1/chat/completions',
  'GET /v1/catalog',
  'GET /v1/models',
  'GET /health/live',
  'GET /health/ready',
] as const;

/**
 * Response fields a client may depend on being present.
 *
 * Presence only. Their types are in the modules that define them, and the
 * digest covers the names because a rename is the change that silently breaks a
 * client that never sees an error.
 */
export const CLIENT_RESPONSE_FIELDS = [
  'outcome',
  'requestId',
  'route.mode',
  'route.reason',
  'route.selected.modelId',
  'route.selected.digest',
  'route.unmet',
  'route.considered',
  'route.swap',
  'attestation.binding.modelId',
  'attestation.binding.artifactDigest',
  'qualification.status',
  'qualification.authority',
] as const;

export type ClientRouteMode = (typeof CLIENT_ROUTE_MODES)[number];
export type ClientOutcomeKind = (typeof CLIENT_OUTCOME_KINDS)[number];
export type ClientEscalateReason = (typeof CLIENT_ESCALATE_REASONS)[number];
export type ClientRefuseReason = (typeof CLIENT_REFUSE_REASONS)[number];
export type ClientQualificationStatus = (typeof CLIENT_QUALIFICATION_STATUSES)[number];

/**
 * The frozen surface, in the order the digest is taken over.
 *
 * Order is fixed rather than sorted so that an accidental reordering is a
 * detected change too — an operator reading a diff should see the same
 * structure the digest saw.
 */
export const CLIENT_CONTRACT_SURFACE = {
  version: CLIENT_CONTRACT_VERSION,
  routeModes: CLIENT_ROUTE_MODES,
  outcomeKinds: CLIENT_OUTCOME_KINDS,
  escalateReasons: CLIENT_ESCALATE_REASONS,
  refuseReasons: CLIENT_REFUSE_REASONS,
  qualificationStatuses: CLIENT_QUALIFICATION_STATUSES,
  endpoints: CLIENT_ENDPOINTS,
  responseFields: CLIENT_RESPONSE_FIELDS,
} as const;

/** Stable serialisation of the surface. Pure function of the constants above. */
export function clientContractCanonicalForm(): string {
  return JSON.stringify(CLIENT_CONTRACT_SURFACE, null, 0);
}

/** sha256 of the canonical form, pinned by `packages/contracts/test/client-contract.test.js`. */
export function clientContractDigest(): string {
  return `sha256:${createHash('sha256').update(clientContractCanonicalForm(), 'utf8').digest('hex')}`;
}
