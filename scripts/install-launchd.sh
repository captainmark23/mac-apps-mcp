#!/bin/bash
# Install and start the LaunchAgent that runs the HTTP connector.
# Usage: scripts/install-launchd.sh [path/to/.env]   (default: .env in the repo root)
#
# A LaunchAgent, not a LaunchDaemon: JXA writes need the logged-in GUI session.
# Only MACOS_MCP_* lines from the .env are copied into the plist. The password
# hash stays in ~/.macos-mcp/oauth-password (npm run set-password), never here.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${1:-$REPO/.env}"
LABEL="com.mac-apps-mcp.http"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE="$HOME/.macos-mcp"
DOMAIN="gui/$(id -u)"

[ -f "$ENV_FILE" ] || { echo "No $ENV_FILE. Copy .env.example to .env and fill it in." >&2; exit 1; }
[ -f "$REPO/build/index.js" ] || { echo "Build first: npm run build" >&2; exit 1; }
[ -f "$STATE/oauth-password" ] || { echo "Set the connector password first: npm run set-password" >&2; exit 1; }
[ -f "$STATE/oauth-client" ] || { echo "Create the OAuth client first: npm run new-client" >&2; exit 1; }
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[ -x "$NODE_BIN" ] || { echo "node not found; set NODE_BIN to the node binary that has Full Disk Access." >&2; exit 1; }

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

env_xml=""
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|\#*) continue ;; esac
  key="${line%%=*}"
  value="${line#*=}"
  value="${value%\"}"; value="${value#\"}"
  case "$key" in
    MACOS_MCP_OAUTH_PASSWORD_HASH) echo "Remove MACOS_MCP_OAUTH_PASSWORD_HASH from $ENV_FILE; use npm run set-password." >&2; exit 1 ;;
    MACOS_MCP_TRANSPORT) continue ;;
    MACOS_MCP_*) env_xml+="    <key>$key</key><string>$(printf '%s' "$value" | xml)</string>"$'\n' ;;
  esac
done < "$ENV_FILE"

mkdir -p "$STATE" "$(dirname "$PLIST")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(printf '%s' "$NODE_BIN" | xml)</string>
    <string>$(printf '%s' "$REPO/build/index.js" | xml)</string>
  </array>
  <key>WorkingDirectory</key><string>$(printf '%s' "$REPO" | xml)</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MACOS_MCP_TRANSPORT</key><string>http</string>
$env_xml  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(printf '%s' "$STATE/launchd.log" | xml)</string>
  <key>StandardErrorPath</key><string>$(printf '%s' "$STATE/launchd.log" | xml)</string>
</dict>
</plist>
EOF
plutil -lint "$PLIST" >/dev/null

# bootout + bootstrap (not kickstart) so a changed environment is picked up.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Started $LABEL with $NODE_BIN."
echo "Check it: curl -s http://127.0.0.1:\${MACOS_MCP_HTTP_PORT:-8443}/healthz"
