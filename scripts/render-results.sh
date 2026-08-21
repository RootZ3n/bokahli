#!/usr/bin/env bash
#
# Bokahli — regenerate docs/campaign-2026-08-21/RESULTS.md from the evidence.
#
# The document is a template with a `<!-- TABLES -->` marker; everything between
# that marker and the next heading is replaced by what `campaign-report.mjs`
# renders now. Run it again after more evidence lands and the tables move; the
# prose around them does not.
#
# The point is that no number in the report has a hand-typed provenance. The
# previous campaign's central claims were assembled from terminal scrollback,
# and two of them turned out to be artefacts of the harness that nobody could
# re-derive because the evidence behind them was gone.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
C="${BOKAHLI_CAMPAIGN_DIR:-$HOME/.local/state/bokahli/campaign}"
DOC="$REPO/docs/campaign-2026-08-21/RESULTS.md"

{
  sed -n '1,/<!-- TABLES -->/p' "$DOC"
  echo
  node "$REPO/scripts/campaign-report.mjs" \
    --placement "$C/phase5-placement.json" --stage-dir "$C/stage-a"
  echo
  echo "### Refinement sweep — pushing expert offload toward zero"
  echo
  node "$REPO/scripts/campaign-report.mjs" \
    --placement "$C/phase5b-placement.json" --stage-dir /nonexistent \
    | sed -n '/^| artifact/,/^$/p' | head -n -1
  echo
  if [ -d "$C/stage-b" ]; then
    echo "## Stage B — the full 19-fixture pack, survivors only"
    echo
    node "$REPO/scripts/campaign-report.mjs" \
      --placement /nonexistent --stage-dir "$C/stage-b" \
      | sed -n '/^## Stage A/,$p' | sed 's/^## Stage A — both regimes, never pooled$/### Outcomes/'
    echo
  fi
  sed -n '/^## Notes on reading the placement table/,$p' "$DOC"
} > "$DOC.new"
mv "$DOC.new" "$DOC"
echo "rendered $DOC"
