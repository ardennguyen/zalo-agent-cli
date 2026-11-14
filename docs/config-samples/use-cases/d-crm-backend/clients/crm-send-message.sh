#!/usr/bin/env bash
# A backend (CRM) calls the MCP endpoint directly: a JSON-RPC `tools/call` over HTTP.
# The `Accept` header MUST list both types or the server answers 406; the reply is one
# Server-Sent Event whose `data:` line carries the JSON-RPC response.
#
#   ZALO_MCP_URL=https://zalo.example.com/mcp ZALO_MCP_TOKEN=... ./crm-send-message.sh <threadId> "text"
set -euo pipefail
: "${ZALO_MCP_URL:?set ZALO_MCP_URL}" "${ZALO_MCP_TOKEN:?set ZALO_MCP_TOKEN}"
thread_id="${1:?threadId}"
text="${2:?text}"

# jq builds the JSON so quotes and newlines in the text cannot break it.
body="$(jq -n --arg t "$thread_id" --arg m "$text" \
  '{jsonrpc:"2.0", id:1, method:"tools/call",
    params:{name:"zalo_send_message", arguments:{threadId:$t, text:$m}}}')"

curl -sS --max-time 30 "$ZALO_MCP_URL" \
  -H "Authorization: Bearer ${ZALO_MCP_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "$body" \
  | sed -n 's/^data: //p' \
  | jq -r '.result.content[0].text'
# On success the text is JSON with the new message's ids; on failure `.result.isError`
# is true and the text starts with "Error:".
