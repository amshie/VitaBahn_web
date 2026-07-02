#!/usr/bin/env bash
#
# verify-live.sh — post-deploy verification for the VitaBahn site.
#
# Run this AFTER deploying, against the real base URL, to confirm the things that
# cannot be checked from the repo: that the deploying host actually serves the
# security headers, that rate limiting is backed by the live durable store, and
# that the end-to-end lead+mail path works.
#
#   Usage:  ./verify-live.sh https://vitabahn.com
#           BURST=12 ./verify-live.sh https://vita-bahn-web.vercel.app
#
# Exits non-zero if any assertion fails. Prints one clear PASS/FAIL line per check.
#
# Notes:
#  - Checks share your machine's single client IP, so they run in an order that
#    keeps the mail path on a fresh rate-limit window: headers -> mail -> burst.
#    Re-run no more than once per RATE_WINDOW (default 60s) or the mail check may
#    hit the limiter left over from the previous run's burst.
#  - Needs: curl, and one of python3 / sha256sum / shasum / openssl (for the PoW).

set -u

BASE="${1:-}"
BURST="${BURST:-12}"   # number of POSTs in the rate-limit burst; must exceed the server's RATE_MAX
if [ -z "$BASE" ]; then
  echo "usage: $0 <base-url>   e.g. $0 https://vitabahn.com" >&2
  exit 2
fi
BASE="${BASE%/}"          # strip trailing slash
API="$BASE/api/lead"
FAILS=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILS=$((FAILS + 1)); }

echo "== VitaBahn post-deploy verification =="
echo "base: $BASE"
echo

# ---------------------------------------------------------------------------
# CHECK 1 — security headers are actually served by the host.
# This is the real test of whether Vercel (which honours vercel.json) serves the
# page, vs. a static host (e.g. Porkbun) that cannot set these headers.
# ---------------------------------------------------------------------------
echo "--- CHECK 1: security headers (curl -I the page) ---"
HDRS="$(curl -sS -I "$BASE/" 2>/dev/null)"
# Some hosts answer HEAD sparsely; fall back to a GET with headers dumped.
if [ -z "$(printf '%s' "$HDRS" | grep -i 'content-security-policy')" ]; then
  HDRS="$(curl -sS -D - -o /dev/null "$BASE/" 2>/dev/null)"
fi

has_header() { printf '%s' "$HDRS" | grep -iq "^$1:"; }
csp_line="$(printf '%s' "$HDRS" | grep -i '^content-security-policy:' | tr -d '\r')"

if has_header 'content-security-policy'; then
  pass 'Content-Security-Policy present'
  # Assert the specific (non-default-src-inheriting) directives are in the policy.
  for d in "base-uri 'none'" "object-src 'none'" "form-action 'self'" "frame-ancestors 'none'" "default-src 'self'"; do
    if printf '%s' "$csp_line" | grep -qF "$d"; then pass "CSP contains: $d"; else fail "CSP missing directive: $d"; fi
  done
else
  fail 'Content-Security-Policy MISSING — the host is not serving vercel.json headers (is Vercel serving the page, not a static host?)'
fi

for h in Strict-Transport-Security X-Frame-Options X-Content-Type-Options Referrer-Policy Permissions-Policy; do
  if has_header "$h"; then pass "$h present"; else fail "$h MISSING"; fi
done
echo

# ---------------------------------------------------------------------------
# CHECK 2 — end-to-end lead + mail path (run before the burst so the rate-limit
# window is fresh).
# ---------------------------------------------------------------------------
echo "--- CHECK 2: end-to-end proof-of-work + lead submission ---"

# Solve a PoW challenge: find i such that SHA-256("<nonce>.<i>") has >= <bits>
# leading zero bits. Prefer python3 (fast, in-process); fall back to a hashing CLI.
solve_pow() {
  local nonce="$1" bits="$2"
  # Prefer python3/python, but only if it actually runs (guards against the
  # Windows Store "python" alias stub that exists on PATH but errors).
  local py=""
  for cand in python3 python; do
    # Require real stdout output — the Windows Store alias stub exits 0 but prints nothing.
    if command -v "$cand" >/dev/null 2>&1 && [ "$("$cand" -c 'print(7*3)' 2>/dev/null)" = "21" ]; then py="$cand"; break; fi
  done
  if [ -n "$py" ]; then
    "$py" - "$nonce" "$bits" <<'PY'
import sys, hashlib
nonce, bits = sys.argv[1], int(sys.argv[2])
i = 0
while True:
    d = hashlib.sha256(f"{nonce}.{i}".encode()).digest()
    n = 0
    for by in d:
        if by == 0: n += 8; continue
        m = 7
        while m >= 0 and not ((by >> m) & 1): n += 1; m -= 1
        break
    if n >= bits: print(i); break
    i += 1
PY
    return
  fi
  # POSIX fallback: pick an available SHA-256 CLI.
  local hasher=""
  if command -v sha256sum >/dev/null 2>&1; then hasher="sha256sum";
  elif command -v shasum >/dev/null 2>&1; then hasher="shasum -a 256";
  elif command -v openssl >/dev/null 2>&1; then hasher="openssl dgst -sha256 -r";
  else echo "" ; return; fi
  local i=0 hex lz c
  while :; do
    hex="$(printf '%s' "$nonce.$i" | $hasher | cut -c1-8)"
    lz=0
    for (( k=0; k<${#hex}; k++ )); do
      c="${hex:$k:1}"
      case "$c" in
        0) lz=$((lz+4));;
        1) lz=$((lz+3)); break;;
        2|3) lz=$((lz+2)); break;;
        4|5|6|7) lz=$((lz+1)); break;;
        *) break;;
      esac
    done
    if [ "$lz" -ge "$bits" ]; then echo "$i"; return; fi
    i=$((i+1))
  done
}

CH_JSON="$(curl -sS "$API" 2>/dev/null)"
CHALLENGE="$(printf '%s' "$CH_JSON" | sed -n 's/.*"challenge":"\([^"]*\)".*/\1/p')"
BITS="$(printf '%s' "$CH_JSON" | sed -n 's/.*"difficulty":\([0-9][0-9]*\).*/\1/p')"

if printf '%s' "$CH_JSON" | grep -q '429'; then
  fail "mail path: challenge request was rate-limited (429). Wait ${RATE_WINDOW:-60}s and re-run — the checks share your IP's window."
elif [ -z "$CHALLENGE" ] || [ -z "$BITS" ]; then
  fail "mail path: could not obtain a PoW challenge from $API (response: $CH_JSON)"
else
  NONCE="${CHALLENGE%%.*}"
  echo "    got challenge (difficulty=${BITS} bits), solving in-script…"
  SOL="$(solve_pow "$NONCE" "$BITS")"
  if [ -z "$SOL" ]; then
    fail "mail path: no SHA-256 solver available (need python3, sha256sum, shasum, or openssl)"
  else
    echo "    solved: solution=$SOL"
    PAYLOAD="$(printf '{"fn":"Live","ln":"Check","em":"verify@example.com","org":"Post-Deploy Check","cs":"on","msg":"Automated verify-live.sh submission.","pow":"%s","pow_sol":"%s"}' "$CHALLENGE" "$SOL")"
    CODE="$(curl -sS -o /tmp/vb_mail_body.$$ -w '%{http_code}' -H 'Content-Type: application/json' -X POST --data "$PAYLOAD" "$API" 2>/dev/null)"
    BODY="$(cat /tmp/vb_mail_body.$$ 2>/dev/null)"; rm -f /tmp/vb_mail_body.$$
    if [ "$CODE" = "200" ]; then
      pass "lead submission accepted (HTTP 200) — a solved PoW passed and the server accepted the lead"
      echo "    -> Now CHECK THE LEAD INBOX (invest@vitabahn.com). Actual delivery depends on the live SMTP path and cannot be asserted from the 200 alone."
    else
      fail "lead submission returned HTTP $CODE (expected 200). Body: $BODY"
      echo "    (HTTP 500 'Server email not configured' here means SMTP_* env vars are not set on the deployment.)"
    fi
  fi
fi
echo

# ---------------------------------------------------------------------------
# CHECK 3 — rate limiting against the live store (this intentionally trips the
# limiter, so it runs LAST).
# ---------------------------------------------------------------------------
echo "--- CHECK 3: rate limiting (rapid same-IP burst of $BURST POSTs) ---"
echo "    NOTE: a single machine cannot reliably simulate distinct client IPs against"
echo "    Vercel's x-forwarded-for handling, so this confirms SAME-IP throttling backed"
echo "    by the live durable store. The multi-IP bypass is what change #2 fixes"
echo "    structurally (keying on the platform-vouched client IP); it is not exercised here."

# Valid fields but NO proof-of-work: this reaches (and is rejected by) the PoW
# gate with 403, rather than failing field validation with 400. Past the
# threshold the limiter takes over with 429.
NOPOW='{"fn":"Burst","ln":"Test","em":"burst@example.com","org":"Rate Limit Check","cs":"on"}'
codes=""
for i in $(seq 1 "$BURST"); do
  c="$(curl -sS -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST --data "$NOPOW" "$API" 2>/dev/null)"
  codes="$codes $c"
done
echo "    status sequence:$codes"

saw_403=0; saw_429=0
for c in $codes; do
  [ "$c" = "403" ] && saw_403=1
  [ "$c" = "429" ] && saw_429=1
done

if [ "$saw_403" = "1" ]; then pass "requests without proof-of-work are rejected (saw 403)"; else fail "expected 403 for POSTs lacking proof-of-work (none seen)"; fi
if [ "$saw_429" = "1" ]; then pass "limiter engages past the threshold (saw 429)"; else fail "expected 429 past the threshold (none in $BURST requests — is RATE_MAX >= $BURST? raise BURST= and retry)"; fi

# Confirm a 429 carries Retry-After (send one more; the window is still tripped).
RA_HDRS="$(curl -sS -D - -o /dev/null -H 'Content-Type: application/json' -X POST --data "$NOPOW" "$API" 2>/dev/null)"
RA_STATUS="$(printf '%s' "$RA_HDRS" | sed -n '1s/.*\ \([0-9][0-9][0-9]\)\ .*/\1/p' | head -n1)"
if printf '%s' "$RA_HDRS" | grep -iq '^retry-after:'; then
  pass "429 response includes a Retry-After header"
else
  if [ "$RA_STATUS" = "429" ]; then fail "429 response is missing Retry-After"; else
    echo "    (could not re-confirm Retry-After: follow-up request was HTTP ${RA_STATUS:-?}, window may have reset)"; fi
fi
echo

# ---------------------------------------------------------------------------
echo "== summary =="
if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
else
  echo "$FAILS CHECK(S) FAILED"
  exit 1
fi
