# Setting up mac-apps-mcp

This connects Claude Desktop to your Apple Mail, Calendar, and Reminders so Claude can read your schedule, check your emails, manage reminders, and more.

## Prerequisites

- macOS 14 (Sonoma) or later
- Claude Desktop installed
- A GitHub account with access to this repo

## Step 1: Install Node.js

Open Terminal (Applications > Utilities > Terminal) and run:

```bash
brew install node
```

If you don't have Homebrew, install it first:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Verify Node.js is installed:

```bash
node --version
```

You should see v20 or higher.

## Step 2: Clone and build

In Terminal, run:

```bash
cd ~
git clone https://github.com/captainmark23/mac-apps-mcp.git
cd mac-apps-mcp
npm install
npm run build
```

## Step 3: Grant Full Disk Access

Claude Desktop needs permission to read your Mail, Calendar, and Reminders databases.

1. Open **System Settings**
2. Go to **Privacy & Security > Full Disk Access**
3. Click the **+** button
4. Add **Claude** (from Applications)
5. You may also need to add the Node.js binary:
   - In Terminal, run: `which node` — it will show something like `/opt/homebrew/bin/node`
   - If that's a symlink, run: `readlink -f $(which node)` to get the real path
   - Add that path to Full Disk Access

## Step 4: Configure Claude Desktop

1. Open Claude Desktop
2. Go to **Settings > Developer > Edit Config** (or open the file directly):

```
~/Library/Application Support/Claude/claude_desktop_config.json
```

3. Replace the contents with the following (update the paths and names for your setup):

```json
{
  "mcpServers": {
    "mac-apps-mcp": {
      "command": "node",
      "args": [
        "/Users/YOUR_USERNAME/mac-apps-mcp/build/index.js"
      ],
      "env": {
        "MACOS_MCP_CALENDARS": "Calendar1,Calendar2",
        "MACOS_MCP_MAIL_ACCOUNT": "iCloud"
      }
    }
  }
}
```

**Important — customise these values:**

- Replace `YOUR_USERNAME` with your macOS username (run `whoami` in Terminal to check)
- Replace `Calendar1,Calendar2` with your calendar names, comma-separated. To see your calendars, open Calendar.app and look at the sidebar. Only list the ones you want Claude to see.
- Replace `iCloud` with your default mail account name as it appears in Mail.app (Settings > Accounts). Common values: `iCloud`, `Gmail`, `Exchange`.

### Optional settings

- `MACOS_MCP_REMINDER_LISTS` — Comma-separated reminder list names to include (default: all lists)

## Step 5: Restart Claude Desktop

Quit Claude Desktop completely (Cmd+Q) and reopen it. The mac-apps-mcp tools should now be available.

## Step 6: Test it

Try asking Claude:

- "What's on my calendar today?"
- "Do I have any unread emails?"
- "What are my incomplete reminders?"
- "Give me a daily briefing"

## Step 7 (Optional): Build the email search index

This lets Claude search inside email body text, not just subjects and senders. It takes about 10-15 minutes the first time.

Ask Claude: "Please build my email search index" (it will use the `mail_fts_index` tool with rebuild=true).

After that, you can search with: "Search my emails for invoice from Amazon"

## Troubleshooting

### "Tool not found" or tools not appearing
- Make sure you restarted Claude Desktop after editing the config
- Check the config file is valid JSON (no trailing commas, etc.)
- Verify the path to `build/index.js` is correct

### "Permission denied" or empty results
- Check Full Disk Access is granted (Step 3)
- Try restarting Claude Desktop after granting access

### "Command not found: node"
- Make sure Node.js is installed (Step 1)
- Try using the full path to node in the config: replace `"command": "node"` with `"command": "/opt/homebrew/bin/node"`

### Getting updates

When updates are available:

```bash
cd ~/mac-apps-mcp
git pull
npm install
npm run build
```

Then restart Claude Desktop.
