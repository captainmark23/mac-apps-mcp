# mac-apps-mcp

MCP server for macOS that gives Claude access to Apple Mail, Calendar, Reminders, and Contacts. All reads hit SQLite databases directly for instant results — no slow AppleScript round-trips.

## Features

- **Apple Mail** — list, read, search, send, draft, reply, forward, move, flag emails
- **Full-text email search** — FTS5 index of email body content with snippets
- **Apple Calendar** — list, query, create, modify, delete events
- **Apple Reminders** — list, query, create, complete, delete reminders
- **Apple Contacts** — list, search, and get full contact details from the Address Book
- **Daily briefing** — one-call summary of today's events, due reminders, and unread mail
- **MCP resources** — browsable resources for accounts, calendars, lists, and contacts
- **Zero native dependencies** — uses macOS system `sqlite3` binary and JXA

## Requirements

- macOS 14+ (Sonoma or later)
- Node.js 20+
- **Full Disk Access** for your Claude client (Claude Desktop, terminal, etc.) — needed to read macOS databases

### Granting Full Disk Access

System Settings → Privacy & Security → Full Disk Access:

1. Add **Claude Desktop** (for Claude Desktop usage)
2. Add **Terminal** or your terminal app (for Claude Code usage)
3. **Important:** Also add the **Node.js binary** itself — Claude Desktop spawns `node` as a child process, and it's the `node` process that reads the macOS databases. To add it:
   - Click **+** in Full Disk Access
   - Press **Cmd+Shift+G** and go to the output of `which node` (e.g., `/opt/homebrew/Cellar/node/25.3.0/bin/`)
   - Select **node** and toggle it on

> **Note:** If you update Node.js (e.g., via Homebrew), the binary path changes and you'll need to re-add it to Full Disk Access.

## Installation

```bash
git clone https://github.com/captainmark23/mac-apps-mcp.git
cd mac-apps-mcp
npm install
npm run build
```

## Configuration

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mac-apps-mcp": {
      "command": "node",
      "args": ["/path/to/mac-apps-mcp/build/index.js"],
      "env": {
        "MACOS_MCP_CALENDARS": "My Calendar,Shared Calendar",
        "MACOS_MCP_MAIL_ACCOUNT": "MyAccount"
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
| `MACOS_MCP_WRITE_RATE_LIMIT` | Max write operations per minute | 10 |
| `MACOS_MCP_READONLY` | Disable all write tools (`true` or `1`) | Not set (all tools) |
| `MACOS_MCP_CONFIRM_DESTRUCTIVE` | Require `confirm: true` on destructive tools (`true` or `1`) | Not set |

### Read-Only Mode

To disable all write operations (send, reply, forward, create, delete, etc.):

```json
{
  "mcpServers": {
    "macos": {
      "command": "npx",
      "args": ["mac-apps-mcp-server"],
      "env": {
        "MACOS_MCP_READONLY": "true"
      }
    }
  }
}
```

When enabled, write tools are not registered and won't appear in the tool list, except `mail_move` and `mail_set_flags` (kept available for inbox triage workflows).
Read operations (listing, searching, viewing) and FTS indexing remain available.

### Confirm Destructive Mode

To require explicit confirmation before destructive actions (sending email, deleting events/reminders):

```json
{
  "mcpServers": {
    "macos": {
      "command": "npx",
      "args": ["mac-apps-mcp-server"],
      "env": {
        "MACOS_MCP_CONFIRM_DESTRUCTIVE": "true"
      }
    }
  }
}
```

When enabled, destructive tools (`mail_send`, `mail_reply`, `mail_forward`, `calendar_delete_event`, `reminders_delete`) require a `confirm: true` parameter. If omitted, the tool returns a warning asking the LLM to check with the user first. For `mail_reply` and `mail_forward`, confirmation is only required when `send: true` (the default) — saving as draft does not require confirmation.

## Tools (33)

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
| `mail_fts_index` | Build or update the full-text search index (supports progress notifications) |
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

### Contacts (3)

| Tool | Description |
|---|---|
| `contacts_list` | List or search contacts by name/organization |
| `contacts_get` | Get full contact details (emails, phones, addresses, notes) |
| `contacts_search` | Search contacts by name, email, phone, or organization |

### Briefing (1)

| Tool | Description |
|---|---|
| `daily_briefing` | Today's events, due/overdue reminders, flagged and unread emails |

## Resources

The server exposes browsable MCP resources:

| URI | Description |
|---|---|
| `macos://mail/accounts` | Email accounts |
| `macos://mail/{account}/mailboxes` | Mailboxes for an account |
| `macos://calendars` | All calendars |
| `macos://reminders/lists` | Reminder lists |
| `macos://contacts` | Contacts |

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

The index is stored at `~/.macos-mcp/mail-fts.db`. Clients that support progress notifications will receive real-time updates during indexing.

## Architecture

```
src/
  index.ts              # MCP server — tool/resource registration and routing
  mail/
    tools.ts            # Mail reads (SQLite) and writes (JXA)
    fts.ts              # FTS5 full-text body search index
  calendar/
    tools.ts            # Calendar reads (SQLite) and writes (JXA)
  reminders/
    tools.ts            # Reminders reads (SQLite) and writes (JXA)
  contacts/
    tools.ts            # Contacts reads (SQLite)
  shared/
    sqlite.ts           # Zero-dep SQLite query helper (/usr/bin/sqlite3)
    applescript.ts       # JXA execution helper with rate-limited write queue
    config.ts           # Environment variable configuration
    types.ts            # Shared types and pagination helpers
  __tests__/
    shared.test.ts      # Unit tests for shared utilities
```

**Read operations** query macOS SQLite databases directly via the system `sqlite3` binary with `-json -readonly` flags. This is orders of magnitude faster than AppleScript/JXA — calendar queries that took 1:46 via JXA complete in 14ms via SQLite.

**Write operations** use JXA (JavaScript for Automation) via `osascript`, which properly interfaces with the app APIs and respects macOS sandboxing. Writes are serialized via a queue and rate-limited (default: 10/minute).

## Logs

The server writes a persistent log to `~/.macos-mcp/macos-mcp.log` (5MB max, 3 rotated backups). Check it if the server crashes or disconnects:

```bash
tail -50 ~/.macos-mcp/macos-mcp.log
```

## Troubleshooting

### Server disconnected in Claude Desktop

Check the log first:

```bash
cat ~/.macos-mcp/macos-mcp.log
```

### Full Disk Access errors

If you see `SQLite error: unable to open database file` or similar permission errors, your terminal (or Claude Desktop) needs Full Disk Access:

**System Settings → Privacy & Security → Full Disk Access** → toggle on your terminal app and/or Claude Desktop. Restart the app after granting access.

### Automation / privacy permissions

Write operations (sending mail, creating events/reminders) use JXA which requires Automation access. If you see `-1743` errors or "not allowed assistive access":

**System Settings → Privacy & Security → Automation** → ensure your terminal/Claude Desktop has permission for Mail, Calendar, and Reminders.

### Reminders database not found

If `reminders_*` tools return "database directory not found", the Reminders container may not exist yet. Open Reminders.app once and create at least one reminder to initialize the database.

### Contacts database not found

If `contacts_*` tools return "Contacts database not found", open Contacts.app once to initialize the database. The server reads from `~/Library/Application Support/AddressBook/Sources/`.

### SQLite query timed out

Queries have a 10-second timeout by default. If you hit this on large mailboxes, try narrowing your search with filters (e.g., `filter: "today"`) or reducing the `limit` parameter.

### Write rate limit exceeded

Write operations are rate-limited to 10 per minute by default to prevent runaway agents. Adjust with the `MACOS_MCP_WRITE_RATE_LIMIT` environment variable.

### Node.js version

Requires Node.js 20+. Check with `node --version`. If you're on an older version, install a current LTS release via [nvm](https://github.com/nvm-sh/nvm) or [Homebrew](https://brew.sh).

### FTS index issues

If `mail_search_body` returns no results, you need to build the FTS index first:

1. Run `mail_fts_index` (incremental — only indexes new messages)
2. Or run `mail_fts_index` with `rebuild=true` for a full re-index

The index is stored at `~/.macos-mcp/mail-fts.db` and can be safely deleted to start fresh.

## License

MIT
