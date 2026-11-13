# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Messages module: `messages_list_chats`, `messages_get_chat`, `messages_unread`, `messages_search` and `messages_send` (iMessage, SMS and RCS chats from `chat.db`, sending through Messages.app)
- WhatsApp module, read-only: `whatsapp_list_chats`, `whatsapp_get_chat`, `whatsapp_search` and `whatsapp_unread`, reading the WhatsApp desktop app's `ChatStorage.sqlite`. Senders are named from WhatsApp's copy of the address book, then their profile name (`~Name`), then their phone number
- `MACOS_MCP_WHATSAPP` switch, and a `whatsapp` module name for `MACOS_MCP_HTTP_TOOLSETS`
- Text extraction from `attributedBody` blobs, so messages with a NULL `text` column read and search correctly
- Tapbacks folded into the message they react to, including emoji tapbacks
- `macos://messages/chats` resource and a texts section in `daily_briefing`
- `MACOS_MCP_MESSAGES` switch and `MACOS_MCP_MESSAGES_HANDLES_ALLOWLIST` for `messages_send`
- Contact name lookup across every address book source, matching phone numbers in E.164
- Remote connector: Streamable HTTP transport (`MACOS_MCP_TRANSPORT=http`) bound to loopback, with a single-user OAuth 2.1 server (one pre-created client whose secret is required at the token endpoint, no registration endpoint, PKCE, rotating refresh tokens, login lockout), a check that requests name the public host, `/healthz`, per-module toolsets and an audit log of tool calls
- `MACOS_MCP_TAILSCALE_LOGIN`: the sign-in page answers only the owner's Tailscale login, so it cannot be reached through Funnel
- `MACOS_MCP_ALERT_TO`: the HTTP connector texts the owner by iMessage on each sign-in, wrong password, lockout and first call from a new network, and sends a daily digest of audited calls. The audit log now records the caller address
- `npm run set-password`, `npm run new-client`, `scripts/install-launchd.sh`, `scripts/uninstall-launchd.sh` and `docs/connector-runbook.md`

### Changed
- Connector runbook and `.env.example` use the standard HTTPS port for the public URL (claude.ai did not connect to `:8443`), with notes on adding the connector in claude.ai
- `scripts/install-launchd.sh` retries `launchctl bootstrap`, which failed with an I/O error when re-run over a running service
- README tool count corrected to 46, including the Notes tools
- Server construction moved to `src/server.ts` so both transports build the same server

### Fixed
- With `MACOS_MCP_CONFIRM_DESTRUCTIVE` on, the confirmation warning is returned as a tool error; before, it failed output-schema validation and the client saw a validation error instead

## [0.2.0] - 2026-03-18

### Fixed
- Recipients query using nonexistent `rc.message_id` column — corrected to `rc.message`
- Reminder complete/delete failing due to `x-apple-reminder://` prefix not being stripped before JXA lookup
- `decodeURIComponent` crash in `parseMailboxUrl` on malformed mailbox URLs
- Write operations (reply, forward, move, flag) could target deleted messages
- FTS body search silently dropping messages with NULL subject or sender (inner JOIN → LEFT JOIN)
- Same LEFT JOIN fix applied to `getEmails` and `searchMail` queries and their count queries
- FTS over-fetch formula growing too large at high offsets
- Race condition in `resolveMailAccountUuid` allowing concurrent JXA calls during cache refresh
- Attachment query errors silently swallowed — now logged before MIME fallback

### Added
- Auto-resolve for mail write operations (account/mailbox inferred from message ID)
- Attachment metadata from Envelope Index with MIME fallback
- Multi-account support in daily briefing
- Persistent file logging to `~/.macos-mcp/macos-mcp.log`
- Body previews in email listings
- Full-text search (FTS5) index for email bodies with incremental updates
- Contacts module with search and detail views
- Pagination across all list endpoints
- Output schemas (Zod) on all tools
- Unit tests for shared utilities
- `prepublishOnly` script to ensure build before publish

### Changed
- Email body reading now uses direct `.emlx` file parsing (no JXA needed)
- FTS index auto-builds on server startup

## [0.1.0] - 2026-03-10

### Added
- Initial release
- Apple Mail: list accounts, mailboxes, read/search/send/reply/forward/move/flag emails
- Apple Calendar: list calendars, view/create/modify/delete events
- Apple Reminders: list/create/complete/delete reminders
- JXA-based write operations with serialized queue
- SQLite-based read operations for instant responses
