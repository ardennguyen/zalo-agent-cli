#!/usr/bin/env bash
# The CRM's admin console reads and changes one account's runtime policy, and reads usage,
# through the admin API (/zalo/admin/*) with its OWN token: never the agent's
# ZALO_MCP_AUTH_TOKEN, which is refused there. The proxy never lets /zalo/admin/* in from
# the internet: call it on loopback, over an SSH tunnel or a VPN, or through the admin
# host that only the console's address reaches (see the d-crm-backend Caddyfile).
#
#   ZALO_ADMIN_URL=https://admin.zalo.example.com/a/1000000000000000001 \
#   ZALO_ADMIN_TOKEN_FILE=/run/secrets/zalo-admin-token \
#     ./admin-policy.sh get
#     ./admin-policy.sh patch '{"confirmMode":"human"}'
#     ./admin-policy.sh usage
#
# A PATCH sends If-Match with the revision it read, so a concurrent change is refused with
# 412 instead of being overwritten: read again and retry.
set -euo pipefail
: "${ZALO_ADMIN_URL:?set ZALO_ADMIN_URL}" "${ZALO_ADMIN_TOKEN_FILE:?set ZALO_ADMIN_TOKEN_FILE}"
auth="Authorization: Bearer $(cat "$ZALO_ADMIN_TOKEN_FILE")"

case "${1:?get, patch <json> or usage}" in
get)
  curl -sS --max-time 30 -H "$auth" "$ZALO_ADMIN_URL/zalo/admin/policy" | jq .
  ;;
patch)
  patch="${2:?the JSON to merge, e.g. {\"confirmMode\":\"human\"}}"
  etag="$(curl -sS --max-time 30 -o /dev/null -D - -H "$auth" "$ZALO_ADMIN_URL/zalo/admin/policy" \
    | tr -d '\r' | sed -n 's/^[Ee][Tt][Aa][Gg]: //p')"
  curl -sS --max-time 30 -X PATCH -H "$auth" -H "Content-Type: application/json" \
    -H "If-Match: ${etag}" -d "$patch" "$ZALO_ADMIN_URL/zalo/admin/policy" | jq .
  ;;
usage)
  curl -sS --max-time 30 -H "$auth" "$ZALO_ADMIN_URL/zalo/admin/usage" | jq .
  ;;
*)
  echo "usage: $0 get | patch '<json>' | usage" >&2
  exit 2
  ;;
esac
