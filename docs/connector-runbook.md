# Remote connector runbook

Run mac-apps-mcp as a remote MCP connector so Claude on the web, phone, Desktop and Claude Code can reach your Mac's Mail, Calendar, Reminders, Contacts, Notes and Messages without the desktop app. The server listens on `127.0.0.1` only; Tailscale Funnel is the public path.

Three things guard it:

1. **A client ID and secret** that only you and Claude hold. There is no public registration endpoint, and a sign-in code is useless without the secret.
2. **Your password**, checked on the sign-in page.
3. **Your Tailscale login.** The sign-in page answers only your own devices on your tailnet, so nobody reaching the server through Funnel can try a password.

Using another tunnel (Cloudflare Tunnel, ngrok)? Skip `MACOS_MCP_TAILSCALE_LOGIN`. The secret and password still protect the server, but anyone with the URL and the client ID can reach the sign-in page. Use a long password, and know that such a person could keep sign-in locked by entering wrong passwords; existing connections keep working.

Replace `your-mac.your-tailnet.ts.net` with your Mac's Tailscale name (`tailscale status --self`).

## 1. Prerequisites

1. A Mac that stays logged in and awake. Check `pmset -g`; for an always-on machine run `sudo pmset -a sleep 0 disksleep 0`.
2. Node.js 20 or later, and Full Disk Access for the node binary the LaunchAgent will run (System Settings > Privacy & Security > Full Disk Access). Prefer a node that Homebrew upgrades will not replace; set `NODE_BIN` to it when installing.
3. Tailscale on the Mac, with HTTPS certificates enabled for the tailnet, and on each device you sign in from.

## 2. Install and set the password

1. `npm ci && npm run build`
2. `npm run set-password`. This stores a scrypt hash in `~/.macos-mcp/oauth-password` (mode 0600). The password itself is never stored.
3. `npm run new-client`. This prints a client ID and secret and stores only a hash of the secret in `~/.macos-mcp/oauth-client` (mode 0600). The secret is shown once: keep it in your password manager for section 5.
4. `cp .env.example .env` and set:
   - `MACOS_MCP_PUBLIC_URL=https://your-mac.your-tailnet.ts.net:8443`
   - `MACOS_MCP_TAILSCALE_LOGIN` to your Tailscale login, which `tailscale whois --json $(tailscale ip -4)` shows as `UserProfile.LoginName`.

   Leave the read-only toolsets for the first week.

## 3. Start it

1. `NODE_BIN=/path/to/node scripts/install-launchd.sh`
2. `curl -s http://127.0.0.1:8443/healthz` should show `"status":"ok"` and both `readable` values `true`. If `readable` is `false`, the node binary lacks Full Disk Access (see section 8).
3. Logs: `~/.macos-mcp/launchd.log` (process output), `~/.macos-mcp/macos-mcp.log` (server log), `~/.macos-mcp/audit.log` (one line per tool call: time, client, tool, hash of arguments).

## 4. Enable Funnel

1. Funnel needs the `funnel` node attribute. In the Tailscale admin console, Access controls, add to the policy file (or extend an existing `nodeAttrs` entry):

   ```json
   "nodeAttrs": [
     { "target": ["autogroup:member"], "attr": ["funnel"] }
   ]
   ```

   Narrow `target` to your Mac if you prefer.
2. `tailscale funnel --bg --https=8443 http://127.0.0.1:8443`
3. `tailscale funnel status` should list `https://your-mac.your-tailnet.ts.net:8443` as Funnel on.
4. From a device off the tailnet (a phone on mobile data with Tailscale off): `https://your-mac.your-tailnet.ts.net:8443/healthz` returns `{"status":"ok"}`, and `/authorize` answers "Sign in from one of your own devices, connected to Tailscale."

## 5. Add the connector

Sign in from a device with Tailscale on. Sign-in lasts 30 days and renews itself while the connector is in use.

1. claude.ai: Customize > Connectors > Add custom connector. URL `https://your-mac.your-tailnet.ts.net:8443/mcp`. Under Advanced settings (or "Use your own OAuth client"), enter the client ID and secret from `npm run new-client`. Connect, enter the password on the page that opens, choose Allow. The connector then appears in Claude Desktop and the phone app on the same account.
2. Claude Code: `claude mcp add --transport http --client-id <client ID> --client-secret mac-apps https://your-mac.your-tailnet.ts.net:8443/mcp`. It asks for the secret and keeps it in your keychain. Then run `/mcp` in Claude Code and sign in.
3. Test from the phone with no desktop app involved: ask for today's calendar, a mail body search, and unread texts. Each call appears in `audit.log`.

## 6. Widen access

1. Edit `MACOS_MCP_HTTP_TOOLSETS` in `.env`. Modules are `mail`, `calendar`, `reminders`, `contacts`, `notes`, `messages` and `briefing`; a `:read` suffix keeps only that module's read-only tools. Remove the line to expose everything.
2. Keep `MACOS_MCP_CONFIRM_DESTRUCTIVE=true` so sends and deletes need `confirm: true` from the model.
3. Re-run `scripts/install-launchd.sh` to apply.

## 7. Rotate the password or client secret

1. New password: `npm run set-password`, then re-run `scripts/install-launchd.sh`. Existing tokens keep working until they expire (access 1 hour, refresh 30 days).
2. New client secret, which also signs every connection out: `npm run new-client`, then `scripts/install-launchd.sh`. Remove the connector in claude.ai and add it again with the new ID and secret (claude.ai cannot edit them in place), and in Claude Code run `claude mcp remove mac-apps` and add it again.
3. Five wrong passwords lock sign-in for 15 minutes. Restarting the server clears the lock.

## 8. Full Disk Access broke after a node upgrade

1. Symptom: `/healthz` shows `"readable": {"messages": false, "mail": false}` and tools report database errors.
2. Find the binary: `plutil -p ~/Library/LaunchAgents/com.mac-apps-mcp.http.plist` (first `ProgramArguments` entry), then `realpath` it.
3. Add that file under Full Disk Access (Cmd+Shift+G to type the path), then `scripts/install-launchd.sh` to restart.

## 9. Remove it

1. `tailscale funnel --https=8443 off`
2. `scripts/uninstall-launchd.sh`
3. Optionally delete `~/.macos-mcp/auth.json`, `audit.log`, `oauth-password` and `oauth-client`.
