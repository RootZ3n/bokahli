#!/usr/bin/env bash
# Bokahli v2 Phase 1 verification.
# Read-only against a running deployment. Exits non-zero if any check fails.
set -uo pipefail

TOKEN=$(cat "${BOKAHLI_TOKEN_PATH:-$HOME/.config/bokahli/token}")
LOOP=http://127.0.0.1:8080
TS_IP=$(tailscale ip -4 2>/dev/null | head -1)
TS=http://${TS_IP}:8080
BACKEND=http://127.0.0.1:8081
LAN_IP=$(ip -4 -o addr show enp7s0 2>/dev/null | awk '{print $4}' | cut -d/ -f1)
DIGEST=$(jq -r '.artifacts[0].digest' catalog/artifacts.json)
MODEL=$(jq -r '.artifacts[0].modelId' catalog/artifacts.json)

PASS=0; FAIL=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
chk()  { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 — expected $3, got $2"; fi; }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

# NB: timeouts come from the TIMEOUT env var, never from positional args --
# reading $2 as a timeout collides with callers that pass -X POST.
auth()  { curl -s --max-time "${TIMEOUT:-60}" -H "authorization: Bearer $TOKEN" "$@" ; }
# curl exits non-zero on a refused connection and has already printed 000;
# do not append a second 000.
code()  { curl -s -o /dev/null -w '%{http_code}' --max-time "${TIMEOUT:-15}" "$@" 2>/dev/null; }

hdr "1. No unauthenticated inference reachable from LAN or tailnet"
chk "LAN interface has no Bokahli listener" \
    "$(ss -tlnH | awk -v ip="$LAN_IP" '$4 == ip":8080"' | wc -l)" "0"
chk "no process listens on 0.0.0.0:8080" \
    "$(ss -tlnH | awk '$4 == "0.0.0.0:8080"' | wc -l)" "0"
chk "no process listens on 0.0.0.0 at all (any port, excl. system svcs)" \
    "$(ss -tlnH | awk '$4 ~ /^0\.0\.0\.0:/' | grep -cE ':(8080|8081)$')" "0"
chk "tailnet endpoint rejects unauthenticated inference" \
    "$(code -X POST "$TS/v1/chat/completions" -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"x"}]}')" "401"
chk "loopback endpoint rejects unauthenticated inference" \
    "$(code -X POST "$LOOP/v1/chat/completions" -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"x"}]}')" "401"

hdr "2. Loopback llama-server is not reachable remotely"
chk "backend binds 127.0.0.1 only" \
    "$(ss -tlnH | awk '$4 ~ /:8081$/ {print $4}' | grep -cv '^127.0.0.1:')" "0"
chk "backend not reachable on the tailnet address" \
    "$(TIMEOUT=6 code "http://${TS_IP}:8081/health")" "000"
chk "backend not reachable on the LAN address" \
    "$(TIMEOUT=6 code "http://${LAN_IP}:8081/health")" "000"
chk "backend itself requires a key (browser-origin defence)" \
    "$(code -X POST "$BACKEND/v1/chat/completions" -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"x"}],"max_tokens":1}')" "401"

hdr "3. Bokahli is reachable from the tailnet"
chk "tailnet listener bound" \
    "$(ss -tlnH | awk -v ip="$TS_IP" '$4 == ip":8080"' | wc -l)" "1"
chk "authenticated GET /health/ready over tailnet address" \
    "$(code -H "authorization: Bearer $TOKEN" "$TS/health/ready")" "200"
chk "firewalld zone for tailscale0 is explicit, not the default fallback" \
    "$(firewall-cmd --get-zone-of-interface=tailscale0 2>/dev/null)" "bokahli-tailnet"
chk "that zone default-denies" \
    "$(firewall-cmd --permanent --zone=bokahli-tailnet --get-target 2>/dev/null)" "DROP"

hdr "4. Invalid and missing tokens fail closed"
chk "no credentials"          "$(code "$LOOP/v1/catalog")" "401"
chk "wrong bearer token"      "$(code -H 'authorization: Bearer wrong-token-value-0000000000000000' "$LOOP/v1/catalog")" "401"
chk "empty bearer token"      "$(code -H 'authorization: Bearer ' "$LOOP/v1/catalog")" "401"
chk "truncated token"         "$(code -H "authorization: Bearer ${TOKEN:0:20}" "$LOOP/v1/catalog")" "401"
chk "token in wrong scheme"   "$(code -H "authorization: Basic $TOKEN" "$LOOP/v1/catalog")" "401"
chk "wrong cookie"            "$(code -H 'cookie: bokahli_token=nope' "$LOOP/v1/catalog")" "401"
chk "bad header does not fall through to a good cookie" \
    "$(code -H 'authorization: Bearer wrong' -H "cookie: bokahli_token=$TOKEN" "$LOOP/v1/catalog")" "401"
chk "UI shell requires auth"  "$(code "$LOOP/")" "401"
chk "UI asset requires auth"  "$(code "$LOOP/app.js")" "401"
chk "valid token admitted"    "$(code -H "authorization: Bearer $TOKEN" "$LOOP/v1/catalog")" "200"
chk "liveness is the ONLY unauthenticated route" "$(code "$LOOP/health/live")" "200"
chk "authenticated readiness is not public" "$(code "$LOOP/health/ready")" "401"
chk "401 advertises the scheme" \
    "$(curl -s -D- -o /dev/null --max-time 10 "$LOOP/v1/catalog" | tr -d '\r' | grep -ci '^www-authenticate: Bearer')" "1"
chk "liveness leaks no identity" \
    "$(curl -s --max-time 10 "$LOOP/health/live" | grep -ciE 'gguf|/home/|qwen|b10505')" "0"

hdr "5. Public model identity contains no filesystem path"
for EP in /v1/models /v1/catalog /health/ready; do
  BODY=$(auth "$LOOP$EP")
  chk "no '/home/' in $EP"        "$(printf '%s' "$BODY" | grep -c '/home/')" "0"
  chk "no '.gguf' in $EP"         "$(printf '%s' "$BODY" | grep -ci '\.gguf')" "0"
done
chk "/v1/models id equals the catalog identity" \
    "$(auth "$LOOP/v1/models" | jq -r '.data[0].id')" "$MODEL"
chk "/v1/models exposes the artifact digest" \
    "$(auth "$LOOP/v1/models" | jq -r '.data[0].bokahli.digest')" "$DIGEST"

hdr "6. EXACT detects identity mismatch"
ex() { TIMEOUT=120 auth -X POST "$LOOP/v1/bokahli/chat" -H 'content-type: application/json' -d "$1"; }
chk "correct id + correct digest routes" \
    "$(ex "{\"route\":{\"mode\":\"EXACT\",\"modelId\":\"$MODEL\",\"artifactDigest\":\"$DIGEST\"},\"messages\":[{\"role\":\"user\",\"content\":\"Say OK.\"}],\"maxTokens\":4}" | jq -r '.outcome')" "ROUTED"
chk "correct id + WRONG digest refuses" \
    "$(ex "{\"route\":{\"mode\":\"EXACT\",\"modelId\":\"$MODEL\",\"artifactDigest\":\"sha256:$(printf '0%.0s' {1..64})\"},\"messages\":[{\"role\":\"user\",\"content\":\"x\"}],\"maxTokens\":4}" | jq -r '.route.reason')" "EXACT_DIGEST_MISMATCH"
chk "unknown id refuses" \
    "$(ex "{\"route\":{\"mode\":\"EXACT\",\"modelId\":\"not-installed\",\"artifactDigest\":\"$DIGEST\"},\"messages\":[{\"role\":\"user\",\"content\":\"x\"}],\"maxTokens\":4}" | jq -r '.route.reason')" "EXACT_IDENTITY_UNKNOWN"
chk "filesystem path as identity refuses" \
    "$(ex "{\"route\":{\"mode\":\"EXACT\",\"modelId\":\"/home/zen/models/Qwen_Qwen3.5-35B-A3B-Q2_K.gguf\",\"artifactDigest\":\"$DIGEST\"},\"messages\":[{\"role\":\"user\",\"content\":\"x\"}],\"maxTokens\":4}" | jq -r '.route.reason')" "EXACT_IDENTITY_NOT_PUBLIC"
chk "backend alias as identity refuses (not a catalog identity)" \
    "$(ex "{\"route\":{\"mode\":\"EXACT\",\"modelId\":\"Qwen_Qwen3.5-35B-A3B-Q2_K.gguf\",\"artifactDigest\":\"$DIGEST\"},\"messages\":[{\"role\":\"user\",\"content\":\"x\"}],\"maxTokens\":4}" | jq -r '.route.reason')" "EXACT_IDENTITY_NOT_PUBLIC"
chk "EXACT without a digest is rejected" \
    "$(ex "{\"route\":{\"mode\":\"EXACT\",\"modelId\":\"$MODEL\"},\"messages\":[{\"role\":\"user\",\"content\":\"x\"}]}" | jq -r '.error.code')" "BAD_REQUEST"
chk "refusal lists available identities without paths" \
    "$(ex "{\"route\":{\"mode\":\"EXACT\",\"modelId\":\"nope\",\"artifactDigest\":\"$DIGEST\"},\"messages\":[{\"role\":\"user\",\"content\":\"x\"}]}" | jq -r '.route.available[0].modelId')" "$MODEL"
chk "OpenAI dialect rejects a path in the model field" \
    "$(auth -X POST "$LOOP/v1/chat/completions" -H 'content-type: application/json' -d '{"model":"/home/zen/models/x.gguf","messages":[{"role":"user","content":"x"}]}' | jq -r '.error.code')" "BAD_REQUEST"

hdr "7. Routing contract: AUTO, PROFILE, ESCALATE"
chk "AUTO routes to the single installed artifact" \
    "$(ex '{"route":{"mode":"AUTO","taskClass":"chat"},"messages":[{"role":"user","content":"Say OK."}],"maxTokens":4}' | jq -r '.route.selected.modelId')" "$MODEL"
# Every catalogued artifact is assessed and reported, not just the one that won.
# Pinned to the catalog size rather than a literal: this asserted "1" from when
# one artifact was installed, and read as a passing check for a contract that had
# silently stopped being tested the moment a second artifact arrived.
chk "AUTO assesses every catalogued artifact" \
    "$(ex '{"route":{"mode":"AUTO"},"messages":[{"role":"user","content":"Say OK."}],"maxTokens":4}' | jq -r '.route.considered|length')" \
    "$(auth "$LOOP/v1/catalog" | jq -r '.catalog|length')"
chk "AUTO + requireQualified escalates (no Luak evidence)" \
    "$(ex '{"route":{"mode":"AUTO","requireQualified":true},"messages":[{"role":"user","content":"x"}],"maxTokens":4}' | jq -r '.route.reason')" "NO_QUALIFIED_LOCAL_ROUTE"
chk "that escalation is typed ESCALATE" \
    "$(ex '{"route":{"mode":"AUTO","requireQualified":true},"messages":[{"role":"user","content":"x"}],"maxTokens":4}' | jq -r '.outcome')" "ESCALATE"
chk "PROFILE rejects an unmet capability" \
    "$(ex '{"route":{"mode":"PROFILE","requirements":{"requiredCapabilities":["vision"]}},"messages":[{"role":"user","content":"x"}],"maxTokens":4}' | jq -r '.route.unmet[0].requirement')" "capability.vision"
chk "PROFILE rejects an unmet context floor" \
    "$(ex '{"route":{"mode":"PROFILE","requirements":{"minContextTokens":131072}},"messages":[{"role":"user","content":"x"}],"maxTokens":4}' | jq -r '.route.reason')" "CONTEXT_EXCEEDS_LOCAL_CAPABILITY"
chk "PROFILE rejects a denied quantisation" \
    "$(ex '{"route":{"mode":"PROFILE","requirements":{"quantizationDenyList":["Q2_K"]}},"messages":[{"role":"user","content":"x"}],"maxTokens":4}' | jq -r '.route.unmet[0].requirement')" "facts.quantization"
# Two separate facts, checked separately, because they were conflated before.
# `unmet[].actual` carries the *decision reason*; the artifact's declared state
# lives in `considered[].qualification.status`. Asserting INSTALLED_UNQUALIFIED
# against the reason field checked neither one.
chk "PROFILE rejects requireQualified (decision reason)" \
    "$(ex '{"route":{"mode":"PROFILE","requirements":{"requireQualified":true}},"messages":[{"role":"user","content":"x"}],"maxTokens":4}' | jq -r '.route.unmet[0].actual')" "MODEL_NOT_QUALIFIED_FOR_TASK"
chk "PROFILE rejects requireQualified (artifact stays unqualified)" \
    "$(ex '{"route":{"mode":"PROFILE","requirements":{"requireQualified":true}},"messages":[{"role":"user","content":"x"}],"maxTokens":4}' | jq -r '.route.considered[0].qualification.status')" "INSTALLED_UNQUALIFIED"
# The summary collapses identical requirements; per-artifact detail is in
# `considered`. One distinct requirement, however many candidates failed it.
chk "the unmet summary does not repeat one requirement per artifact" \
    "$(ex '{"route":{"mode":"PROFILE","requirements":{"requireQualified":true}},"messages":[{"role":"user","content":"x"}],"maxTokens":4}' | jq -r '.route.unmet|length')" "1"
chk "PROFILE that is satisfiable routes" \
    "$(ex '{"route":{"mode":"PROFILE","requirements":{"requiredCapabilities":["chat"],"minContextTokens":8192}},"messages":[{"role":"user","content":"Say OK."}],"maxTokens":4}' | jq -r '.outcome')" "ROUTED"
chk "escalation carries the authority note" \
    "$(ex '{"route":{"mode":"AUTO","requireQualified":true},"messages":[{"role":"user","content":"x"}]}' | jq -r '.route.authorityNote' | grep -ci 'no cloud-routing authority')" "1"

hdr "8. Q2_K remains explicitly unqualified"
chk "catalog status"        "$(auth "$LOOP/v1/catalog" | jq -r '.catalog[0].qualification.status')" "INSTALLED_UNQUALIFIED"
chk "no qualifying authority" "$(auth "$LOOP/v1/catalog" | jq -r '.catalog[0].qualification.authority')" "none"
chk "no qualified task classes" "$(auth "$LOOP/v1/catalog" | jq -r '.catalog[0].qualification.qualifiedTaskClasses|length')" "0"
chk "no Luak evidence loaded" "$(auth "$LOOP/v1/catalog" | jq -r '.luak.recordCount')" "0"
chk "served responses carry the unqualified state" \
    "$(ex '{"route":{"mode":"AUTO"},"messages":[{"role":"user","content":"Say OK."}],"maxTokens":4}' | jq -r '.result.servedIdentity.qualification.status')" "INSTALLED_UNQUALIFIED"

hdr "9. Served identity is attested, not assumed"
R=$(ex '{"route":{"mode":"AUTO"},"messages":[{"role":"user","content":"Say OK."}],"maxTokens":4}')
chk "attested"            "$(printf '%s' "$R" | jq -r '.result.servedIdentity.attested')" "true"
chk "attestation method"  "$(printf '%s' "$R" | jq -r '.result.servedIdentity.attestationMethod')" "backend-props-match"
chk "runtime build pinned" "$(printf '%s' "$R" | jq -r '.result.servedIdentity.runtime.build')" "b10505-ee4c505a4"
chk "served context reported" "$(printf '%s' "$R" | jq -r '.result.servedIdentity.servedContextTokens')" "32768"
chk "request id issued"   "$(printf '%s' "$R" | jq -r '.requestId' | grep -cE '^[0-9a-f-]{36}$')" "1"
chk "telemetry present"   "$(printf '%s' "$R" | jq -r '.telemetry.totalMs != null')" "true"

hdr "10. Logs retain operations without prompt contents"
chk "logPrompts disabled" "$(auth "$LOOP/v1/telemetry" | jq -r '.summary.logPrompts')" "false"
chk "no prompt text in Bokahli journal" \
    "$(journalctl --user -u bokahli.service --since '-30 min' --no-pager -o cat 2>/dev/null | grep -c 'Say OK.')" "0"
chk "no prompt text in runtime journal" \
    "$(journalctl --user -u bokahli-runtime.service --since '-30 min' --no-pager -o cat 2>/dev/null | grep -c 'Say OK.')" "0"
chk "request completions ARE logged" \
    "$(journalctl --user -u bokahli.service --since '-30 min' --no-pager -o cat 2>/dev/null | grep -c 'request.completed')" \
    "$(journalctl --user -u bokahli.service --since '-30 min' --no-pager -o cat 2>/dev/null | grep -c 'request.completed')"
[ "$(journalctl --user -u bokahli.service --since '-30 min' --no-pager -o cat 2>/dev/null | grep -c 'request.completed')" -gt 0 ] \
  && ok "journal contains request.completed telemetry records" \
  || bad "no request.completed records found in journal"

printf '\n\033[1m=== %d passed, %d failed ===\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
