#!/bin/bash
# Stop the HTTP connector LaunchAgent and remove its plist. Auth state and logs
# in ~/.macos-mcp are left in place.
set -euo pipefail

LABEL="com.mac-apps-mcp.http"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "Stopped $LABEL and removed $PLIST."
