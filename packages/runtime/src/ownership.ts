/**
 * Who owns the runtime port, and may this process be signalled?
 *
 * WHY THIS EXISTS, PRECISELY. During the Qwen3.8 campaign an experimental unit was started
 * while the control still held port 8081. The unit failed to bind, a `pgrep -f
 * 'llama-server.*--port 8081'` matched the CONTROL instead, and SIGINT went to production.
 * The control was down for ninety seconds. Nothing in that sequence was exotic: a name match
 * is a guess about identity, and a guess is what gets signalled when the thing you meant to
 * signal never started.
 *
 * So ownership is PROVEN, from four independent facts, before any signal is sent:
 *
 *   systemd MainPID   — what the unit says it started. Authoritative for "which process is
 *                       mine", worthless for "is it still alive and the same one".
 *   port ownership    — which pid actually holds the listening socket. This is the fact that
 *                       would have caught the campaign mistake on its own.
 *   instance identity — pid + kernel start ticks + boot id, so a recycled pid is a different
 *                       process. Without it, MainPID and port agreement can still both point
 *                       at a pid that died and was reused.
 *   argv              — the model path and port the process was actually started with, read
 *                       from /proc, not from what we intended to start.
 *
 * ANY DISAGREEMENT ABORTS. Not "prefer MainPID", not "fall back to the port holder" — abort.
 * The failure this guards against is precisely the case where two plausible answers exist and
 * one of them is production.
 */
import type { BackendInstanceIdentity } from '@bokahli/contracts';

/** A refusal to signal, with the reason an operator needs to see. */
export type OwnershipVerdict =
  | { readonly ok: true; readonly target: OwnedRuntime }
  | { readonly ok: false; readonly code: OwnershipRefusal; readonly detail: string };

export type OwnershipRefusal =
  | 'NO_MAIN_PID'
  | 'NO_PORT_LISTENER'
  | 'PID_MISMATCH'
  | 'PORT_AMBIGUOUS'
  | 'INSTANCE_UNREADABLE'
  | 'ARGV_MISMATCH'
  | 'UNIT_NOT_ACTIVE';

export interface OwnedRuntime {
  readonly pid: number;
  readonly unit: string;
  readonly port: number;
  readonly instance: BackendInstanceIdentity;
  /** The model path this process was actually started with, from /proc. */
  readonly modelPath: string;
}

export interface OwnershipSources {
  /** systemd MainPID for the unit, or 0/null when the unit is not running. */
  readonly mainPid: (unit: string) => Promise<number | null>;
  readonly unitActive: (unit: string) => Promise<boolean>;
  /** Every pid holding a LISTEN socket on this port. More than one is ambiguous by definition. */
  readonly portHolders: (port: number) => Promise<readonly number[]>;
  readonly instanceOf: (pid: number) => Promise<BackendInstanceIdentity | null>;
  readonly argvOf: (pid: number) => Promise<readonly string[] | null>;
}

/** Read `--model <path>` out of the argv the kernel reports. */
export function modelPathOf(argv: readonly string[]): string | null {
  const i = argv.indexOf('--model');
  return i >= 0 && i + 1 < argv.length ? (argv[i + 1] ?? null) : null;
}

/** Read `--port <n>` out of the argv the kernel reports. */
export function portOf(argv: readonly string[]): number | null {
  const i = argv.indexOf('--port');
  if (i < 0 || i + 1 >= argv.length) return null;
  const n = Number(argv[i + 1]);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/**
 * Prove that `unit` owns `port`, and return the process it is safe to signal.
 *
 * The order is deliberate: cheapest and most disqualifying first. A unit that is not active
 * cannot own anything, and asking the rest of the questions about it would only produce a
 * more detailed wrong answer.
 */
export async function verifyOwnership(
  unit: string,
  port: number,
  sources: OwnershipSources,
): Promise<OwnershipVerdict> {
  if (!(await sources.unitActive(unit))) {
    return { ok: false, code: 'UNIT_NOT_ACTIVE', detail: `${unit} is not active; nothing of ours is running` };
  }
  const mainPid = await sources.mainPid(unit);
  if (mainPid === null || mainPid <= 0) {
    return { ok: false, code: 'NO_MAIN_PID', detail: `${unit} reports no MainPID` };
  }
  const holders = await sources.portHolders(port);
  if (holders.length === 0) {
    // The unit is active but holds no socket. It may be mid-load — which is exactly when a
    // signal would be most damaging, so this is a refusal rather than a wait.
    return { ok: false, code: 'NO_PORT_LISTENER', detail: `no process is listening on ${port}` };
  }
  if (holders.length > 1) {
    return {
      ok: false, code: 'PORT_AMBIGUOUS',
      detail: `${holders.length} processes hold port ${port} (${holders.join(', ')}); refusing to guess`,
    };
  }
  const holder = holders[0]!;
  if (holder !== mainPid) {
    // THE CAMPAIGN MISTAKE, caught. A unit whose start failed leaves MainPID pointing at
    // something that never bound, while the port is still held by whoever was already there —
    // in that incident, production.
    return {
      ok: false, code: 'PID_MISMATCH',
      detail: `${unit} MainPID is ${mainPid} but port ${port} is held by ${holder}; refusing to signal either`,
    };
  }
  const instance = await sources.instanceOf(mainPid);
  if (instance === null) {
    return { ok: false, code: 'INSTANCE_UNREADABLE', detail: `cannot read instance identity for pid ${mainPid}` };
  }
  const argv = await sources.argvOf(mainPid);
  const argvPort = argv === null ? null : portOf(argv);
  const modelPath = argv === null ? null : modelPathOf(argv);
  if (argv === null || argvPort !== port || modelPath === null) {
    return {
      ok: false, code: 'ARGV_MISMATCH',
      detail: `pid ${mainPid} argv does not describe a runtime serving ${port} (argv port ${String(argvPort)})`,
    };
  }
  return { ok: true, target: { pid: mainPid, unit, port, instance, modelPath } };
}
