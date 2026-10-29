# mac-apps-mcp

MCP server for macOS that gives Claude access to Apple Mail, Calendar, Reminders, Contacts, Notes and Messages. All reads hit SQLite databases directly for instant results — no slow AppleScript round-trips.

## Features

- **Apple Mail** — list, read, search, send, draft, reply, forward, move, flag emails
- **Full-text email search** — FTS5 index of email body content with snippets
- **Apple Calendar** — list, query, create, modify, delete events
- **Apple Reminders** — list, query, create, complete, delete reminders
- **Apple Contacts** — list, search, and get full contact details from the Address Book
- **Apple Messages**: list chats, read conversations with tapbacks folded in, see unread texts, search, and send iMessage or SMS
- **Daily briefing** — one-call summary of today's events, due reminders, unread mail and unread texts
- **MCP resources** — browsable resources for accounts, calendars, lists, and contacts
- **Remote connector**: optional Streamable HTTP transport with OAuth, so Claude on the web and phone can reach your Mac (see [docs/connector-runbook.md](docs/connector-runbook.md))
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
| `MACOS_MCP_MESSAGES` | Messages module and the texts section of `daily_briefing` (`off` to disable) | `on` |
| `MACOS_MCP_TRANSPORT` | `stdio`, or `http` for the remote connector | `stdio` |
| `MACOS_MCP_HTTP_PORT` | Loopback port for the HTTP transport | 8443 |
| `MACOS_MCP_PUBLIC_URL` | Public origin of the connector, no path (required for `http`); the MCP endpoint is `<url>/mcp` | Not set |
| `MACOS_MCP_HTTP_TOOLSETS` | Modules exposed over HTTP, e.g. `mail:read,messages`; `:read` keeps only read-only tools | All |
| `MACOS_MCP_OAUTH_PASSWORD_HASH` | Connector password hash, overriding `~/.macos-mcp/oauth-password` from `npm run set-password` | Not set |
| `MACOS_MCP_MESSAGES_HANDLES_ALLOWLIST` | Comma-separated phone numbers or emails `messages_send` may text (`*` wildcards allowed); every participant of a group must match | Not set (any) |

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

When enabled, destructive tools (`mail_send`, `mail_reply`, `mail_forward`, `messages_send`, `calendar_delete_event`, `reminders_delete`) require a `confirm: true` parameter. If omitted, the tool returns a warning asking the LLM to check with the user first. For `mail_reply` and `mail_forward`, confirmation is only required when `send: true` (the default) — saving as draft does not require confirmation.

## Tools (46)

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

### Notes (9)

| Tool | Description |
|---|---|
| `notes_list` | List notes with filtering by folder, account, pinned status, or date |
| `notes_get` | Get a single note with full body content |
| `notes_search` | Search notes by title and/or snippet content |
| `notes_list_folders` | List all note folders with note counts |
| `notes_create` | Create a new note in the specified folder |
| `notes_update` | Update a note's body content |
| `notes_delete` | Move a note to Recently Deleted (not permanent deletion) |
| `notes_move` | Move a note to a different folder |
| `notes_create_folder` | Create a new folder in Notes |

### Messages (5)

| Tool | Description |
|---|---|
| `messages_list_chats` | Recent chats with participants, unread count and last message preview |
| `messages_get_chat` | Messages in one chat, oldest first, with tapbacks folded into the message they react to |
| `messages_unread` | Unread incoming texts across all chats (junk excluded) |
| `messages_search` | Search message text, optionally limited to one person by handle or contact name |
| `messages_send` | Send to a phone number, email or existing chat; iMessage first, SMS only where that chat already uses SMS |

Reads come from `~/Library/Messages/chat.db`, so the process needs Full Disk Access. Participants are named from Contacts across every address book source. `messages_send` refuses a recipient with no existing chat and no matching contact unless called with `confirm: true`, and reports what `chat.db` shows after the send (`sent`, `delivered`, `failed`, or `unknown` if the row has not appeared). Messages cannot mark chats read through scripting, so there is no mark-read tool.

### Briefing (1)

| Tool | Description |
|---|---|
| `daily_briefing` | Today's events, due/overdue reminders, flagged and unread emails, unread texts |

## Remote Connector (HTTP)

With `MACOS_MCP_TRANSPORT=http` the server speaks Streamable HTTP on `127.0.0.1` and acts as its own OAuth 2.1 authorization server, so it can be added to claude.ai as a custom connector:

1. Single user: one password, stored as a scrypt hash by `npm run set-password`. Five wrong attempts lock sign-in for 15 minutes.
2. Dynamic client registration accepts only Claude's callback (`https://claude.ai/api/mcp/auth_callback`, and the `claude.com` form) and loopback `/callback` URLs for Claude Code.
3. PKCE (S256) is required. Access tokens last 1 hour; refresh tokens 30 days and rotate on use. Only token hashes are stored, in `~/.macos-mcp/auth.json` (0600).
4. Every tool call is logged to `~/.macos-mcp/audit.log` with the client, tool and a hash of the arguments, never the arguments.
5. `/healthz` reports version, uptime and whether the Mail and Messages databases are readable, and nothing else.
6. MCP resources are not exposed over HTTP; tools cover the same data and are audited.

Expose it with a tunnel such as Tailscale Funnel. [docs/connector-runbook.md](docs/connector-runbook.md) covers install, the LaunchAgent (`scripts/install-launchd.sh`), Funnel, adding the connector, password rotation and Full Disk Access.

## Resources

The server exposes browsable MCP resources:

| URI | Description |
|---|---|
| `macos://mail/accounts` | Email accounts |
| `macos://mail/{account}/mailboxes` | Mailboxes for an account |
| `macos://calendars` | All calendars |
| `macos://reminders/lists` | Reminder lists |
| `macos://contacts` | Contacts |
| `macos://messages/chats` | Recent message chats |

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
  index.ts              # Entry point: logging, transport choice, FTS auto-index
  server.ts             # Builds the MCP server (all tools, resources, daily briefing)
  transport/
    http.ts             # Streamable HTTP transport, health, toolsets, audit log
    oauth.ts            # Single-user OAuth 2.1 provider and sign-in page
    password.ts         # scrypt password hashing
    set-password.ts     # npm run set-password
  mail/
    tools.ts            # Mail reads (SQLite) and writes (JXA)
    fts.ts              # FTS5 full-text body search index
  calendar/
    tools.ts            # Calendar reads (SQLite) and writes (JXA)
  reminders/
    tools.ts            # Reminders reads (SQLite) and writes (JXA)
  contacts/
    tools.ts            # Contacts reads (SQLite)
  messages/
    tools.ts            # Messages tools: chats, unread, search, send
    db.ts               # chat.db queries (SQLite)
    attributed-body.ts  # Text extraction from attributedBody blobs
    jxa.ts              # Sending through Messages.app (JXA)
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

### Messages

1. `Messages database not found` or `unable to open database file`: the process reading `~/Library/Messages/chat.db` needs Full Disk Access. When the server runs under launchd rather than Claude Desktop, grant it to the `node` binary that launchd starts.
2. `Messages has no chat or participant for this recipient`: Messages scripting only exposes recent chats and known participants. Send the first message from Messages.app, then retry.
3. `messages_search` matches plain letters case-insensitively but accented and non-Latin text case-sensitively.

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
