/**
 * VENDORED FROM VELUM — DO NOT EDIT.
 *
 *   source: src/core/pike/index.ts
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
 * A backtracking-free regular expression engine with UTF-8 byte spans. See
 * `vm.ts` for the complexity argument and `syntax.ts` for the supported
 * grammar.
 */
export {
  PATTERN_LIMITS, PatternError, parsePattern, classOf, classMatches,
  complementRanges, maxMatchLength, isWordCodePoint,
  type Node, type CharClass, type PatternErrorKind,
} from "./syntax.js";
export { compile, foldCodePoint, type Program, type Inst } from "./program.js";
export {
  Matcher, MatchLimitExceeded, VM_LIMITS, findAllInText,
  type Match, type MatchStats, type FindOptions,
} from "./vm.js";
