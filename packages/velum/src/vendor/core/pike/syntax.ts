/**
 * VENDORED FROM VELUM — DO NOT EDIT.
 *
 *   source: src/core/pike/syntax.ts
 *   commit: 5f6738b1e9a6b6ae4e4d54c269f460323bb72254
 *   sync:   node scripts/sync-velum.mjs --sync
 *   verify: node scripts/sync-velum.mjs --check
 *
 * Edits here are erased by the next sync and fail `--check` before then. The
 * boundary that uses this engine is packages/server/src/trust.ts; the contract
 * it reports against is packages/contracts/src/velum.ts.
 */
/**
 * Velum — pattern syntax for the Pike VM.
 * ============================================================
 * A small, explicit regular language. Every construct listed below is
 * supported; **everything else is rejected at compile time** rather than
 * approximated, because a pattern that silently means something other than what
 * it says is worse than one that refuses to compile.
 *
 * Supported:
 *
 *   literal          `a`, `é`, `🚀`            (any code point)
 *   any              `.`                      (any code point, including newline)
 *   class            `[a-z0-9_]`, `[^\s]`     (ranges, negation, escapes)
 *   escapes          `\d \D \w \W \s \S`      (ASCII-defined, as in the reference)
 *                    `\b \B`                  (word boundary / non-boundary)
 *                    `\n \r \t \f \v \0`
 *                    `\\ \. \* \+ \? \( \) \[ \] \{ \} \| \^ \$ \/ \- \:`
 *   group            `( … )`, `(?: … )`       (both non-capturing; see below)
 *   alternation      `a|b`
 *   quantifiers      `* + ?` and `{n} {n,} {n,m}`, greedy or lazy (`*?`)
 *   anchors          `^ $`                    (string start / end)
 *   bounded lookahead `(?= … )`, `(?! … )`     see below
 *
 * ## Lookahead is evaluated, not approximated
 *
 * Two reference patterns use negative lookahead purely to suppress false
 * positives — `pretend you are (?!working|busy|done|a\s+helpful)` exists so
 * "pretend you are working on it" is not an injection.
 *
 * That last alternative can match unbounded input, and two earlier revisions of
 * this file got it wrong in opposite directions. The first accepted it and
 * silently evaluated the assertion over a 64 code point prefix, which made
 * `pretend you are a` followed by 57 spaces and `helpful` stop being suppressed
 * — an attacker-controlled false positive produced by pressing the space bar.
 * The second refused the pattern and bounded the body in the registry as
 * `a\s{1,56}helpful`, which moved the same bypass from the engine into the
 * rule and left it a bypass.
 *
 * A lookahead body is a regular language, and an anchored match of a regular
 * language is decidable in one forward pass with no backtracking. So it is
 * simply evaluated: the body runs anchored at the assertion's position and
 * stops when its thread set empties, when it matches, or at end of input.
 * There is no window, and the assertion means exactly what it says over the
 * whole supported input domain.
 *
 * What that costs is stated rather than hidden. An assertion whose body can
 * match unbounded input costs `O(remaining input × body)` at each position it
 * is *reached from*, so a pattern can be `O(input² × program)` in the worst
 * case. Two things make that finite and observable: the body's thread set dies
 * as soon as the input stops matching it — `a\s+helpful` survives exactly as
 * long as the whitespace run — and every step is charged to the shared budget
 * in `vm.ts`, which fails closed with a typed `MatchLimitExceeded` rather than
 * running long. Linear-time matching is a property of the patterns that do not
 * use unbounded lookahead, and it is no longer claimed of the ones that do.
 *
 * ## Repetition of a possibly-empty body is refused
 *
 * `(a*?)*` is where this engine and the reference engines disagree, and the
 * disagreement is not fixable by choosing a different traversal: the reference
 * behaviour comes from a backtracking rule ("an iteration that consumed nothing
 * ends the loop") that a thread-set simulation has no place to put. The two
 * honest options are to implement backtracking or to refuse the construct, and
 * a repetition whose body can match empty is ambiguous to a reader as well as
 * to the engine — `(a*)+` on `aaa` has no answer anyone can predict.
 *
 * So a quantifier whose body can match the empty string is a compile-time
 * error, in every flavour — `*`, `+`, `?`, `{n,m}`, greedy or lazy. An earlier
 * revision exempted `?` on the reasoning that one optional iteration of a
 * nullable body is just the body; a randomised differential run disagreed, and
 * every one of its fifteen surviving divergences was `(?:…)?` over a nullable
 * alternation. No pattern in the shipped registry uses the refused form.
 *
 * Rejected, by name, with a typed error:
 *
 *   backreference    `\1`        — needs backtracking; not expressible in an NFA
 *   nullable repeat  `(a*)*`     — see above
 *   lookbehind       `(?<= (?<!` — needs a reversed automaton
 *   named group      `(?<n> …`   — captures are not offered at all
 *   unicode property `\p{…}`     — would silently mean a different set here
 *   inline flags     `(?i) …`    — flags are compile arguments, not syntax
 *
 * ## Captures are not offered
 *
 * `( … )` groups for precedence and nothing else. Velum reports whole-match
 * spans; a finding says *where the pattern matched*, and a sub-span of a match
 * is not a fact any consumer of a finding has asked for. Refusing to offer them
 * keeps the VM's thread state to a program counter, which is what makes the
 * step bound trivially provable.
 *
 * Ported from the operator-owned ABAIYA implementation (`abaiya-policy`,
 * `RootZ3n/abaiya` at `a471252`) — semantics, not syntax.
 */

export type PatternErrorKind =
  | "unsupported-construct"
  | "malformed-pattern"
  | "pattern-too-long"
  | "too-many-instructions"
  | "repetition-too-large";

export class PatternError extends Error {
  readonly kind: PatternErrorKind;
  /** Code-point offset into the pattern where the problem was found. */
  readonly at: number;

  constructor(kind: PatternErrorKind, message: string, at: number) {
    super(`${message} (at ${at})`);
    this.name = "PatternError";
    this.kind = kind;
    this.at = at;
  }
}

/** Bounds. A pattern is authored; these are generous and still finite. */
export const PATTERN_LIMITS = Object.freeze({
  /** Code points in the pattern source. */
  maxPatternChars: 4_096,
  /** Compiled instructions. */
  maxInstructions: 8_192,
  /** The `m` in `{n,m}`; a bounded repeat expands to that many copies. */
  maxRepeat: 1_000,
  /**
   * Total compile work units, across a pattern and every lookahead body in it.
   *
   * `maxInstructions` bounds one emitter. It does not bound a compilation,
   * because a lookahead body is compiled into its own emitter with its own
   * fresh budget, and a bounded repeat around a lookahead recompiles that body
   * once per copy. Nesting multiplies: `(?=(?=(?=a{60}){60}){60})` is
   * twenty-five characters, leaves the outer program at two instructions, and
   * cost seventy milliseconds — rising with the cube of the repeat bound, so
   * the same shape at the permitted `{1000}` runs for minutes. This ceiling is
   * shared by every emitter in one `compile()` call and is what actually makes
   * compilation finite.
   */
  maxCompileWork: 200_000,
});

// ── AST ─────────────────────────────────────────────────────────────────────

export type Node =
  | { readonly t: "empty" }
  | { readonly t: "lit"; readonly cp: number }
  | { readonly t: "any" }
  | { readonly t: "class"; readonly set: CharClass }
  | { readonly t: "cat"; readonly items: readonly Node[] }
  | { readonly t: "alt"; readonly items: readonly Node[] }
  | { readonly t: "rep"; readonly item: Node; readonly min: number; readonly max: number | null; readonly greedy: boolean }
  | { readonly t: "assert"; readonly kind: "start" | "end" | "word-boundary" | "not-word-boundary" }
  | { readonly t: "look"; readonly negated: boolean; readonly item: Node };

/** A character class as ranges over code points, plus a negation flag. */
export interface CharClass {
  readonly negated: boolean;
  /** Sorted, non-overlapping `[lo, hi]` inclusive ranges. */
  readonly ranges: readonly (readonly [number, number])[];
}

const CP = (c: string): number => c.codePointAt(0) as number;

const DIGIT: readonly (readonly [number, number])[] = [[CP("0"), CP("9")]];
const WORD: readonly (readonly [number, number])[] = [
  [CP("0"), CP("9")], [CP("A"), CP("Z")], [CP("_"), CP("_")], [CP("a"), CP("z")],
];
const SPACE: readonly (readonly [number, number])[] = [
  [0x09, 0x0d], [0x20, 0x20], [0x85, 0x85], [0xa0, 0xa0], [0x1680, 0x1680],
  [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000],
];

/**
 * Longest match the node can produce, in code points. `Infinity` for unbounded.
 *
 * Used to prove a lookahead body is finite before accepting it.
 */
export function maxMatchLength(node: Node): number {
  switch (node.t) {
    case "empty":
    case "assert":
    case "look":
      return 0;
    case "lit":
    case "any":
    case "class":
      return 1;
    case "cat":
      return node.items.reduce((sum, n) => sum + maxMatchLength(n), 0);
    case "alt":
      return node.items.reduce((best, n) => Math.max(best, maxMatchLength(n)), 0);
    case "rep": {
      if (node.max === null) return Infinity;
      // `{0}` over an unbounded body: `0 * Infinity` is NaN in JavaScript, and
      // NaN silently defeats every comparison it reaches. It reached the
      // lookahead window, where `pos >= NaN` is false forever, so the scan ran
      // past the end of the cell table and died on a TypeError instead of a
      // PatternError. A repeat of zero copies matches zero code points; say so.
      if (node.max === 0) return 0;
      const inner = maxMatchLength(node.item);
      return inner === Infinity ? Infinity : node.max * inner;
    }
  }
}

/**
 * Can this node match the empty string?
 *
 * Used to refuse a repetition whose body may consume nothing. Conservative in
 * the safe direction only where it has to be: a `rep` with `min === 0` is
 * nullable by definition, and one with a nullable body is nullable however many
 * times it runs.
 */
export function canMatchEmpty(node: Node): boolean {
  switch (node.t) {
    case "empty":
    case "assert":
    case "look":
      return true;
    case "lit":
    case "any":
    case "class":
      return false;
    case "cat":
      return node.items.every((n) => canMatchEmpty(n));
    case "alt":
      return node.items.some((n) => canMatchEmpty(n));
    case "rep":
      return node.min === 0 || canMatchEmpty(node.item);
  }
}

export function classOf(ranges: readonly (readonly [number, number])[], negated = false): CharClass {
  return { negated, ranges: normalizeRanges(ranges) };
}

function normalizeRanges(
  ranges: readonly (readonly [number, number])[],
): readonly (readonly [number, number])[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

/**
 * Complement a range list over the whole code point space.
 *
 * Exact, not approximate. It exists so a negated shorthand inside a class —
 * `[\s\S]`, the "any character including newline" idiom the reference
 * credential patterns use — can be turned into a real union rather than
 * refused. Approximating it would have been the alternative, and an
 * approximated character class is a detector that disagrees with its own
 * corpus on inputs nobody chose.
 */
export function complementRanges(
  ranges: readonly (readonly [number, number])[],
): readonly (readonly [number, number])[] {
  const sorted = normalizeRanges(ranges);
  const out: [number, number][] = [];
  let cursor = 0;
  for (const [lo, hi] of sorted) {
    if (lo > cursor) out.push([cursor, lo - 1]);
    cursor = Math.max(cursor, hi + 1);
  }
  if (cursor <= 0x10ffff) out.push([cursor, 0x10ffff]);
  return out;
}

export function classMatches(set: CharClass, cp: number): boolean {
  if (cp < 0) return false; // an invalid byte matches nothing, negated or not
  let inSet = false;
  // Linear over ranges. Classes here are small and fixed at compile time; a
  // binary search would be faster and harder to be sure of.
  for (const [lo, hi] of set.ranges) {
    if (cp < lo) break;
    if (cp <= hi) {
      inSet = true;
      break;
    }
  }
  return set.negated ? !inSet : inSet;
}

export function isWordCodePoint(cp: number): boolean {
  return cp >= 0 && classMatches({ negated: false, ranges: WORD }, cp);
}

// ── parser ──────────────────────────────────────────────────────────────────

/**
 * Parse a pattern into an AST.
 *
 * Recursive descent over code points. The grammar is:
 *
 *   alt   := cat ('|' cat)*
 *   cat   := rep*
 *   rep   := atom quantifier?
 *   atom  := '(' alt ')' | '[' class ']' | '.' | escape | literal | anchor
 */
export function parsePattern(pattern: string): Node {
  const cps = [...pattern].map((c) => c.codePointAt(0) as number);
  if (cps.length > PATTERN_LIMITS.maxPatternChars) {
    throw new PatternError(
      "pattern-too-long",
      `pattern has ${cps.length} code points, past the ${PATTERN_LIMITS.maxPatternChars} cap`,
      0,
    );
  }

  let i = 0;
  const peek = (): number | undefined => cps[i];
  const eat = (): number => cps[i++] as number;

  function parseAlt(): Node {
    const items: Node[] = [parseCat()];
    while (peek() === CP("|")) {
      i += 1;
      items.push(parseCat());
    }
    return items.length === 1 ? (items[0] as Node) : { t: "alt", items };
  }

  function parseCat(): Node {
    const items: Node[] = [];
    for (;;) {
      const c = peek();
      if (c === undefined || c === CP("|") || c === CP(")")) break;
      items.push(parseRep());
    }
    if (items.length === 0) return { t: "empty" };
    return items.length === 1 ? (items[0] as Node) : { t: "cat", items };
  }

  function parseRep(): Node {
    const atom = parseAtom();
    for (;;) {
      const c = peek();
      let min: number;
      let max: number | null;
      if (c === CP("*")) { i += 1; min = 0; max = null; }
      else if (c === CP("+")) { i += 1; min = 1; max = null; }
      else if (c === CP("?")) { i += 1; min = 0; max = 1; }
      else if (c === CP("{")) {
        const save = i;
        const bounds = tryParseBounds();
        if (bounds === null) { i = save; break; }
        [min, max] = bounds;
      } else break;

      let greedy = true;
      if (peek() === CP("?")) { i += 1; greedy = false; }
      else if (peek() === CP("+")) {
        // Possessive quantifiers need a cut, which an NFA simulation has no
        // way to express. Rejected rather than silently treated as greedy.
        throw new PatternError("unsupported-construct", "possessive quantifier `++`", i);
      }
      // A quantifier over a body that can match nothing is where this engine and
      // the reference engines disagree, and the disagreement is structural:
      // their answer comes from a backtracking rule that ends a loop on an
      // iteration which consumed nothing, and a thread-set simulation has
      // nowhere to put it. `(a*?)*` on `aa` produced three matches here and one
      // there.
      //
      // The rule was once narrower — only quantifiers that could run more than
      // once — on the reasoning that `(a*)?` is just `a*` and has nothing to be
      // ambiguous about. A randomised differential run against the reference
      // engine said otherwise: all fifteen surviving divergences in 10,700
      // compared pairs were `(?:…)?` over a nullable *alternation*, where a
      // zero-width branch competes with a consuming one and the two engines
      // resolve the priority differently. So the whole class is refused, in
      // every quantifier flavour, and unsupported means refused rather than
      // approximately executed.
      if (canMatchEmpty(atom)) {
        throw new PatternError(
          "unsupported-construct",
          "quantifier over a possibly-empty subexpression, such as `(a*)*`, `(a?){2,}` " +
          "or `(?:\\b|x)?`; give the body something it must consume",
          i,
        );
      }
      return { t: "rep", item: atom, min, max, greedy };
    }
    return atom;
  }

  /** `{n}` `{n,}` `{n,m}`. Returns null when the brace is a literal. */
  function tryParseBounds(): [number, number | null] | null {
    if (peek() !== CP("{")) return null;
    i += 1;
    const readInt = (): number | null => {
      let s = "";
      while (i < cps.length && (cps[i] as number) >= CP("0") && (cps[i] as number) <= CP("9")) {
        s += String.fromCodePoint(eat());
      }
      return s === "" ? null : Number(s);
    };
    const min = readInt();
    if (min === null) return null;
    let max: number | null = min;
    if (peek() === CP(",")) {
      i += 1;
      max = readInt();
    }
    if (peek() !== CP("}")) return null;
    i += 1;
    const bound = max ?? min;
    if (bound > PATTERN_LIMITS.maxRepeat || min > PATTERN_LIMITS.maxRepeat) {
      throw new PatternError(
        "repetition-too-large",
        `repetition bound ${bound} exceeds ${PATTERN_LIMITS.maxRepeat}`,
        i,
      );
    }
    if (max !== null && max < min) {
      throw new PatternError("malformed-pattern", `repetition {${min},${max}} is empty`, i);
    }
    return [min, max];
  }

  function parseAtom(): Node {
    const c = peek();
    if (c === undefined) return { t: "empty" };

    if (c === CP("(")) {
      i += 1;
      if (peek() === CP("?")) {
        const next = cps[i + 1];
        if (next === CP(":")) {
          i += 2;
        } else if (next === CP("=") || next === CP("!")) {
          const negated = next === CP("!");
          i += 2;
          const body = parseAlt();
          if (peek() !== CP(")")) throw new PatternError("malformed-pattern", "unclosed lookahead", i);
          i += 1;
          // No bound is imposed and none is needed. The body is a regular
          // language; the VM matches it anchored, in one forward pass, and
          // stops when its thread set empties. Every step is charged to the
          // shared budget, so the cost is finite and observable rather than
          // capped by a number that silently changes what the pattern means.
          return { t: "look", negated, item: body };
        } else if (next === CP("<")) {
          const after = cps[i + 2];
          throw new PatternError(
            "unsupported-construct",
            after === CP("=") || after === CP("!") ? "lookbehind `(?<=` / `(?<!`" : "named group `(?<name>`",
            i,
          );
        } else {
          throw new PatternError("unsupported-construct", "inline group flags `(?…)`", i);
        }
      }
      const inner = parseAlt();
      if (peek() !== CP(")")) throw new PatternError("malformed-pattern", "unclosed group", i);
      i += 1;
      return inner;
    }

    if (c === CP(")")) throw new PatternError("malformed-pattern", "unmatched `)`", i);
    if (c === CP("[")) return parseClass();
    if (c === CP(".")) { i += 1; return { t: "any" }; }
    if (c === CP("^")) { i += 1; return { t: "assert", kind: "start" }; }
    if (c === CP("$")) { i += 1; return { t: "assert", kind: "end" }; }
    if (c === CP("*") || c === CP("+") || c === CP("?")) {
      throw new PatternError("malformed-pattern", "quantifier with nothing to repeat", i);
    }
    if (c === CP("\\")) return parseEscape();

    i += 1;
    return { t: "lit", cp: c };
  }

  function parseEscape(): Node {
    i += 1; // consume the backslash
    const c = peek();
    if (c === undefined) throw new PatternError("malformed-pattern", "trailing backslash", i);
    i += 1;

    switch (String.fromCodePoint(c)) {
      case "d": return { t: "class", set: classOf(DIGIT) };
      case "D": return { t: "class", set: classOf(DIGIT, true) };
      case "w": return { t: "class", set: classOf(WORD) };
      case "W": return { t: "class", set: classOf(WORD, true) };
      case "s": return { t: "class", set: classOf(SPACE) };
      case "S": return { t: "class", set: classOf(SPACE, true) };
      case "b": return { t: "assert", kind: "word-boundary" };
      case "B": return { t: "assert", kind: "not-word-boundary" };
      case "n": return { t: "lit", cp: 0x0a };
      case "r": return { t: "lit", cp: 0x0d };
      case "t": return { t: "lit", cp: 0x09 };
      case "f": return { t: "lit", cp: 0x0c };
      case "v": return { t: "lit", cp: 0x0b };
      case "0": return { t: "lit", cp: 0x00 };
      case "p": case "P":
        throw new PatternError("unsupported-construct", "Unicode property escape `\\p{…}`", i);
      case "k":
        throw new PatternError("unsupported-construct", "named backreference `\\k<…>`", i);
      case "u": case "x":
        throw new PatternError("unsupported-construct", "numeric escape `\\u`/`\\x`", i);
      default:
        if (c >= CP("1") && c <= CP("9")) {
          throw new PatternError("unsupported-construct", "backreference", i);
        }
        return { t: "lit", cp: c };
    }
  }

  function parseClass(): Node {
    i += 1; // `[`
    let negated = false;
    if (peek() === CP("^")) { negated = true; i += 1; }
    const ranges: [number, number][] = [];
    let first = true;

    for (;;) {
      const c = peek();
      if (c === undefined) throw new PatternError("malformed-pattern", "unclosed character class", i);
      if (c === CP("]") && !first) { i += 1; break; }
      first = false;

      let lo: number;
      if (c === CP("\\")) {
        const node = parseEscape();
        if (node.t === "class") {
          // A negated shorthand contributes its exact complement, so `[\s\S]`
          // is the whole code point space rather than a rejected pattern.
          const contributed = node.set.negated
            ? complementRanges(node.set.ranges)
            : node.set.ranges;
          ranges.push(...(contributed as [number, number][]));
          continue;
        }
        if (node.t !== "lit") {
          throw new PatternError("unsupported-construct", "assertion inside a character class", i);
        }
        lo = node.cp;
      } else {
        i += 1;
        lo = c;
      }

      if (peek() === CP("-") && cps[i + 1] !== undefined && cps[i + 1] !== CP("]")) {
        i += 1;
        const hc = peek() as number;
        let hi: number;
        if (hc === CP("\\")) {
          const node = parseEscape();
          if (node.t !== "lit") {
            throw new PatternError("malformed-pattern", "range end must be a literal", i);
          }
          hi = node.cp;
        } else {
          i += 1;
          hi = hc;
        }
        if (hi < lo) throw new PatternError("malformed-pattern", "reversed class range", i);
        ranges.push([lo, hi]);
      } else {
        ranges.push([lo, lo]);
      }
    }

    if (ranges.length === 0) {
      throw new PatternError("malformed-pattern", "empty character class", i);
    }
    return { t: "class", set: classOf(ranges, negated) };
  }

  const ast = parseAlt();
  if (i < cps.length) throw new PatternError("malformed-pattern", "unexpected trailing input", i);
  return ast;
}
