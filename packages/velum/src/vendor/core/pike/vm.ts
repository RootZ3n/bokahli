/**
 * VENDORED FROM VELUM — DO NOT EDIT.
 *
 *   source: src/core/pike/vm.ts
 *   commit: 5f6738b1e9a6b6ae4e4d54c269f460323bb72254
 *   sync:   node scripts/sync-velum.mjs --sync
 *   verify: node scripts/sync-velum.mjs --check
 *
 * Edits here are erased by the next sync and fail `--check` before then. The
 * boundary that uses this engine is packages/server/src/trust.ts; the contract
 * it reports against is packages/contracts/src/velum.ts.
 */
/**
 * Velum — the Pike VM.
 * ============================================================
 * A thread-set NFA simulation. At each input position the VM holds a set of
 * program counters, advances all of them by one code point, and never revisits
 * a program counter it has already added at that position. That last clause is
 * the whole guarantee: the thread set is bounded by the program size, so the
 * work is **O(input × program)** and there is no input that makes it explode.
 *
 * The pathological case for a backtracking engine — `(a+)+b` against `aaaa…a` —
 * costs exactly the same here as `a+b`, because the second `a+` cannot spawn a
 * thread at a position where an equivalent thread already exists. That is not a
 * mitigation or a timeout; it is a property of the algorithm, and the test
 * suite measures VM steps to show it rather than measuring a wall clock.
 *
 * Priority is encoded in the order threads are added, so a greedy `a*` and a
 * lazy `a*?` differ only in the order a `split` pushes its branches, and the
 * first thread to reach `match` at a position wins. Leftmost-first, as the
 * reference implementations produce.
 *
 * Spans are **UTF-8 byte offsets** taken from the decoded cell table: the VM
 * steps over code points, so `.` is one character, and reports bytes, so a
 * consumer can resolve a finding against the original evidence.
 *
 * Ported from the operator-owned ABAIYA implementation (`abaiya-policy`
 * `matcher.rs`, `RootZ3n/abaiya` at `a471252`).
 */
import { decodeText, decodeUtf8, endOf, type ByteSpan, type DecodedText } from "../bytes.js";
import { classMatches, isWordCodePoint } from "./syntax.js";
import { compile, foldCodePoint, type Inst, type Program } from "./program.js";

/** A whole-match span, in UTF-8 bytes of the inspected text. */
export interface Match extends ByteSpan {
  /** Index of the first code point of the match, for callers stepping cells. */
  readonly startCell: number;
  readonly endCell: number;
}

export interface MatchStats {
  /** Instructions executed. The complexity evidence. */
  readonly steps: number;
  /** Code points scanned. */
  readonly cells: number;
  /** Instructions in the compiled program. */
  readonly programSize: number;
}

export interface FindOptions {
  /** Stop after this many matches. */
  readonly limit?: number;
  /**
   * Hard ceiling on VM steps.
   *
   * The VM is linear, so this is not a backstop against pathological patterns —
   * there aren't any. It bounds the product: a very large program against a very
   * large input is still a lot of work, and an inspection path that can be made
   * slow by supplying more evidence needs a stated end.
   */
  readonly maxSteps?: number;
}

export const VM_LIMITS = Object.freeze({
  /** Bytes of input the matcher will scan. */
  maxInputBytes: 4 * 1024 * 1024,
  /** Default step ceiling. Generous: 4 MiB against a 200-instruction program. */
  maxSteps: 200_000_000,
  defaultLimit: 1_000,
});

export class MatchLimitExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatchLimitExceeded";
  }
}

/**
 * A step ceiling that is checked where the steps are spent.
 *
 * `runSearch` used to compare its own counter against `maxSteps` once per input
 * position, which bounds the work *between* positions and not the work *inside*
 * one. Everything a lookahead costs — including nested lookaheads, which
 * multiply — happened inside a single `addThread` call, below the check. This
 * charges each step as it is taken, so the ceiling holds no matter which loop
 * the work is hiding in.
 */
class StepBudget {
  private spent = 0;
  constructor(private readonly max: number) {}

  charge(units: number): void {
    this.spent += units;
    if (this.spent > this.max) {
      throw new MatchLimitExceeded(`matching exceeded ${this.max} VM steps`);
    }
  }

  get used(): number {
    return this.spent;
  }
}

/**
 * One compiled pattern, ready to run.
 *
 * Compilation is deterministic and happens once; a `Matcher` is immutable and
 * safe to share.
 */
export class Matcher {
  readonly program: Program;

  private constructor(program: Program) {
    this.program = program;
  }

  static compile(pattern: string, foldCase = false): Matcher {
    return new Matcher(compile(pattern, foldCase));
  }

  get size(): number {
    return this.program.insts.length;
  }

  /** Earliest match at or after `fromCell`, or null. */
  findFrom(decoded: DecodedText, fromCell: number, opts: FindOptions = {}): {
    readonly match: Match | null;
    readonly stats: MatchStats;
  } {
    return runSearch(this.program, decoded, fromCell, opts);
  }

  /** Every non-overlapping match, leftmost-first. */
  findAll(decoded: DecodedText, opts: FindOptions = {}): {
    readonly matches: readonly Match[];
    readonly stats: MatchStats;
  } {
    const limit = opts.limit ?? VM_LIMITS.defaultLimit;
    const matches: Match[] = [];
    let steps = 0;
    let from = 0;

    while (matches.length < limit && from <= decoded.length) {
      const r = runSearch(this.program, decoded, from, {
        ...opts,
        maxSteps: (opts.maxSteps ?? VM_LIMITS.maxSteps) - steps,
      });
      steps += r.stats.steps;
      if (r.match === null) break;
      matches.push(r.match);
      // An empty match would otherwise loop forever at the same position.
      from = r.match.endCell > r.match.startCell ? r.match.endCell : r.match.startCell + 1;
    }

    return {
      matches,
      stats: { steps, cells: decoded.length, programSize: this.program.insts.length },
    };
  }

  isMatch(decoded: DecodedText, opts: FindOptions = {}): boolean {
    return this.findFrom(decoded, 0, { ...opts, limit: 1 }).match !== null;
  }
}

/**
 * Does `program` match starting exactly at `at`?
 *
 * Anchored, and unbounded in length. A lookahead body is a regular language and
 * an anchored match of one is decidable in a single forward pass, so it is
 * decided rather than approximated: the scan runs until the body matches, until
 * its thread set empties, or until the input ends.
 *
 * Two earlier revisions capped this at 64 code points. The cap did not bound
 * anything worth bounding — the body's thread set dies on the first character
 * that does not continue it — and it did change what an assertion meant, which
 * turned `pretend you are a` followed by enough spaces into a finding. What
 * bounds the work is `budget`, charged per step, shared with the caller.
 */
function anchoredMatch(
  program: Program,
  decoded: DecodedText,
  at: number,
  budget: StepBudget,
): { readonly matched: boolean; readonly steps: number } {
  const insts = program.insts;
  const cp = decoded.cp;
  const limit = decoded.length;
  let steps = 0;
  const seen = new Int32Array(insts.length).fill(-1);
  let gen = 0;
  let current: number[] = [];
  let next: number[] = [];

  const add = (list: number[], pc: number, pos: number): void => {
    const stack = [pc];
    while (stack.length > 0) {
      const p = stack.pop() as number;
      if (seen[p] === gen) continue;
      seen[p] = gen;
      steps += 1;
      budget.charge(1);
      const inst = insts[p] as Inst;
      switch (inst.op) {
        case "jmp": stack.push(inst.to); break;
        case "split": stack.push(inst.y); stack.push(inst.x); break;
        case "assert": if (satisfiesAssert(inst.kind, decoded, pos)) stack.push(p + 1); break;
        case "look": {
          const hit = anchoredMatch(inst.body, decoded, pos, budget);
          steps += hit.steps;
          if (hit.matched !== inst.negated) stack.push(p + 1);
          break;
        }
        default: list.push(p);
      }
    }
  };

  gen += 1;
  add(current, 0, at);
  for (let pos = at; ; pos++) {
    for (const pc of current) {
      steps += 1;
      budget.charge(1);
      if ((insts[pc] as Inst).op === "match") return { matched: true, steps };
    }
    if (pos >= limit) break;
    const here = cp[pos] as number;
    const folded = program.foldCase && here >= 0 ? foldCodePoint(here) : here;
    gen += 1;
    next = [];
    for (const pc of current) {
      const inst = insts[pc] as Inst;
      const consumed =
        inst.op === "any" ? here >= 0
          : inst.op === "char" ? classMatches(inst.set, program.foldCase ? folded : here)
            : false;
      if (consumed) add(next, pc + 1, pos + 1);
    }
    current = next;
    if (current.length === 0) break;
  }
  return { matched: false, steps };
}

function satisfiesAssert(
  kind: Extract<Inst, { op: "assert" }>["kind"],
  decoded: DecodedText,
  at: number,
): boolean {
  const n = decoded.length;
  switch (kind) {
    case "start":
      return at === 0;
    case "end":
      return at === n;
    case "word-boundary":
    case "not-word-boundary": {
      const before = at > 0 ? isWordCodePoint(decoded.cp[at - 1] ?? -1) : false;
      const after = at < n ? isWordCodePoint(decoded.cp[at] ?? -1) : false;
      const boundary = before !== after;
      return kind === "word-boundary" ? boundary : !boundary;
    }
  }
}

/**
 * Search for the leftmost match starting at or after `fromCell`.
 *
 * One pass. The search is unanchored, so at every position a fresh thread is
 * added at pc 0 — but only while no match has been found yet, which is what
 * makes the result leftmost rather than "any".
 */
function runSearch(
  program: Program,
  decoded: DecodedText,
  fromCell: number,
  opts: FindOptions,
): { readonly match: Match | null; readonly stats: MatchStats } {
  const insts = program.insts;
  const cells = decoded.cp;
  const n = decoded.length;
  const maxSteps = opts.maxSteps ?? VM_LIMITS.maxSteps;

  if (decoded.bytes.length > VM_LIMITS.maxInputBytes) {
    throw new MatchLimitExceeded(
      `input of ${decoded.bytes.length} bytes exceeds the ${VM_LIMITS.maxInputBytes}-byte scan limit`,
    );
  }

  let steps = 0;
  const budget = new StepBudget(maxSteps);
  // `onList[pc]` records the generation that last added pc, which is how a
  // program counter is added at most once per input position.
  const onList = new Int32Array(insts.length).fill(-1);
  const startOf = new Int32Array(insts.length).fill(-1);
  let generation = 0;

  let clist: number[] = [];
  let nlist: number[] = [];
  let clistStart: number[] = [];
  let nlistStart: number[] = [];

  let bestStart = -1;
  let bestEnd = -1;

  /** Add pc and everything reachable from it without consuming input. */
  const addThread = (list: number[], starts: number[], pc: number, start: number, at: number): void => {
    // Iterative rather than recursive: an epsilon chain can be as long as the
    // program, and a 8,192-deep recursion is a stack overflow, not an error.
    const stack: [number, number][] = [[pc, start]];
    while (stack.length > 0) {
      const [p, s] = stack.pop() as [number, number];
      if (onList[p] === generation) {
        // Already present at this position. Keep the *earlier* start, so the
        // match is leftmost rather than whichever thread arrived first.
        if (startOf[p] !== -1 && s < (startOf[p] as number)) startOf[p] = s;
        continue;
      }
      onList[p] = generation;
      startOf[p] = s;
      steps += 1;
      budget.charge(1);
      const inst = insts[p] as Inst;
      switch (inst.op) {
        case "jmp":
          stack.push([inst.to, s]);
          break;
        case "split":
          // Pushed in reverse so the higher-priority branch is popped first.
          stack.push([inst.y, s]);
          stack.push([inst.x, s]);
          break;
        case "assert":
          if (satisfiesAssert(inst.kind, decoded, at)) stack.push([p + 1, s]);
          break;
        case "look": {
          // Run the body anchored here, to whatever length it needs. The
          // budget travels into it: an unbounded body and a nested lookahead
          // both multiply, and a ceiling that is not checked inside the
          // recursion is not a ceiling.
          const hit = anchoredMatch(inst.body, decoded, at, budget);
          steps += hit.steps;
          if (hit.matched !== inst.negated) stack.push([p + 1, s]);
          break;
        }
        default:
          list.push(p);
          starts.push(s);
      }
    }
  };

  for (let at = fromCell; at <= n; at++) {
    generation += 1;
    const nextC: number[] = [];
    const nextS: number[] = [];

    // Carry the surviving threads forward, then seed a new one unless a match
    // has already been found — after that, only extending it can improve on it.
    for (let k = 0; k < nlist.length; k++) {
      addThread(nextC, nextS, nlist[k] as number, nlistStart[k] as number, at);
    }
    // The prefilter. A position whose code point cannot begin a match does not
    // need a thread, and skipping it is the difference between 295 VM steps per
    // input byte and a handful. `program.first` is a superset of the code points
    // a match can start with, so this removes no match; when it is null the seed
    // is unconditional, exactly as before.
    if (bestStart === -1) {
      const first = program.first;
      if (first === null) {
        addThread(nextC, nextS, 0, at, at);
      } else if (at < n) {
        const c = cells[at] as number;
        if (classMatches(first, program.foldCase && c >= 0 ? foldCodePoint(c) : c)) {
          addThread(nextC, nextS, 0, at, at);
        }
      }
    }

    clist = nextC;
    clistStart = nextS;
    nlist = [];
    nlistStart = [];

    const cp = at < n ? (cells[at] as number) : -2;
    const folded = program.foldCase && cp >= 0 ? foldCodePoint(cp) : cp;

    for (let k = 0; k < clist.length; k++) {
      const pc = clist[k] as number;
      const start = clistStart[k] as number;
      const inst = insts[pc] as Inst;
      steps += 1;
      budget.charge(1);

      if (inst.op === "match") {
        // Leftmost-first: a match starting earlier always wins; at equal starts
        // the first thread to arrive wins, which is priority order.
        if (bestStart === -1 || start < bestStart || (start === bestStart && at > bestEnd)) {
          if (bestStart === -1 || start < bestStart) {
            bestStart = start;
            bestEnd = at;
          } else if (start === bestStart && at > bestEnd) {
            bestEnd = at;
          }
        }
        // Threads after a match in this list are lower priority; drop them so
        // a lazy quantifier stops where it should.
        break;
      }

      if (at >= n) continue;
      const consumed =
        inst.op === "any"
          ? cp >= 0
          : inst.op === "char"
            ? classMatches(inst.set, program.foldCase ? folded : cp)
            : false;
      if (consumed) {
        nlist.push(pc + 1);
        nlistStart.push(start);
      }
    }

    if (bestStart !== -1 && nlist.length === 0) break;
  }

  const stats: MatchStats = { steps, cells: n, programSize: insts.length };
  if (bestStart === -1) return { match: null, stats };

  const startByte = bestStart < n ? (decoded.start[bestStart] as number) : decoded.bytes.length;
  const endByte = bestEnd > 0 ? endOf(decoded, bestEnd - 1) : startByte;
  return {
    match: { startByte, endByte: bestEnd > bestStart ? endByte : startByte, startCell: bestStart, endCell: bestEnd },
    stats,
  };
}

/** Convenience: compile and search a JavaScript string in one call. */
export function findAllInText(
  pattern: string,
  text: string,
  foldCase = false,
  opts: FindOptions = {},
): readonly Match[] {
  return Matcher.compile(pattern, foldCase).findAll(decodeText(text), opts).matches;
}

export { decodeText, decodeUtf8 };
