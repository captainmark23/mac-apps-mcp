#!/usr/bin/env node

/**
 * macOS MCP Server
 *
 * Unified MCP server for Apple Mail, Calendar, and Reminders.
 * Read operations use SQLite for instant results; writes use JXA.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import * as mail from "./mail/tools.js";
import * as mailFts from "./mail/fts.js";
import * as calendar from "./calendar/tools.js";
import * as reminders from "./reminders/tools.js";

const server = new McpServer({
  name: "macos-mcp-server",
  version: "0.1.0",
});

/** Wrap handler with standard error handling. */
function err(error: unknown): { isError: true; content: [{ type: "text"; text: string }] } {
  const msg = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: `Error: ${msg}` }] };
}

// ═══════════════════════════════════════════════════════════════════
// MAIL TOOLS
// ═══════════════════════════════════════════════════════════════════

server.registerTool("mail_list_accounts", {
  description: "List all configured email accounts in Apple Mail",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const accounts = await mail.listAccounts();
    return { content: [{ type: "text", text: JSON.stringify(accounts, null, 2) }] };
  } catch (e) { return err(e); }
});

server.registerTool("mail_list_mailboxes", {
  description: "List all mailboxes for an email account",
  inputSchema: {
    account: z.string().optional().describe("Account name (default: first account)"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ account }) => {
  try {
    const mailboxes = await mail.listMailboxes(account);
    return { content: [{ type: "text", text: JSON.stringify(mailboxes, null, 2) }] };
  } catch (e) { return err(e); }
});

server.registerTool("mail_get_emails", {
  description: "Get emails from a mailbox with optional filtering. Returns newest first with pagination metadata.",
  inputSchema: {
    mailbox: z.string().default("INBOX").describe("Mailbox name"),
    account: z.string().optional().describe("Account name"),
    filter: z.enum(["all", "unread", "flagged", "today", "this_week"]).default("all").describe("Filter: all, unread, flagged, today, this_week"),
    limit: z.number().default(50).describe("Max emails to return"),
    offset: z.number().default(0).describe("Number of results to skip for pagination"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ mailbox, account, filter, limit, offset }) => {
  try {
    const result = await mail.getEmails(mailbox, account, filter, limit, offset);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e) { return err(e); }
});

server.registerTool("mail_get_email", {
  description: "Get a single email with full content including body text",
  inputSchema: {
    messageId: z.number().describe("Email ID (from mail_get_emails or mail_search)"),
    mailbox: z.string().default("INBOX"),
    account: z.string().optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ messageId, mailbox, account }) => {
  try {
    const email = await mail.getEmail(messageId, mailbox, account);
    return { content: [{ type: "text", text: JSON.stringify(email, null, 2) }] };
  } catch (e) { return err(e); }
});

server.registerTool("mail_search", {
  description: "Search emails by subject and/or sender in a mailbox. Returns pagination metadata.",
  inputSchema: {
    query: z.string().describe("Search term"),
    scope: z.enum(["all", "subject", "sender"]).default("all").describe("Where to search"),
    mailbox: z.string().default("INBOX"),
    account: z.string().optional(),
    limit: z.number().default(20),
    offset: z.number().default(0).describe("Number of results to skip for pagination"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ query, scope, mailbox, account, limit, offset }) => {
  try {
    const results = await mail.searchMail(query, scope, mailbox, account, limit, offset);
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  } catch (e) { return err(e); }
});

server.registerTool("mail_send", {
  description: "Send an email. For important emails, prefer mail_create_draft so the user can review first.",
  inputSchema: {
    to: z.array(z.string()).describe("Recipient email addresses"),
    subject: z.string().describe("Email subject"),
    body: z.string().describe("Email body text"),
    cc: z.array(z.string()).optional().describe("CC addresses"),
    bcc: z.array(z.string()).optional().describe("BCC addresses"),
    account: z.string().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ to, subject, body, cc, bcc, account }) => {
  try {
    const result = await mail.sendEmail(to, subject, body, cc, bcc, account);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (e) { return err(e); }
});

server.registerTool("mail_create_draft", {
  description: "Create a draft email for user review in Mail.app. Preferred for important emails.",
  inputSchema: {
    to: z.array(z.string()).describe("Recipient email addresses"),
    subject: z.string(),
    body: z.string(),
    cc: z.array(z.string()).optional(),
    account: z.string().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ to, subject, body, cc, account }) => {
  try {
    const result = await mail.createDraft(to, subject, body, cc, account);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (e) { return err(e); }
});

server.registerTool("mail_reply", {
  description: "Reply to an email. Set send=false to save as draft for review.",
  inputSchema: {
    messageId: z.number().describe("Email ID to reply to"),
    body: z.string().describe("Reply body"),
    replyAll: z.boolean().default(false),
    send: z.boolean().default(true).describe("Send immediately or save as draft"),
    mailbox: z.string().default("INBOX"),
    account: z.string().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ messageId, body, replyAll, send, mailbox, account }) => {
  try {
    const result = await mail.replyTo(messageId, body, replyAll, send, mailbox, account);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (e) { return err(e); }
});

server.registerTool("mail_forward", {
  description: "Forward an email. Set send=false to save as draft for review.",
  inputSchema: {
    messageId: z.number().describe("Email ID to forward"),
    to: z.array(z.string()).describe("Forward to these addresses"),
    body: z.string().optional().describe("Message to prepend"),
    send: z.boolean().default(true),
    mailbox: z.string().default("INBOX"),
    account: z.string().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ messageId, to, body, send, mailbox, account }) => {
  try {
    const result = await mail.forwardMessage(messageId, to, body, send, mailbox, account);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (e) { return err(e); }
});

server.registerTool("mail_move", {
  description: "Move an email to a different mailbox",
  inputSchema: {
    messageId: z.number(),
    targetMailbox: z.string().describe("Destination mailbox name"),
    sourceMailbox: z.string().default("INBOX"),
    account: z.string().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ messageId, targetMailbox, sourceMailbox, account }) => {
  try {
    const result = await mail.moveMessage(messageId, targetMailbox, sourceMailbox, account);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (e) { return err(e); }
});

server.registerTool("mail_set_flags", {
  description: "Set flagged and/or read status on an email",
  inputSchema: {
    messageId: z.number(),
    flagged: z.boolean().optional().describe("Set flagged status"),
    read: z.boolean().optional().describe("Set read status"),
    mailbox: z.string().default("INBOX"),
    account: z.string().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ messageId, flagged, read, mailbox, account }) => {
  try {
    const result = await mail.setMessageFlags(messageId, flagged, read, mailbox, account);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (e) { return err(e); }
});

// ═══════════════════════════════════════════════════════════════════
// MAIL FULL-TEXT SEARCH (FTS5)
// ═══════════════════════════════════════════════════════════════════

server.registerTool("mail_search_body", {
  description: "Search email body content using full-text search. Searches inside the actual email text, not just subject/sender. Requires the FTS index to be built first (use mail_fts_index). Returns pagination metadata.",
  inputSchema: {
    query: z.string().describe("Search term(s) to find in email bodies"),
    mailbox: z.string().default("INBOX"),
    account: z.string().optional(),
    limit: z.number().default(20),
    offset: z.number().default(0).describe("Number of results to skip for pagination"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ query, mailbox, account, limit, offset }) => {
  try {
    const results = await mailFts.searchBody(query, mailbox, account, limit, offset);
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  } catch (e) { return err(e); }
});

server.registerTool("mail_fts_index", {
  description: "Build or update the full-text search index for email bodies. Run with rebuild=true for a full re-index, or rebuild=false (default) for incremental updates.",
  inputSchema: {
    rebuild: z.boolean().default(false).describe("Full rebuild (true) or incremental update (false)"),
    limit: z.number().default(5000).describe("Max messages to process per batch"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ rebuild, limit }) => {
  try {
    const result = rebuild
      ? await mailFts.rebuildIndex(limit)
      : await mailFts.indexNewMessages(limit);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (e) { return err(e); }
});

server.registerTool("mail_fts_stats", {
  description: "Get statistics about the full-text search index: how many messages are indexed, total messages, index size.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const stats = await mailFts.getIndexStats();
    return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
  } catch (e) { return err(e); }
});

// ═══════════════════════════════════════════════════════════════════
// CALENDAR TOOLS
// ═══════════════════════════════════════════════════════════════════

server.registerTool("calendar_list", {
  description: "List all calendars (iCloud, Google, Exchange, etc.)",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const calendars = await calendar.listCalendars();
    return { content: [{ type: "text", text: JSON.stringify(calendars, null, 2) }] };
  } catch (e) { return err(e); }
});

server.registerTool("calendar_today", {
  description: "Get all events for today. Returns pagination metadata.",
  inputSchema: {
    calendar: z.string().optional().describe("Calendar name (default: all calendars)"),
    limit: z.number().default(200).describe("Max events to return"),
    offset: z.number().default(0).describe("Number of results to skip for pagination"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ calendar: cal, limit, offset }) => {
  try {
    const events = await calendar.getEventsToday(cal, limit, offset);
    return { content: [{ type: "text", text: JSON.stringify(events, null, 2) }] };
  } catch (e) { return err(e); }
});

server.registerTool("calendar_this_week", {
  description: "Get all events for the next 7 days. Returns pagination metadata.",
  inputSchema: {
    calendar: z.string().optional(),
    limit: z.number().default(200).describe("Max events to return"),
    offset: z.number().default(0).describe("Number of results to skip for pagination"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ calendar: cal, limit, offset }) => {
  try {
    const events = await calendar.getEventsThisWeek(cal, limit, offset);
    return { content: [{ type: "text", text: JSON.stringify(events, null, 2) }] };
  } catch (e) { return err(e); }
});

server.registerTool("calendar_get_events", {
  description: "Get events in a date range. Returns pagination metadata.",
  inputSchema: {
    startDate: z.string().describe("Start date (ISO 8601, e.g. 2026-03-08)"),
    endDate: z.string().describe("End date (ISO 8601)"),
    calendar: z.string().optional(),
    limit: z.number().default(200).describe("Max events to return"),
    offset: z.number().default(0).describe("Number of results to skip for pagination"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ startDate, endDate, calendar: cal, limit, offset }) => {
  try {
    const events = await calendar.getEvents(startDate, endDate, cal, limit, offset);
    return { content: [{ type: "text", text: JSON.stringify(events, null, 2) }] };
  } catch (e) { return err(e); }
});

server.registerTool("calendar_get_event", {
  description: "Get full details for a specific event including attendees",
  inputSchema: {
    eventId: z.string().describe("Event ID (from calendar_today etc.)"),
    calendar: z.string().describe("Calendar name the event belongs to"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ eventId, calendar: cal }) => {
  try {
    const event = await calendar.getEvent(eventId, cal);
    return { content: [{ type: "text", text: JSON.stringify(event, null, 2) }] };
  } catch (e) { return err(e); }
});

server.registerTool("calendar_create_event", {
  description: "Create a new calendar event",
  inputSchema: {
    summary: z.string().describe("Event title"),
    startDate: z.string().describe("Start date/time (ISO 8601)"),
    endDate: z.string().describe("End date/time (ISO 8601)"),
    calendar: z.string().optional().describe("Calendar name (default: first calendar)"),
    location: z.string().optional(),
    description: z.string().optional(),
    allDay: z.boolean().default(false),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ summary, startDate, endDate, calendar: cal, location, description, allDay }) => {
  try {
    const result = await calendar.createEvent(summary, startDate, endDate, cal, location, description, allDay);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (e) { return err(e); }
});

server.registerTool("calendar_modify_event", {
  description: "Modify an existing calendar event",
  inputSchema: {
    eventId: z.string(),
    calendar: z.string(),
    summary: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    location: z.string().optional(),
    description: z.string().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ eventId, calendar: cal, ...updates }) => {
  try {
    const result = await calendar.modifyEvent(eventId, cal, updates);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (e) { return err(e); }
});

server.registerTool("calendar_delete_event", {
  description: "Delete a calendar event",
  inputSchema: {
    eventId: z.string(),
    calendar: z.string(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
}, async ({ eventId, calendar: cal }) => {
  try {
    const result = await calendar.deleteEvent(eventId, cal);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (e) { return err(e); }
});

// ═══════════════════════════════════════════════════════════════════
// REMINDERS TOOLS
// ═══════════════════════════════════════════════════════════════════

server.registerTool("reminders_list_lists", {
  description: "List all reminder lists",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const lists = await reminders.listReminderLists();
    return { content: [{ type: "text", text: JSON.stringify(lists, null, 2) }] };
  } catch (e) { return err(e); }
});

server.registerTool("reminders_get", {
  description: "Get reminders with filtering. Default: incomplete only. Returns pagination metadata.",
  inputSchema: {
    list: z.string().optional().describe("Reminder list name (default: all lists)"),
    filter: z.enum(["all", "incomplete", "completed", "due_today", "overdue", "flagged"]).default("incomplete").describe("Filter: incomplete (default), due_today, overdue, flagged, completed, all"),
    limit: z.number().default(50).describe("Max reminders to return"),
    offset: z.number().default(0).describe("Number of results to skip for pagination"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ list, filter, limit, offset }) => {
  try {
    const items = await reminders.getReminders(list, filter, limit, offset);
    return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
  } catch (e) { return err(e); }
});

server.registerTool("reminders_get_detail", {
  description: "Get full details for a specific reminder",
  inputSchema: {
    reminderId: z.string(),
    list: z.string().describe("Reminder list name"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ reminderId, list }) => {
  try {
    const item = await reminders.getReminder(reminderId, list);
    return { content: [{ type: "text", text: JSON.stringify(item, null, 2) }] };
  } catch (e) { return err(e); }
});

server.registerTool("reminders_create", {
  description: "Create a new reminder",
  inputSchema: {
    name: z.string().describe("Reminder title"),
    list: z.string().optional().describe("List name (default: default list)"),
    dueDate: z.string().optional().describe("Due date (ISO 8601)"),
    body: z.string().optional().describe("Notes/description"),
    priority: z.number().optional().describe("Priority: 0=none, 1=high, 5=medium, 9=low"),
    flagged: z.boolean().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ name, list, dueDate, body, priority, flagged }) => {
  try {
    const result = await reminders.createReminder(name, list, dueDate, body, priority, flagged);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (e) { return err(e); }
});

server.registerTool("reminders_complete", {
  description: "Mark a reminder as completed",
  inputSchema: {
    reminderId: z.string(),
    list: z.string(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ reminderId, list }) => {
  try {
    const result = await reminders.completeReminder(reminderId, list);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (e) { return err(e); }
});

server.registerTool("reminders_delete", {
  description: "Delete a reminder",
  inputSchema: {
    reminderId: z.string(),
    list: z.string(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
}, async ({ reminderId, list }) => {
  try {
    const result = await reminders.deleteReminder(reminderId, list);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (e) { return err(e); }
});

// ═══════════════════════════════════════════════════════════════════
// DAILY BRIEFING (convenience tool)
// ═══════════════════════════════════════════════════════════════════

server.registerTool("daily_briefing", {
  description: "Get a complete daily briefing: today's calendar events, due/overdue reminders, and flagged/unread emails. Perfect for morning check-ins.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const [eventsResult, dueResult, overdueResult, incompleteResult, flaggedResult, unreadResult] =
      await Promise.all([
        calendar.getEventsToday().catch(() => ({ total: 0, count: 0, offset: 0, items: [], has_more: false })),
        reminders.getReminders(undefined, "due_today").catch(() => ({ total: 0, count: 0, offset: 0, items: [], has_more: false })),
        reminders.getReminders(undefined, "overdue").catch(() => ({ total: 0, count: 0, offset: 0, items: [], has_more: false })),
        reminders.getReminders(undefined, "incomplete").catch(() => ({ total: 0, count: 0, offset: 0, items: [], has_more: false })),
        mail.getEmails("INBOX", undefined, "flagged", 20).catch(() => ({ total: 0, count: 0, offset: 0, items: [], has_more: false })),
        mail.getEmails("INBOX", undefined, "unread", 20).catch(() => ({ total: 0, count: 0, offset: 0, items: [], has_more: false })),
      ]);

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
        flaggedCount: flaggedResult.total,
        flagged: flaggedResult.items,
        unreadCount: unreadResult.total,
        unread: unreadResult.items,
      },
    };

    return { content: [{ type: "text", text: JSON.stringify(briefing, null, 2) }] };
  } catch (e) { return err(e); }
});

// ═══════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});
