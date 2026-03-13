# macos-mcp

MCP server for macOS that gives Claude access to Apple Mail, Calendar, and Reminders. All reads hit SQLite databases directly for instant results — no slow AppleScript round-trips.

## Features

- **Apple Mail** — list, read, search, send, draft, reply, forward, move, flag emails
- **Full-text email search** — FTS5 index of email body content with snippets
- **Apple Calendar** — list, query, create, modify, delete events
- **Apple Reminders** — list, query, create, complete, delete reminders
- **Daily briefing** — one-call summary of today's events, due reminders, and unread mail
- **Zero native dependencies** — uses macOS system `sqlite3` binary and JXA

## Requirements

- macOS 14+ (Sonoma or later)
- Node.js 20+
- **Full Disk Access** for your Claude client (Claude Desktop, terminal, etc.) — needed to read macOS databases

### Granting Full Disk Access

System Settings → Privacy & Security → Full Disk Access → add your terminal app and/or Claude Desktop.

## Installation

```bash
git clone https://github.com/captainmark23/macos-mcp.git
cd macos-mcp
npm install
npm run build
```

## Configuration

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "macos-mcp": {
      "command": "node",
      "args": ["/path/to/macos-mcp/build/index.js"],
      "env": {
        "MACOS_MCP_CALENDARS": "Work,Personal",
        "MACOS_MCP_MAIL_ACCOUNT": "iCloud"
      }
    }
  }
}
```

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `MACOS_MCP_CALENDARS` | Comma-separated calendar names to include | All calendars |
| `MACOS_MCP_MAIL_ACCOUNT` | Default mail account name | First account |
| `MACOS_MCP_REMINDER_LISTS` | Comma-separated reminder list names to include | All lists |

## Tools (30)

### Mail (12)

| Tool | Description |
|---|---|
| `mail_list_accounts` | List configured email accounts |
| `mail_list_mailboxes` | List mailboxes for an account |
| `mail_get_emails` | Get emails with filtering (all, unread, flagged, today, this_week) |
| `mail_get_email` | Get full email content including body |
| `mail_search` | Search by subject and/or sender |
| `mail_send` | Send an email |
| `mail_create_draft` | Create a draft for review |
| `mail_reply` | Reply to an email |
| `mail_forward` | Forward an email |
| `mail_move` | Move to another mailbox |
| `mail_set_flags` | Set flagged/read status |
| `mail_search_body` | Full-text search of email body content (FTS5) |

### Mail FTS Index (2)

| Tool | Description |
|---|---|
| `mail_fts_index` | Build or update the full-text search index |
| `mail_fts_stats` | Get index statistics |

### Calendar (8)

| Tool | Description |
|---|---|
| `calendar_list` | List all calendars |
| `calendar_today` | Get today's events |
| `calendar_this_week` | Get events for the next 7 days |
| `calendar_get_events` | Get events in a date range |
| `calendar_get_event` | Get full event details with attendees |
| `calendar_create_event` | Create an event |
| `calendar_modify_event` | Modify an event |
| `calendar_delete_event` | Delete an event |

### Reminders (6)

| Tool | Description |
|---|---|
| `reminders_list_lists` | List all reminder lists |
| `reminders_get` | Get reminders with filtering (incomplete, due_today, overdue, flagged, completed, all) |
| `reminders_get_detail` | Get full reminder details |
| `reminders_create` | Create a reminder |
| `reminders_complete` | Mark a reminder as completed |
| `reminders_delete` | Delete a reminder |

### Briefing (1)

| Tool | Description |
|---|---|
| `daily_briefing` | Today's events, due/overdue reminders, flagged and unread emails |

## Full-Text Email Search

The FTS5 index enables searching inside email body content — not just subjects and senders. Build it once, then incremental updates are fast.

```
# Build the full index (first time — takes a while for large mailboxes)
Use mail_fts_index with rebuild=true

# Incremental update (fast — only indexes new messages)
Use mail_fts_index

# Search
Use mail_search_body with query="invoice payment"
```

The index is stored at `~/.macos-mcp/mail-fts.db`.

## Architecture

```
src/
  index.ts              # MCP server — tool registration and routing
  mail/
    tools.ts            # Mail reads (SQLite) and writes (JXA)
    fts.ts              # FTS5 full-text body search index
  calendar/
    tools.ts            # Calendar reads (SQLite) and writes (JXA)
  reminders/
    tools.ts            # Reminders reads (SQLite) and writes (JXA)
  shared/
    sqlite.ts           # Zero-dep SQLite query helper (/usr/bin/sqlite3)
    applescript.ts       # JXA execution helper (osascript)
    config.ts           # Environment variable configuration
```

**Read operations** query macOS SQLite databases directly via the system `sqlite3` binary with `-json -readonly` flags. This is orders of magnitude faster than AppleScript/JXA — calendar queries that took 1:46 via JXA complete in 14ms via SQLite.

**Write operations** use JXA (JavaScript for Automation) via `osascript`, which properly interfaces with the app APIs and respects macOS sandboxing.

## Troubleshooting

### Full Disk Access errors

If you see `SQLite error: unable to open database file` or similar permission errors, your terminal (or Claude Desktop) needs Full Disk Access:

**System Settings → Privacy & Security → Full Disk Access** → toggle on your terminal app and/or Claude Desktop. Restart the app after granting access.

### Automation / privacy permissions

Write operations (sending mail, creating events/reminders) use JXA which requires Automation access. If you see `-1743` errors or "not allowed assistive access":

**System Settings → Privacy & Security → Automation** → ensure your terminal/Claude Desktop has permission for Mail, Calendar, and Reminders.

### Reminders database not found

If `reminders_*` tools return "database directory not found", the Reminders container may not exist yet. Open Reminders.app once and create at least one reminder to initialize the database.

### SQLite query timed out

Queries have a 10-second timeout by default. If you hit this on large mailboxes, try narrowing your search with filters (e.g., `filter: "today"`) or reducing the `limit` parameter.

### Node.js version

Requires Node.js 20+. Check with `node --version`. If you're on an older version, install a current LTS release via [nvm](https://github.com/nvm-sh/nvm) or [Homebrew](https://brew.sh).

### FTS index issues

If `mail_search_body` returns no results, you need to build the FTS index first:

1. Run `mail_fts_index` (incremental — only indexes new messages)
2. Or run `mail_fts_index` with `rebuild=true` for a full re-index

The index is stored at `~/.macos-mcp/mail-fts.db` and can be safely deleted to start fresh.

## License

MIT
