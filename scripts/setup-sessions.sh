#!/usr/bin/env bash
# setup-sessions.sh — one-time operator setup to enable cross-channel
# session routing for mega on fabric + Spool.
#
# Idempotent: safe to re-run. Does NOT restart the harness — that's on you.
#
# Reads MEGA_DOMAIN from .env (defaults to india-desert.exe.xyz).
# Hits prod fabric (https://fabric.delivery) and prod Spool
# (https://spool.computer) by default; override via FABRIC_URL / SPOOL_URL.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

MEGA_DOMAIN="${MEGA_DOMAIN:-india-desert.exe.xyz}"
FABRIC_URL="${FABRIC_URL:-https://fabric.delivery}"
SPOOL_URL="${MEGA_SPOOL_URL:-https://spool.computer}"
SESSIONS_PARENT="${SESSIONS_PARENT:-mega/sessions}"
TENANT="mega@${MEGA_DOMAIN}"
FABRIC_CLIENT_ID="${FABRIC_CLIENT_ID:-fabric-prod}"

# Connector types that need a session-routed binding pointing at SESSIONS_PARENT.
CONNECTOR_TYPES=(slack-event slack-action agentmail-event agentmail-action)

echo "tenant:        $TENANT"
echo "fabric:        $FABRIC_URL"
echo "spool:         $SPOOL_URL"
echo "sessions:      $SESSIONS_PARENT"
echo "fabric-client: $FABRIC_CLIENT_ID"
echo

# ── Spool: parent thread + fabric-prod writer member ──────────────────

echo "[spool] creating $SESSIONS_PARENT (idempotent)..."
spool_create_status=$(curl -sS -o /tmp/setup-sessions.out -w '%{http_code}' \
  -X POST "$SPOOL_URL/threads" \
  -H "X-Client-Id: $TENANT" -H "Content-Type: application/json" \
  -d "$(jq -nc --arg n "$SESSIONS_PARENT" '{name:$n}')")
case "$spool_create_status" in
  200|201) echo "  created." ;;
  409)     echo "  already exists." ;;
  *)       echo "  ERROR ($spool_create_status):"; cat /tmp/setup-sessions.out; exit 1 ;;
esac

echo "[spool] inviting $FABRIC_CLIENT_ID as writer on $SESSIONS_PARENT..."
encoded_thread=$(jq -rn --arg s "$SESSIONS_PARENT" '$s|@uri')
member_status=$(curl -sS -o /tmp/setup-sessions.out -w '%{http_code}' \
  -X POST "$SPOOL_URL/threads/$encoded_thread/members" \
  -H "X-Client-Id: $TENANT" -H "Content-Type: application/json" \
  -d "$(jq -nc --arg c "$FABRIC_CLIENT_ID" '{client_id:$c, role:"writer"}')")
case "$member_status" in
  200|201) echo "  added." ;;
  409)     echo "  already a member." ;;
  *)       echo "  ERROR ($member_status):"; cat /tmp/setup-sessions.out; exit 1 ;;
esac

# ── Fabric: locate connectors + ensure session-routed bindings ────────

echo
echo "[fabric] fetching tenant connectors..."
connectors_json=$(curl -sSf "$FABRIC_URL/v1/connectors" -H "X-Client-Id: $TENANT")

for type in "${CONNECTOR_TYPES[@]}"; do
  # Pick the first connector of this type. If a tenant has more than one of
  # the same type (rare today), bind to the one with a slug — operators
  # configure slugs intentionally — otherwise the oldest.
  cid=$(jq -r --arg t "$type" \
    '[.connectors[] | select(.type==$t)] |
       (map(select(.slug!=null)) | first)
       // first
       // empty | .id' <<<"$connectors_json")
  if [ -z "$cid" ]; then
    echo "[fabric] $type: NO CONNECTOR FOUND. Create one before re-running." >&2
    exit 1
  fi
  echo "[fabric] $type → connector $cid"

  bindings_json=$(curl -sSf "$FABRIC_URL/v1/connectors/$cid/bindings" \
    -H "X-Client-Id: $TENANT")
  existing=$(jq -r --arg t "$SESSIONS_PARENT" \
    '[.bindings[] | select(.thread==$t and .fork==true and .use_sessions==true)] | first // empty | .id' \
    <<<"$bindings_json")
  if [ -n "$existing" ]; then
    echo "  binding $existing already targets $SESSIONS_PARENT (use_sessions=true). Skipping."
    continue
  fi

  echo "  creating session-routed binding..."
  create_status=$(curl -sS -o /tmp/setup-sessions.out -w '%{http_code}' \
    -X POST "$FABRIC_URL/v1/connectors/$cid/bindings" \
    -H "X-Client-Id: $TENANT" -H "Content-Type: application/json" \
    -d "$(jq -nc --arg t "$SESSIONS_PARENT" '{thread:$t, fork:true, use_sessions:true}')")
  if [ "$create_status" != "201" ] && [ "$create_status" != "200" ]; then
    echo "  ERROR ($create_status):"; cat /tmp/setup-sessions.out; exit 1
  fi
  new_id=$(jq -r '.binding.id' /tmp/setup-sessions.out)
  echo "  created binding $new_id."
done

# ── .env: add MEGA_SESSIONS_PARENT if absent ──────────────────────────

echo
if grep -q "^MEGA_SESSIONS_PARENT=" .env 2>/dev/null; then
  current=$(grep "^MEGA_SESSIONS_PARENT=" .env | tail -1 | cut -d= -f2-)
  if [ "$current" = "$SESSIONS_PARENT" ]; then
    echo "[.env] MEGA_SESSIONS_PARENT=$SESSIONS_PARENT already set."
  else
    echo "[.env] MEGA_SESSIONS_PARENT=$current (expected $SESSIONS_PARENT). Leaving as-is."
  fi
else
  echo "MEGA_SESSIONS_PARENT=$SESSIONS_PARENT" >> .env
  echo "[.env] appended MEGA_SESSIONS_PARENT=$SESSIONS_PARENT."
fi

rm -f /tmp/setup-sessions.out
echo
echo "Done. Restart the harness with: make stop && make start"
