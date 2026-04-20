#!/usr/bin/env node

/**
 * macOS MCP Server
 *
 * Unified MCP server for Apple Mail, Calendar, Reminders, and Contacts.
 * Read operations use SQLite for instant results; writes use JXA.
 *
 * Tool registrations are organized per-domain in each module's register.ts.
 */

import { createWriteStream, existsSync, mkdirSync, statSync, renameSync, WriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { sanitizeErrorMessage } from "./shared/types.js";
import { ok, err } from "./shared/mcp-helpers.js";
import { registerMailTools, registerMailResources, EmailSummaryZ } from "./mail/register.js";
import { registerCalendarTools, registerCalendarResources, EventSummaryZ } from "./calendar/register.js";
import { registerRemindersTools, registerRemindersResources, ReminderSummaryZ } from "./reminders/register.js";
import { registerContactsTools, registerContactsResources } from "./contacts/register.js";
import { registerNotesTools, registerNotesResources, NoteSummaryZ } from "./notes/register.js";
import { isReadOnly } from "./shared/config.js";

import * as mail from "./mail/tools.js";
import * as mailFts from "./mail/fts.js";
import * as calendar from "./calendar/tools.js";
import * as reminders from "./reminders/tools.js";
import * as notes from "./notes/tools.js";

// ─── Persistent file logging ────────────────────────────────────
// Writes to ~/.macos-mcp/macos-mcp.log with simple size-based rotation.
// stderr is still used (stdout is reserved for MCP stdio transport).

const LOG_DIR = join(homedir(), ".macos-mcp");
const LOG_PATH = join(LOG_DIR, "macos-mcp.log");
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5MB
const LOG_BACKUPS = 3;

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

function rotateLogIfNeeded(): void {
  try {
    if (!existsSync(LOG_PATH)) return;
    const size = statSync(LOG_PATH).size;
    if (size < LOG_MAX_BYTES) return;
    // Shift backups: .3 → deleted, .2 → .3, .1 → .2, current → .1
    for (let i = LOG_BACKUPS; i >= 1; i--) {
      const src = i === 1 ? LOG_PATH : `${LOG_PATH}.${i - 1}`;
      const dst = `${LOG_PATH}.${i}`;
      if (existsSync(src)) renameSync(src, dst);
    }
  } catch { /* best-effort rotation */ }
}

rotateLogIfNeeded();
let _logStream: WriteStream | null = null;
try {
  _logStream = createWriteStream(LOG_PATH, { flags: "a" });
} catch { /* file logging unavailable — stderr still works */ }

/** Log to both stderr and the persistent log file. Sanitizes paths from messages. */
function log(message: string): void {
  const sanitized = sanitizeErrorMessage(message);
  const line = `${new Date().toISOString()} [macos-mcp] ${sanitized}\n`;
  process.stderr.write(line);
  _logStream?.write(line);
}

// ─── Server Setup ───────────────────────────────────────────────

const server = new McpServer({
  name: "mac-apps-mcp-server",
  version: "0.2.0",
});

/** Default message limit for FTS auto-index on first run. */
const FTS_AUTO_INDEX_BATCH = 5_000;

/** Default message limit for FTS incremental index on startup. */
const FTS_AUTO_INDEX_INCREMENTAL = 50_000;

// ─── Register Domain Tools & Resources ──────────────────────────

if (isReadOnly()) {
  log("Read-only mode enabled (MACOS_MCP_READONLY). Write tools will not be registered.");
}

registerMailTools(server);
registerCalendarTools(server);
registerRemindersTools(server);
registerContactsTools(server);
registerNotesTools(server);

registerMailResources(server);
registerCalendarResources(server);
registerRemindersResources(server);
registerContactsResources(server);
registerNotesResources(server);

// ═══════════════════════════════════════════════════════════════════
// DAILY BRIEFING (cross-domain convenience tool)
// ═══════════════════════════════════════════════════════════════════

server.registerTool("daily_briefing", {
  title: "Daily Briefing",
  description: "Get a complete daily briefing: today's calendar events, due/overdue reminders, flagged/unread emails across all configured mail accounts, and recently modified notes. Each email includes a body preview. When presenting the briefing: (1) Group emails by account. (2) Use the preview field to accurately describe each email — never guess from the subject line. (3) Call mail_get_email for any email you want to summarize in detail. Use when: morning review, getting a quick overview of the day",
  inputSchema: z.object({
    response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
  }).strict(),
  outputSchema: {
    date: z.string(),
    calendar: z.object({
      count: z.number(),
      events: z.array(EventSummaryZ),
    }),
    reminders: z.object({
      dueToday: z.array(ReminderSummaryZ),
      overdue: z.array(ReminderSummaryZ),
      incomplete: z.array(ReminderSummaryZ),
    }),
    mail: z.object({
      accounts: z.array(z.object({
        accountName: z.string(),
        flaggedCount: z.number(),
        flagged: z.array(EmailSummaryZ),
        unreadCount: z.number(),
        unread: z.array(EmailSummaryZ),
      })),
      totalFlaggedCount: z.number(),
      totalUnreadCount: z.number(),
    }),
    notes: z.object({
      count: z.number(),
      items: z.array(NoteSummaryZ),
    }),
    errors: z.array(z.string()).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ response_format }) => {
  try {
    const empty = { total: 0, count: 0, offset: 0, items: [] as unknown[], has_more: false };
    type WithError = typeof empty & { error?: string };

    // Calendar and reminders (not per-account)
    const [eventsResult, dueResult, overdueResult, incompleteResult] =
      await Promise.all([
        calendar.getEventsToday().catch((e: Error) => ({ ...empty, error: e.message })) as Promise<WithError>,
        reminders.getReminders(undefined, "due_today").catch((e: Error) => ({ ...empty, error: e.message })) as Promise<WithError>,
        reminders.getReminders(undefined, "overdue").catch((e: Error) => ({ ...empty, error: e.message })) as Promise<WithError>,
        reminders.getReminders(undefined, "incomplete").catch((e: Error) => ({ ...empty, error: e.message })) as Promise<WithError>,
      ]);

    // Notes modified today
    const notesResult = await notes.getNotesModifiedToday(10)
      .catch((e: Error) => ({ ...empty, error: e.message })) as WithError;

    // Mail: fetch per account
    const errors: string[] = [];
    let accounts: mail.Account[] = [];
    try {
      accounts = await mail.listAccounts();
    } catch (e) {
      errors.push(`mail_accounts: ${sanitizeErrorMessage(e instanceof Error ? e.message : String(e))}`);
    }

    const mailAccounts = await Promise.all(
      accounts.map(async (acct) => {
        const [flaggedResult, unreadResult] = await Promise.all([
          mail.getEmails("INBOX", acct.name, "flagged", 20)
            .catch((e: Error) => ({ ...empty, error: e.message })) as Promise<WithError>,
          mail.getEmails("INBOX", acct.name, "unread", 20)
            .catch((e: Error) => ({ ...empty, error: e.message })) as Promise<WithError>,
        ]);
        if (flaggedResult.error) errors.push(`mail_flagged(${acct.name}): ${sanitizeErrorMessage(flaggedResult.error)}`);
        if (unreadResult.error) errors.push(`mail_unread(${acct.name}): ${sanitizeErrorMessage(unreadResult.error)}`);
        return {
          accountName: acct.name,
          flaggedCount: flaggedResult.total,
          flagged: flaggedResult.items,
          unreadCount: unreadResult.total,
          unread: unreadResult.items,
        };
      })
    );

    // Collect errors from calendar/reminders
    for (const [label, result] of [
      ["calendar", eventsResult],
      ["reminders_due", dueResult],
      ["reminders_overdue", overdueResult],
      ["reminders_incomplete", incompleteResult],
      ["notes", notesResult],
    ] as [string, WithError][]) {
      if (result.error) errors.push(`${label}: ${sanitizeErrorMessage(result.error)}`);
    }

    const briefing = {
      date: new Date().toLocaleDateString("en-GB", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
      calendar: {
        count: eventsResult.items.length,
        events: eventsResult.items,
      },
      reminders: {
        dueToday: dueResult.items,
        overdue: overdueResult.items,
        incomplete: incompleteResult.items,
      },
      mail: {
        accounts: mailAccounts,
        totalFlaggedCount: mailAccounts.reduce((sum, a) => sum + a.flaggedCount, 0),
        totalUnreadCount: mailAccounts.reduce((sum, a) => sum + a.unreadCount, 0),
      },
      notes: {
        count: notesResult.items.length,
        items: notesResult.items,
      },
      ...(errors.length > 0 ? { errors } : {}),
    };

    return ok(briefing, true, response_format);
  } catch (e) { return err(e); }
});

// ═══════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════

/**
 * Auto-build the FTS index on startup.
 * Runs in the background so it doesn't block tool calls.
 * First run indexes the entire mailbox; subsequent runs catch up incrementally.
 */
async function autoIndexOnStartup() {
  try {
    const stats = await mailFts.getIndexStats();
    const isFirstRun = stats.indexedCount === 0;

    if (isFirstRun) {
      log(`First run — building FTS index for ${stats.totalMessages} messages in background...`);
      const result = await mailFts.rebuildIndex(FTS_AUTO_INDEX_BATCH);
      log(`FTS index built: ${result.indexed} messages indexed, ${result.skipped} skipped`);
    } else {
      const result = await mailFts.indexNewMessages(FTS_AUTO_INDEX_INCREMENTAL);
      if (result.indexed > 0) {
        log(`FTS index updated: ${result.indexed} new messages indexed`);
      }
    }
  } catch (e) {
    // Non-fatal — FTS is optional, other tools still work
    log(`FTS auto-index skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Kick off FTS indexing in background after server is ready
  autoIndexOnStartup().catch((e) => {
    log(`FTS auto-index unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  });
}

main().catch((error) => {
  log(`Server failed to start: ${error}`);
  console.error("Server failed to start:", sanitizeErrorMessage(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
