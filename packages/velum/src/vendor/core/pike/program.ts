/**
 * VENDORED FROM VELUM — DO NOT EDIT.
 *
 *   source: src/core/pike/program.ts
 *   commit: 5f6738b1e9a6b6ae4e4d54c269f460323bb72254
 *   sync:   node scripts/sync-velum.mjs --sync
 *   verify: node scripts/sync-velum.mjs --check
 *
 * Edits here are erased by the next sync and fail `--check` before then. The
 * boundary that uses this engine is packages/server/src/trust.ts; the contract
 * it reports against is packages/contracts/src/velum.ts.
 */
/**
 * Velum — NFA program and compiler.
 * ============================================================
 * Thompson construction: the AST becomes a flat instruction list executed by
 * the Pike VM in `vm.ts`. Six instructions, no more:
 *
 *   `char`   consume one code point matching a class
 *   `any`    consume one code point
 *   `split`  fork into two threads at the same input position
 *   `jmp`    unconditional branch
 *   `assert` zero-width test against the position
 *   `match`  the thread has matched
 *
 * `split` carries its branches in priority order, which is the whole of the
 * greedy/lazy distinction: a greedy `a*` splits to *body first*, a lazy `a*?`
 * splits to *exit first*, and the VM's first-wins ordering does the rest. No
 * backtracking is involved either way, so `(a+)+b` against a long run of `a`
 * costs the same as any other pattern of its size.
 *
 * Bounded repeats `{n,m}` are expanded at compile time into `n` copies plus
 * `m - n` optional copies, which is why `maxInstructions` is a real limit and
 * `maxRepeat` is small. Expansion is the honest cost: a counter-based repeat
 * would need per-thread counter state, and per-thread state is what makes a
 * thread-set simulation stop being linear.
 *
 * Expansion is also why `maxInstructions` alone does not bound compilation. A
 * lookahead body compiles into its own emitter, so it gets its own instruction
 * budget; a bounded repeat around that lookahead recompiles the body once per
 * copy; nesting multiplies. Every emitter in one `compile()` therefore shares a
 * single `CompileBudget`, and `PATTERN_LIMITS.maxCompileWork` is the number
 * that actually makes the work finite.
 *
 * Ported from the operator-owned ABAIYA implementation (`abaiya-policy`
 * `matcher.rs`, `RootZ3n/abaiya` at `a471252`).
 */
import {
  PATTERN_LIMITS,
  PatternError,
  classOf,
  complementRanges,
  parsePattern,
  type CharClass,
  type Node,
} from "./syntax.js";

export type Inst =
  | { readonly op: "char"; readonly set: CharClass }
  | { readonly op: "any" }
  | { readonly op: "split"; readonly x: number; readonly y: number }
  | { readonly op: "jmp"; readonly to: number }
  | { readonly op: "assert"; readonly kind: "start" | "end" | "word-boundary" | "not-word-boundary" }
  /**
   * Zero-width lookahead over a separately compiled program.
   *
   * The body is its own `Program` rather than inline instructions, so the outer
   * thread set never contains a lookahead's states. It carries no length bound:
   * the VM matches it anchored and stops when its thread set dies, which is
   * what makes the assertion mean what it says instead of what a window allows.
   */
  | { readonly op: "look"; readonly negated: boolean; readonly body: Program }
  | { readonly op: "match" };

export interface Program {
  readonly insts: readonly Inst[];
  /** Case-insensitive matching folds both the pattern and the input. */
  readonly foldCase: boolean;
  /** The pattern source, for diagnostics. Never a matched value. */
  readonly source: string;
  /**
   * Code points a match may begin with, or null when anything may.
   *
   * A prefilter, and the reason a clean megabyte of evidence is affordable. An
   * unanchored search seeds a thread at pc 0 at *every* input position, and for
   * a pattern that opens with an alternation of literals — the registry is full
   * of them, `(?:reveal|show|print|output|dump|leak|list|give\s+me)` and its
   * relatives — that walks the entire split tree at every byte before the first
   * character rules almost all of it out. Measured across the forty-five
   * shipped patterns that came to 295 VM steps per input byte, which put a one
   * megabyte log at six and a half seconds and a four megabyte repository
   * packet past the aggregate ceiling entirely.
   *
   * The set is computed from the compiled program rather than the AST, so case
   * folding and class negation are already applied, and it is a **superset** of
   * the code points a match can start with: a position it excludes cannot begin
   * a match, so skipping it removes nothing. Null means the question has no
   * useful answer — the program can match empty, or can start with `.` — and
   * every position is seeded as before.
   */
  readonly first: CharClass | null;
}

/** ASCII-only case folding, matching the reference implementation's `i` flag. */
export function foldCodePoint(cp: number): number {
  if (cp >= 0x41 && cp <= 0x5a) return cp + 32;
  // Non-ASCII folding is deliberately absent: the reference patterns are ASCII,
  // and a partial Unicode fold would make two implementations disagree on
  // exactly the inputs an attacker controls.
  return cp;
}

function foldClass(set: CharClass): CharClass {
  const ranges: [number, number][] = set.ranges.map((r) => [r[0], r[1]]);
  for (const [lo, hi] of set.ranges) {
    // Add the lowercase image of any uppercase span, and vice versa, so the
    // class matches either case without folding the input's non-ASCII bytes.
    const upLo = Math.max(lo, 0x41);
    const upHi = Math.min(hi, 0x5a);
    if (upLo <= upHi) ranges.push([upLo + 32, upHi + 32]);
    const loLo = Math.max(lo, 0x61);
    const loHi = Math.min(hi, 0x7a);
    if (loLo <= loHi) ranges.push([loLo - 32, loHi - 32]);
  }
  return classOf(ranges, set.negated);
}

/**
 * Work spent across one whole compilation.
 *
 * Shared by every emitter a `compile()` call creates, including the ones made
 * for lookahead bodies. Per-emitter `maxInstructions` bounds a *program*; this
 * bounds the *compilation*, and those are not the same number once a bounded
 * repeat can recompile a lookahead body once per copy.
 */
class CompileBudget {
  private spent = 0;

  charge(units: number): void {
    this.spent += units;
    if (this.spent > PATTERN_LIMITS.maxCompileWork) {
      throw new PatternError(
        "too-many-instructions",
        `compilation exceeds ${PATTERN_LIMITS.maxCompileWork} work units`,
        0,
      );
    }
  }
}

class Emitter {
  readonly insts: Inst[] = [];
  readonly foldCase: boolean;
  readonly budget: CompileBudget;

  constructor(foldCase: boolean, budget: CompileBudget) {
    this.foldCase = foldCase;
    this.budget = budget;
  }

  emit(inst: Inst): number {
    this.budget.charge(1);
    if (this.insts.length >= PATTERN_LIMITS.maxInstructions) {
      throw new PatternError(
        "too-many-instructions",
        `program exceeds ${PATTERN_LIMITS.maxInstructions} instructions`,
        0,
      );
    }
    this.insts.push(inst);
    return this.insts.length - 1;
  }

  patch(at: number, inst: Inst): void {
    this.insts[at] = inst;
  }

  get here(): number {
    return this.insts.length;
  }
}

function compileNode(node: Node, e: Emitter): void {
  switch (node.t) {
    case "empty":
      return;

    case "lit": {
      const cp = e.foldCase ? foldCodePoint(node.cp) : node.cp;
      const set = e.foldCase
        ? foldClass(classOf([[cp, cp]]))
        : classOf([[node.cp, node.cp]]);
      e.emit({ op: "char", set });
      return;
    }

    case "any":
      e.emit({ op: "any" });
      return;

    case "class":
      e.emit({ op: "char", set: e.foldCase ? foldClass(node.set) : node.set });
      return;

    case "assert":
      e.emit({ op: "assert", kind: node.kind });
      return;

    case "look": {
      const inner = new Emitter(e.foldCase, e.budget);
      compileNode(node.item, inner);
      inner.emit({ op: "match" });
      e.emit({
        op: "look",
        negated: node.negated,
        // A lookahead body is matched anchored, so a first-set prefilter would
        // never be consulted; `null` says so rather than computing one.
        body: { insts: inner.insts, foldCase: e.foldCase, source: "(lookahead)", first: null },
      });
      return;
    }

    case "cat":
      for (const item of node.items) compileNode(item, e);
      return;

    case "alt": {
      // Left-to-right priority: the first alternative that can match wins,
      // which is what the reference engines do and what the fixtures expect.
      const jumps: number[] = [];
      for (let k = 0; k < node.items.length; k++) {
        const last = k === node.items.length - 1;
        if (last) {
          compileNode(node.items[k] as Node, e);
        } else {
          const split = e.emit({ op: "split", x: 0, y: 0 });
          const bodyStart = e.here;
          compileNode(node.items[k] as Node, e);
          jumps.push(e.emit({ op: "jmp", to: 0 }));
          e.patch(split, { op: "split", x: bodyStart, y: e.here });
        }
      }
      const end = e.here;
      for (const j of jumps) e.patch(j, { op: "jmp", to: end });
      return;
    }

    case "rep": {
      const { item, min, max, greedy } = node;

      for (let k = 0; k < min; k++) compileNode(item, e);

      if (max === null) {
        // `x*` / `x+` tail: split → body → jmp back to the split.
        const split = e.emit({ op: "split", x: 0, y: 0 });
        const bodyStart = e.here;
        compileNode(item, e);
        e.emit({ op: "jmp", to: split });
        const after = e.here;
        e.patch(
          split,
          greedy ? { op: "split", x: bodyStart, y: after } : { op: "split", x: after, y: bodyStart },
        );
        return;
      }

      const optional = max - min;
      if (optional <= 0) return;
      // `{n,m}` expands to m-n nested optionals, each able to skip to the end.
      const splits: number[] = [];
      for (let k = 0; k < optional; k++) {
        const split = e.emit({ op: "split", x: 0, y: 0 });
        splits.push(split);
        const bodyStart = e.here;
        compileNode(item, e);
        e.patch(
          split,
          greedy
            ? { op: "split", x: bodyStart, y: -1 }
            : { op: "split", x: -1, y: bodyStart },
        );
      }
      const end = e.here;
      for (const s of splits) {
        const inst = e.insts[s] as Extract<Inst, { op: "split" }>;
        e.patch(s, {
          op: "split",
          x: inst.x === -1 ? end : inst.x,
          y: inst.y === -1 ? end : inst.y,
        });
      }
      return;
    }
  }
}

/**
 * The code points a match may begin with, or null when anything may.
 *
 * Walks the epsilon closure of pc 0. Zero-width instructions are stepped
 * through rather than treated as terminal, so `^abc` still reports `a` and a
 * leading lookahead does not defeat the filter. Reaching `match` in that
 * closure means the program can match the empty string, and `any` means every
 * code point qualifies; both answer "no useful filter".
 */
function firstSetOf(insts: readonly Inst[]): CharClass | null {
  const seen = new Uint8Array(insts.length);
  const stack: number[] = [0];
  const ranges: [number, number][] = [];
  while (stack.length > 0) {
    const p = stack.pop() as number;
    if (p < 0 || p >= insts.length || seen[p] === 1) continue;
    seen[p] = 1;
    const inst = insts[p] as Inst;
    switch (inst.op) {
      case "jmp": stack.push(inst.to); break;
      case "split": stack.push(inst.x); stack.push(inst.y); break;
      // Zero-width: whether it holds is a property of the position, not of the
      // next code point, so the closure continues past it.
      case "assert": case "look": stack.push(p + 1); break;
      case "char": {
        const set = inst.set;
        for (const r of (set.negated ? complementRanges(set.ranges) : set.ranges)) {
          ranges.push([r[0], r[1]]);
        }
        break;
      }
      // Anything may begin a match, or the match may be empty. Either way there
      // is nothing to filter on.
      case "any": return null;
      case "match": return null;
    }
  }
  return ranges.length === 0 ? null : classOf(ranges);
}

/** Compile a pattern into a program. Throws `PatternError` and nothing else. */
export function compile(pattern: string, foldCase = false): Program {
  const ast = parsePattern(pattern);
  const e = new Emitter(foldCase, new CompileBudget());
  compileNode(ast, e);
  e.emit({ op: "match" });
  return { insts: e.insts, foldCase, source: pattern, first: firstSetOf(e.insts) };
}
