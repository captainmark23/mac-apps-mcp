# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
