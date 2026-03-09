#!/usr/bin/env node

/**
 * macOS MCP Server
 *
 * Unified MCP server for Apple Mail, Calendar, and Reminders.
 * All operations use AppleScript/JXA — no native dependencies required.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import * as mail from "./mail/tools.js";
import * as mailFts from "./mail/fts.js";
import * as calendar from "./calendar/tools.js";
import * as reminders from "./reminders/tools.js";

const server = new McpServer({
  name: "macos-mcp",
  version: "0.1.0",
});

// ═══════════════════════════════════════════════════════════════════
// MAIL TOOLS
// ═══════════════════════════════════════════════════════════════════

server.tool(
  "mail_list_accounts",
  "List all configured email accounts in Apple Mail",
  {},
  async () => {
    const accounts = await mail.listAccounts();
    return { content: [{ type: "text", text: JSON.stringify(accounts, null, 2) }] };
  }
);

server.tool(
  "mail_list_mailboxes",
  "List all mailboxes for an email account",
  { account: z.string().optional().describe("Account name (default: first account)") },
  async ({ account }) => {
    const mailboxes = await mail.listMailboxes(account);
    return { content: [{ type: "text", text: JSON.stringify(mailboxes, null, 2) }] };
  }
);

server.tool(
  "mail_get_emails",
  "Get emails from a mailbox with optional filtering. Returns newest first.",
  {
    mailbox: z.string().default("INBOX").describe("Mailbox name"),
    account: z.string().optional().describe("Account name"),
    filter: z
      .enum(["all", "unread", "flagged", "today", "this_week"])
      .default("all")
      .describe("Filter: all, unread, flagged, today, this_week"),
    limit: z.number().default(50).describe("Max emails to return"),
  },
  async ({ mailbox, account, filter, limit }) => {
    const emails = await mail.getEmails(mailbox, account, filter, limit);
    return { content: [{ type: "text", text: JSON.stringify(emails, null, 2) }] };
  }
);

server.tool(
  "mail_get_email",
  "Get a single email with full content including body text",
  {
    messageId: z.number().describe("Email ID (from mail_get_emails or mail_search)"),
    mailbox: z.string().default("INBOX"),
    account: z.string().optional(),
  },
  async ({ messageId, mailbox, account }) => {
    const email = await mail.getEmail(messageId, mailbox, account);
    return { content: [{ type: "text", text: JSON.stringify(email, null, 2) }] };
  }
);

server.tool(
  "mail_search",
  "Search emails by subject and/or sender in a mailbox",
  {
    query: z.string().describe("Search term"),
    scope: z
      .enum(["all", "subject", "sender"])
      .default("all")
      .describe("Where to search"),
    mailbox: z.string().default("INBOX"),
    account: z.string().optional(),
    limit: z.number().default(20),
  },
  async ({ query, scope, mailbox, account, limit }) => {
    const results = await mail.searchMail(query, scope, mailbox, account, limit);
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  }
);

server.tool(
  "mail_send",
  "Send an email. For important emails, prefer mail_create_draft so the user can review first.",
  {
    to: z.array(z.string()).describe("Recipient email addresses"),
    subject: z.string().describe("Email subject"),
    body: z.string().describe("Email body text"),
    cc: z.array(z.string()).optional().describe("CC addresses"),
    bcc: z.array(z.string()).optional().describe("BCC addresses"),
    account: z.string().optional(),
  },
  async ({ to, subject, body, cc, bcc, account }) => {
    const result = await mail.sendEmail(to, subject, body, cc, bcc, account);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "mail_create_draft",
  "Create a draft email for user review in Mail.app. Preferred for important emails.",
  {
    to: z.array(z.string()).describe("Recipient email addresses"),
    subject: z.string(),
    body: z.string(),
    cc: z.array(z.string()).optional(),
    account: z.string().optional(),
  },
  async ({ to, subject, body, cc, account }) => {
    const result = await mail.createDraft(to, subject, body, cc, account);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "mail_reply",
  "Reply to an email. Set send=false to save as draft for review.",
  {
    messageId: z.number().describe("Email ID to reply to"),
    body: z.string().describe("Reply body"),
    replyAll: z.boolean().default(false),
    send: z.boolean().default(true).describe("Send immediately or save as draft"),
    mailbox: z.string().default("INBOX"),
    account: z.string().optional(),
  },
  async ({ messageId, body, replyAll, send, mailbox, account }) => {
    const result = await mail.replyTo(messageId, body, replyAll, send, mailbox, account);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "mail_forward",
  "Forward an email. Set send=false to save as draft for review.",
  {
    messageId: z.number().describe("Email ID to forward"),
    to: z.array(z.string()).describe("Forward to these addresses"),
    body: z.string().optional().describe("Message to prepend"),
    send: z.boolean().default(true),
    mailbox: z.string().default("INBOX"),
    account: z.string().optional(),
  },
  async ({ messageId, to, body, send, mailbox, account }) => {
    const result = await mail.forwardMessage(messageId, to, body, send, mailbox, account);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "mail_move",
  "Move an email to a different mailbox",
  {
    messageId: z.number(),
    targetMailbox: z.string().describe("Destination mailbox name"),
    sourceMailbox: z.string().default("INBOX"),
    account: z.string().optional(),
  },
  async ({ messageId, targetMailbox, sourceMailbox, account }) => {
    const result = await mail.moveMessage(messageId, targetMailbox, sourceMailbox, account);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "mail_set_flags",
  "Set flagged and/or read status on an email",
  {
    messageId: z.number(),
    flagged: z.boolean().optional().describe("Set flagged status"),
    read: z.boolean().optional().describe("Set read status"),
    mailbox: z.string().default("INBOX"),
    account: z.string().optional(),
  },
  async ({ messageId, flagged, read, mailbox, account }) => {
    const result = await mail.setMessageFlags(messageId, flagged, read, mailbox, account);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

// ═══════════════════════════════════════════════════════════════════
// MAIL FULL-TEXT SEARCH (FTS5)
// ═══════════════════════════════════════════════════════════════════

server.tool(
  "mail_search_body",
  "Search email body content using full-text search. Searches inside the actual email text, not just subject/sender. Requires the FTS index to be built first (use mail_fts_index).",
  {
    query: z.string().describe("Search term(s) to find in email bodies"),
    mailbox: z.string().default("INBOX"),
    account: z.string().optional(),
    limit: z.number().default(20),
  },
  async ({ query, mailbox, account, limit }) => {
    const results = await mailFts.searchBody(query, mailbox, account, limit);
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  }
);

server.tool(
  "mail_fts_index",
  "Build or update the full-text search index for email bodies. Run with rebuild=true for a full re-index, or rebuild=false (default) for incremental updates.",
  {
    rebuild: z.boolean().default(false).describe("Full rebuild (true) or incremental update (false)"),
    limit: z.number().default(5000).describe("Max messages to process per batch"),
  },
  async ({ rebuild, limit }) => {
    const result = rebuild
      ? await mailFts.rebuildIndex(limit)
      : await mailFts.indexNewMessages(limit);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "mail_fts_stats",
  "Get statistics about the full-text search index: how many messages are indexed, total messages, index size.",
  {},
  async () => {
    const stats = await mailFts.getIndexStats();
    return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
  }
);

// ═══════════════════════════════════════════════════════════════════
// CALENDAR TOOLS
// ═══════════════════════════════════════════════════════════════════

server.tool(
  "calendar_list",
  "List all calendars (iCloud, Google, Exchange, etc.)",
  {},
  async () => {
    const calendars = await calendar.listCalendars();
    return { content: [{ type: "text", text: JSON.stringify(calendars, null, 2) }] };
  }
);

server.tool(
  "calendar_today",
  "Get all events for today",
  {
    calendar: z.string().optional().describe("Calendar name (default: all calendars)"),
  },
  async ({ calendar: cal }) => {
    const events = await calendar.getEventsToday(cal);
    return { content: [{ type: "text", text: JSON.stringify(events, null, 2) }] };
  }
);

server.tool(
  "calendar_this_week",
  "Get all events for the next 7 days",
  {
    calendar: z.string().optional(),
  },
  async ({ calendar: cal }) => {
    const events = await calendar.getEventsThisWeek(cal);
    return { content: [{ type: "text", text: JSON.stringify(events, null, 2) }] };
  }
);

server.tool(
  "calendar_get_events",
  "Get events in a date range",
  {
    startDate: z.string().describe("Start date (ISO 8601 or natural, e.g. 2026-03-08)"),
    endDate: z.string().describe("End date"),
    calendar: z.string().optional(),
  },
  async ({ startDate, endDate, calendar: cal }) => {
    const events = await calendar.getEvents(startDate, endDate, cal);
    return { content: [{ type: "text", text: JSON.stringify(events, null, 2) }] };
  }
);

server.tool(
  "calendar_get_event",
  "Get full details for a specific event including attendees",
  {
    eventId: z.string().describe("Event ID (from calendar_today etc.)"),
    calendar: z.string().describe("Calendar name the event belongs to"),
  },
  async ({ eventId, calendar: cal }) => {
    const event = await calendar.getEvent(eventId, cal);
    return { content: [{ type: "text", text: JSON.stringify(event, null, 2) }] };
  }
);

server.tool(
  "calendar_create_event",
  "Create a new calendar event",
  {
    summary: z.string().describe("Event title"),
    startDate: z.string().describe("Start date/time (ISO 8601)"),
    endDate: z.string().describe("End date/time (ISO 8601)"),
    calendar: z.string().optional().describe("Calendar name (default: first calendar)"),
    location: z.string().optional(),
    description: z.string().optional(),
    allDay: z.boolean().default(false),
  },
  async ({ summary, startDate, endDate, calendar: cal, location, description, allDay }) => {
    const result = await calendar.createEvent(
      summary, startDate, endDate, cal, location, description, allDay
    );
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "calendar_modify_event",
  "Modify an existing calendar event",
  {
    eventId: z.string(),
    calendar: z.string(),
    summary: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    location: z.string().optional(),
    description: z.string().optional(),
  },
  async ({ eventId, calendar: cal, ...updates }) => {
    const result = await calendar.modifyEvent(eventId, cal, updates);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "calendar_delete_event",
  "Delete a calendar event",
  {
    eventId: z.string(),
    calendar: z.string(),
  },
  async ({ eventId, calendar: cal }) => {
    const result = await calendar.deleteEvent(eventId, cal);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

// ═══════════════════════════════════════════════════════════════════
// REMINDERS TOOLS
// ═══════════════════════════════════════════════════════════════════

server.tool(
  "reminders_list_lists",
  "List all reminder lists",
  {},
  async () => {
    const lists = await reminders.listReminderLists();
    return { content: [{ type: "text", text: JSON.stringify(lists, null, 2) }] };
  }
);

server.tool(
  "reminders_get",
  "Get reminders with filtering. Default: incomplete only.",
  {
    list: z.string().optional().describe("Reminder list name (default: all lists)"),
    filter: z
      .enum(["all", "incomplete", "completed", "due_today", "overdue", "flagged"])
      .default("incomplete")
      .describe("Filter: incomplete (default), due_today, overdue, flagged, completed, all"),
  },
  async ({ list, filter }) => {
    const items = await reminders.getReminders(list, filter);
    return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
  }
);

server.tool(
  "reminders_get_detail",
  "Get full details for a specific reminder",
  {
    reminderId: z.string(),
    list: z.string().describe("Reminder list name"),
  },
  async ({ reminderId, list }) => {
    const item = await reminders.getReminder(reminderId, list);
    return { content: [{ type: "text", text: JSON.stringify(item, null, 2) }] };
  }
);

server.tool(
  "reminders_create",
  "Create a new reminder",
  {
    name: z.string().describe("Reminder title"),
    list: z.string().optional().describe("List name (default: default list)"),
    dueDate: z.string().optional().describe("Due date (ISO 8601)"),
    body: z.string().optional().describe("Notes/description"),
    priority: z.number().optional().describe("Priority: 0=none, 1=high, 5=medium, 9=low"),
    flagged: z.boolean().optional(),
  },
  async ({ name, list, dueDate, body, priority, flagged }) => {
    const result = await reminders.createReminder(name, list, dueDate, body, priority, flagged);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "reminders_complete",
  "Mark a reminder as completed",
  {
    reminderId: z.string(),
    list: z.string(),
  },
  async ({ reminderId, list }) => {
    const result = await reminders.completeReminder(reminderId, list);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "reminders_delete",
  "Delete a reminder",
  {
    reminderId: z.string(),
    list: z.string(),
  },
  async ({ reminderId, list }) => {
    const result = await reminders.deleteReminder(reminderId, list);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

// ═══════════════════════════════════════════════════════════════════
// DAILY BRIEFING (convenience tool)
// ═══════════════════════════════════════════════════════════════════

server.tool(
  "daily_briefing",
  "Get a complete daily briefing: today's calendar events, due/overdue reminders, and flagged/unread emails. Perfect for morning check-ins.",
  {},
  async () => {
    const [events, dueReminders, overdueReminders, incompleteReminders, flaggedMail, unreadMail] =
      await Promise.all([
        calendar.getEventsToday().catch(() => []),
        reminders.getReminders(undefined, "due_today").catch(() => []),
        reminders.getReminders(undefined, "overdue").catch(() => []),
        reminders.getReminders(undefined, "incomplete").catch(() => []),
        mail.getEmails("INBOX", undefined, "flagged", 20).catch(() => []),
        mail.getEmails("INBOX", undefined, "unread", 20).catch(() => []),
      ]);

    const briefing = {
      date: new Date().toLocaleDateString("en-GB", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
      calendar: {
        count: events.length,
        events,
      },
      reminders: {
        dueToday: dueReminders,
        overdue: overdueReminders,
        incomplete: incompleteReminders,
      },
      mail: {
        flaggedCount: flaggedMail.length,
        flagged: flaggedMail,
        unreadCount: unreadMail.length,
        unread: unreadMail,
      },
    };

    return {
      content: [{ type: "text", text: JSON.stringify(briefing, null, 2) }],
    };
  }
);

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
