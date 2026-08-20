/**
 * The router's view of qualification.
 *
 * Everything the router needs to ask — "is this artifact qualified for this
 * task class, and if not, why not" — goes through here, and the answer is
 * always a typed decision with its reasoning attached. There is no boolean
 * shortcut and no cached "yes": a lookup miss, an empty store, an unconfigured
 * policy and a failed threshold are four different situations, and a caller who
 * is refused deserves to know which one they hit.
 *
 * The gate holds the half of the qualification key that belongs to the
 * deployment — runtime build, hardware profile — because that half is fixed for
 * the life of the process, while the artifact half varies per candidate. If the
 * operator has not said what hardware this is, the profile id stays `unset`,
 * which matches no evidence at all. That is the intended failure mode: evidence
 * whose provenance cannot be checked against this machine is not evidence about
 * this machine.
 */
import {
  isTaskClass,
  notQualified,
  TASK_CLASS_CONTRACT_VERSIONS,
  type QualificationDecision,
  type QualificationPolicy,
  type TaskClass,
} from '@bokahli/contracts';
import {
  evaluateQualification,
  QualificationStore,
  type DeploymentKey,
  type RankableCandidate,
} from '@bokahli/qualification';

/** Sentinel used when no hardware profile has been configured. Matches nothing. */
export const UNSET_HARDWARE_PROFILE = 'unset';

export interface QualificationGateOptions {
  readonly store: QualificationStore;
  readonly runtimeName: string;
  readonly runtimeBuild: string;
  readonly hardwareProfileId: string;
  /** Operator policy per task class. A task class with no policy qualifies nothing. */
  readonly policies: Readonly<Partial<Record<TaskClass, QualificationPolicy>>>;
  /** Injected so staleness is testable without touching the clock. */
  readonly now?: () => Date;
}

export interface ArtifactIdentity {
  readonly modelId: string;
  readonly digest: string;
  readonly quantization: string;
}

export class QualificationGate {
  readonly #opts: QualificationGateOptions;

  constructor(opts: QualificationGateOptions) {
    this.#opts = opts;
  }

  /** An empty, deny-everything gate. The Phase 1 state, and the default. */
  static empty(runtimeName: string, runtimeBuild: string): QualificationGate {
    return new QualificationGate({
      store: QualificationStore.empty(),
      runtimeName,
      runtimeBuild,
      hardwareProfileId: UNSET_HARDWARE_PROFILE,
      policies: {},
    });
  }

  get store(): QualificationStore {
    return this.#opts.store;
  }

  get hardwareProfileId(): string {
    return this.#opts.hardwareProfileId;
  }

  get configuredTaskClasses(): readonly string[] {
    return Object.keys(this.#opts.policies).sort();
  }

  /**
   * Decide whether one artifact is qualified for one task class.
   *
   * `taskClass` being absent is itself an answer: qualification is always
   * qualification *for* something, so a caller demanding it without naming a
   * task class has asked an unanswerable question and is told so rather than
   * being given a default.
   */
  decide(artifact: ArtifactIdentity, taskClass: string | undefined): QualificationDecision {
    if (taskClass === undefined || taskClass === '') {
      return notQualified(
        '(unspecified)',
        'MODEL_NOT_QUALIFIED_FOR_TASK',
        'qualification was required but no task class was named. Qualification is always ' +
          'qualification for a specific task class; there is no general fitness to grant.',
      );
    }
    if (!isTaskClass(taskClass)) {
      return notQualified(
        taskClass,
        'MODEL_NOT_QUALIFIED_FOR_TASK',
        `"${taskClass}" is not a task class this build defines a contract for ` +
          `(${Object.keys(TASK_CLASS_CONTRACT_VERSIONS).join(', ')}). An unknown task class ` +
          'cannot be qualified for, because there is no contract to have been tested against.',
      );
    }

    const policy = this.#opts.policies[taskClass];
    if (!policy) {
      return notQualified(
        taskClass,
        'NO_POLICY_CONFIGURED',
        `no qualification policy is configured for "${taskClass}". Until an operator states ` +
          'what evidence would be sufficient, nothing satisfies it.',
      );
    }

    return evaluateQualification({
      store: this.#opts.store,
      deployment: this.#deploymentKey(artifact),
      taskClass,
      taskClassContractVersion: TASK_CLASS_CONTRACT_VERSIONS[taskClass],
      policy,
      now: this.#opts.now?.() ?? new Date(),
    });
  }

  /**
   * Ranking inputs for one candidate.
   *
   * The measured values come from imported evidence or they are null. There is
   * no estimate, no prior, and no substitute drawn from the artifact's declared
   * facts — parameter count is not a score, and treating it as one is exactly
   * the fabrication this layer exists to prevent.
   */
  rankable(artifact: ArtifactIdentity, taskClass: string | undefined): RankableCandidate {
    const decision = this.decide(artifact, taskClass);
    const empty = { modelId: artifact.modelId, decision, passRate: null, meanScore: null, sampleCount: null };
    if (!isTaskClass(taskClass)) return empty;

    const [entry] = this.#opts.store.findForTask(
      this.#deploymentKey(artifact),
      taskClass,
      TASK_CLASS_CONTRACT_VERSIONS[taskClass],
    );
    // Ranking inputs come only from evidence the operator authorised. An
    // untrusted bundle's numbers must not order candidates either: a forged
    // "passRate: 1.0" would otherwise still push a model to the front of the
    // list even though it cannot be routed to.
    if (!entry || !entry.importTrust.accepted) return empty;

    return {
      modelId: artifact.modelId,
      decision,
      passRate: entry.bundle.aggregate.passRate,
      meanScore: entry.bundle.aggregate.meanScore,
      sampleCount: entry.bundle.aggregate.sampleCount,
    };
  }

  #deploymentKey(artifact: ArtifactIdentity): DeploymentKey {
    return {
      modelId: artifact.modelId,
      artifactDigest: artifact.digest,
      quantization: artifact.quantization,
      runtimeName: this.#opts.runtimeName,
      runtimeBuild: this.#opts.runtimeBuild,
      hardwareProfileId: this.#opts.hardwareProfileId,
    };
  }
}
