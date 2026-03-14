#!/usr/bin/env node

/**
 * macOS MCP Server
 *
 * Unified MCP server for Apple Mail, Calendar, and Reminders.
 * Read operations use SQLite for instant results; writes use JXA.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import * as mail from "./mail/tools.js";
import * as mailFts from "./mail/fts.js";
import * as calendar from "./calendar/tools.js";
import * as reminders from "./reminders/tools.js";
import * as contacts from "./contacts/tools.js";

const server = new McpServer({
  name: "macos-mcp-server",
  version: "0.1.0",
});

/** Wrap handler with standard error handling. */
function err(error: unknown): { isError: true; content: [{ type: "text"; text: string }] } {
  const msg = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: `Error: ${msg}` }] };
}

/** Format a successful tool response with structured content. */
function ok(data: object, pretty = true) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, pretty ? 2 : undefined) }],
    structuredContent: data as Record<string, unknown>,
  };
}

// ─── Output Schemas ─────────────────────────────────────────────

const EmailSummaryZ = z.object({
  id: z.number(),
  subject: z.string(),
  sender: z.string(),
  dateReceived: z.string(),
  read: z.boolean(),
  flagged: z.boolean(),
  mailbox: z.string(),
  account: z.string(),
  preview: z.string().describe("First ~200 chars of email body text — use this to understand what the email is actually about before presenting it to the user"),
});

const EmailFullZ = z.object({
  id: z.number(),
  subject: z.string(),
  sender: z.string(),
  dateReceived: z.string(),
  dateSent: z.string(),
  read: z.boolean(),
  flagged: z.boolean(),
  content: z.string(),
  replyTo: z.string(),
  messageId: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  mailbox: z.string(),
  account: z.string(),
});

const EventSummaryZ = z.object({
  id: z.string(),
  summary: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  location: z.string(),
  allDay: z.boolean(),
  calendar: z.string(),
  status: z.string(),
});

const EventFullZ = EventSummaryZ.extend({
  description: z.string(),
  url: z.string(),
  recurrence: z.string(),
  attendees: z.array(z.object({
    name: z.string(),
    email: z.string(),
    status: z.string(),
  })),
});

const ReminderSummaryZ = z.object({
  id: z.string(),
  name: z.string(),
  completed: z.boolean(),
  completionDate: z.string(),
  dueDate: z.string(),
  priority: z.number(),
  list: z.string(),
  flagged: z.boolean(),
});

const ReminderFullZ = ReminderSummaryZ.extend({
  body: z.string(),
  creationDate: z.string(),
  modificationDate: z.string(),
});

const FtsResultZ = z.object({
  id: z.number(),
  subject: z.string(),
  sender: z.string(),
  dateReceived: z.string(),
  read: z.boolean(),
  flagged: z.boolean(),
  snippet: z.string(),
});

/** Build a paginated output shape for a given item schema. */
function paginatedOutput<T extends z.ZodTypeAny>(itemSchema: T) {
  return {
    total: z.number(),
    count: z.number(),
    offset: z.number(),
    items: z.array(itemSchema),
    has_more: z.boolean(),
    next_offset: z.number().optional(),
  };
}

const SuccessZ = { success: z.boolean() };
const SuccessMessageZ = { success: z.boolean(), message: z.string() };
const SuccessIdZ = { success: z.boolean(), id: z.string() };

// ═══════════════════════════════════════════════════════════════════
// MAIL TOOLS
// ═══════════════════════════════════════════════════════════════════

server.registerTool("mail_list_accounts", {
  description: "List all configured email accounts in Apple Mail",
  inputSchema: {},
  outputSchema: {
    accounts: z.array(z.object({ name: z.string(), id: z.string() })),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const accounts = await mail.listAccounts();
    return ok({ accounts });
  } catch (e) { return err(e); }
});

server.registerTool("mail_list_mailboxes", {
  description: "List all mailboxes for an email account",
  inputSchema: {
    account: z.string().optional().describe("Account name (default: first account)"),
  },
  outputSchema: {
    mailboxes: z.array(z.object({ name: z.string(), unreadCount: z.number() })),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ account }) => {
  try {
    const mailboxes = await mail.listMailboxes(account);
    return ok({ mailboxes });
  } catch (e) { return err(e); }
});

server.registerTool("mail_get_emails", {
  description: "Get emails with optional filtering. Each result includes the account, mailbox, and a body preview (~200 chars). Omit mailbox to search across all mailboxes and accounts. TRIAGE GUIDELINES: (1) Group results by account when presenting to the user. (2) Use the preview field to understand what each email is about — never guess from the subject line alone. (3) For any email you want to describe in detail, call mail_get_email first to read the full body. Returns newest first with pagination metadata.",
  inputSchema: {
    mailbox: z.string().optional().describe("Mailbox name (e.g. 'INBOX'). Omit to search all mailboxes across all accounts."),
    account: z.string().optional().describe("Account name (e.g. 'iCloud'). Omit to search all accounts."),
    filter: z.enum(["all", "unread", "flagged", "today", "this_week"]).default("all").describe("Filter: all, unread, flagged, today, this_week"),
    limit: z.number().min(1).max(500).default(50).describe("Max emails to return"),
    offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
  },
  outputSchema: paginatedOutput(EmailSummaryZ),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ mailbox, account, filter, limit, offset }) => {
  try {
    const result = await mail.getEmails(mailbox, account, filter, limit, offset);
    return ok(result);
  } catch (e) { return err(e); }
});

server.registerTool("mail_get_email", {
  description: "Get a single email with full content including body text. Reads the email body directly from disk — no need to specify mailbox or account. Returns the account and mailbox the email belongs to.",
  inputSchema: {
    messageId: z.number().describe("Email ID (from mail_get_emails or mail_search)"),
  },
  outputSchema: EmailFullZ.shape,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ messageId }) => {
  try {
    const email = await mail.getEmail(messageId);
    return ok(email);
  } catch (e) { return err(e); }
});

server.registerTool("mail_search", {
  description: "Search emails by subject and/or sender. Each result includes the account, mailbox, and a body preview (~200 chars). Omit mailbox to search across all mailboxes and accounts. Use the preview field to understand results — never guess content from the subject line alone. Returns pagination metadata.",
  inputSchema: {
    query: z.string().describe("Search term"),
    scope: z.enum(["all", "subject", "sender"]).default("all").describe("Where to search"),
    mailbox: z.string().optional().describe("Mailbox name. Omit to search all mailboxes across all accounts."),
    account: z.string().optional().describe("Account name. Omit to search all accounts."),
    limit: z.number().min(1).max(500).default(20).describe("Max results to return"),
    offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
  },
  outputSchema: paginatedOutput(EmailSummaryZ),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ query, scope, mailbox, account, limit, offset }) => {
  try {
    const results = await mail.searchMail(query, scope, mailbox, account, limit, offset);
    return ok(results);
  } catch (e) { return err(e); }
});

server.registerTool("mail_send", {
  description: "Send an email. For important emails, prefer mail_create_draft so the user can review first.",
  inputSchema: {
    to: z.array(z.string().email()).describe("Recipient email addresses"),
    subject: z.string().describe("Email subject"),
    body: z.string().describe("Email body text"),
    cc: z.array(z.string().email()).optional().describe("CC addresses"),
    bcc: z.array(z.string().email()).optional().describe("BCC addresses"),
    account: z.string().optional(),
  },
  outputSchema: SuccessMessageZ,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ to, subject, body, cc, bcc, account }) => {
  try {
    const result = await mail.sendEmail(to, subject, body, cc, bcc, account);
    return ok(result, false);
  } catch (e) { return err(e); }
});

server.registerTool("mail_create_draft", {
  description: "Create a draft email for user review in Mail.app. Preferred for important emails.",
  inputSchema: {
    to: z.array(z.string().email()).describe("Recipient email addresses"),
    subject: z.string(),
    body: z.string(),
    cc: z.array(z.string().email()).optional(),
    account: z.string().optional(),
  },
  outputSchema: SuccessMessageZ,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ to, subject, body, cc, account }) => {
  try {
    const result = await mail.createDraft(to, subject, body, cc, account);
    return ok(result, false);
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
  outputSchema: SuccessMessageZ,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ messageId, body, replyAll, send, mailbox, account }) => {
  try {
    const result = await mail.replyTo(messageId, body, replyAll, send, mailbox, account);
    return ok(result, false);
  } catch (e) { return err(e); }
});

server.registerTool("mail_forward", {
  description: "Forward an email. Set send=false to save as draft for review.",
  inputSchema: {
    messageId: z.number().describe("Email ID to forward"),
    to: z.array(z.string().email()).describe("Forward to these addresses"),
    body: z.string().optional().describe("Message to prepend"),
    send: z.boolean().default(true),
    mailbox: z.string().default("INBOX"),
    account: z.string().optional(),
  },
  outputSchema: SuccessMessageZ,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ messageId, to, body, send, mailbox, account }) => {
  try {
    const result = await mail.forwardMessage(messageId, to, body, send, mailbox, account);
    return ok(result, false);
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
  outputSchema: SuccessZ,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ messageId, targetMailbox, sourceMailbox, account }) => {
  try {
    const result = await mail.moveMessage(messageId, targetMailbox, sourceMailbox, account);
    return ok(result, false);
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
  outputSchema: SuccessZ,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ messageId, flagged, read, mailbox, account }) => {
  try {
    const result = await mail.setMessageFlags(messageId, flagged, read, mailbox, account);
    return ok(result, false);
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
    limit: z.number().min(1).max(500).default(20).describe("Max results to return"),
    offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
  },
  outputSchema: paginatedOutput(FtsResultZ),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ query, mailbox, account, limit, offset }) => {
  try {
    const results = await mailFts.searchBody(query, mailbox, account, limit, offset);
    return ok(results);
  } catch (e) { return err(e); }
});

server.registerTool("mail_fts_index", {
  description: "Build or update the full-text search index for email bodies. Run with rebuild=true for a full re-index, or rebuild=false (default) for incremental updates.",
  inputSchema: {
    rebuild: z.boolean().default(false).describe("Full rebuild (true) or incremental update (false)"),
    limit: z.number().min(1).max(50000).default(5000).describe("Max messages to process per batch"),
  },
  outputSchema: {
    indexed: z.number(),
    skipped: z.number(),
    total: z.number(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ rebuild, limit }, extra) => {
  try {
    const progressToken = extra?._meta?.progressToken;
    const onProgress = progressToken != null
      ? (progress: number, total: number, message: string) => {
          extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress, total, message },
          });
        }
      : undefined;

    const result = rebuild
      ? await mailFts.rebuildIndex(limit, onProgress)
      : await mailFts.indexNewMessages(limit, onProgress);
    return ok(result, false);
  } catch (e) { return err(e); }
});

server.registerTool("mail_fts_stats", {
  description: "Get statistics about the full-text search index: how many messages are indexed, total messages, index size.",
  inputSchema: {},
  outputSchema: {
    indexedCount: z.number(),
    totalMessages: z.number(),
    lastIndexedRowid: z.number(),
    dbSizeMb: z.number(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const stats = await mailFts.getIndexStats();
    return ok(stats);
  } catch (e) { return err(e); }
});

// ═══════════════════════════════════════════════════════════════════
// CALENDAR TOOLS
// ═══════════════════════════════════════════════════════════════════

server.registerTool("calendar_list", {
  description: "List all calendars (iCloud, Google, Exchange, etc.)",
  inputSchema: {},
  outputSchema: {
    calendars: z.array(z.object({
      name: z.string(),
      id: z.string(),
      writable: z.boolean(),
      color: z.string(),
    })),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const calendars = await calendar.listCalendars();
    return ok({ calendars });
  } catch (e) { return err(e); }
});

server.registerTool("calendar_today", {
  description: "Get all events for today. Returns pagination metadata.",
  inputSchema: {
    calendar: z.string().optional().describe("Calendar name (default: all calendars)"),
    limit: z.number().min(1).max(500).default(200).describe("Max events to return"),
    offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
  },
  outputSchema: paginatedOutput(EventSummaryZ),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ calendar: cal, limit, offset }) => {
  try {
    const events = await calendar.getEventsToday(cal, limit, offset);
    return ok(events);
  } catch (e) { return err(e); }
});

server.registerTool("calendar_this_week", {
  description: "Get all events for the next 7 days. Returns pagination metadata.",
  inputSchema: {
    calendar: z.string().optional(),
    limit: z.number().min(1).max(500).default(200).describe("Max events to return"),
    offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
  },
  outputSchema: paginatedOutput(EventSummaryZ),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ calendar: cal, limit, offset }) => {
  try {
    const events = await calendar.getEventsThisWeek(cal, limit, offset);
    return ok(events);
  } catch (e) { return err(e); }
});

server.registerTool("calendar_get_events", {
  description: "Get events in a date range. Returns pagination metadata.",
  inputSchema: {
    startDate: z.string().describe("Start date (ISO 8601, e.g. 2026-03-08)"),
    endDate: z.string().describe("End date (ISO 8601)"),
    calendar: z.string().optional(),
    limit: z.number().min(1).max(500).default(200).describe("Max events to return"),
    offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
  },
  outputSchema: paginatedOutput(EventSummaryZ),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ startDate, endDate, calendar: cal, limit, offset }) => {
  try {
    const events = await calendar.getEvents(startDate, endDate, cal, limit, offset);
    return ok(events);
  } catch (e) { return err(e); }
});

server.registerTool("calendar_get_event", {
  description: "Get full details for a specific event including attendees",
  inputSchema: {
    eventId: z.string().describe("Event ID (from calendar_today etc.)"),
    calendar: z.string().describe("Calendar name the event belongs to"),
  },
  outputSchema: EventFullZ.shape,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ eventId, calendar: cal }) => {
  try {
    const event = await calendar.getEvent(eventId, cal);
    return ok(event);
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
  outputSchema: SuccessIdZ,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ summary, startDate, endDate, calendar: cal, location, description, allDay }) => {
  try {
    const result = await calendar.createEvent(summary, startDate, endDate, cal, location, description, allDay);
    return ok(result, false);
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
  outputSchema: SuccessZ,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ eventId, calendar: cal, ...updates }) => {
  try {
    const result = await calendar.modifyEvent(eventId, cal, updates);
    return ok(result, false);
  } catch (e) { return err(e); }
});

server.registerTool("calendar_delete_event", {
  description: "Delete a calendar event",
  inputSchema: {
    eventId: z.string(),
    calendar: z.string(),
  },
  outputSchema: SuccessZ,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
}, async ({ eventId, calendar: cal }) => {
  try {
    const result = await calendar.deleteEvent(eventId, cal);
    return ok(result, false);
  } catch (e) { return err(e); }
});

// ═══════════════════════════════════════════════════════════════════
// REMINDERS TOOLS
// ═══════════════════════════════════════════════════════════════════

server.registerTool("reminders_list_lists", {
  description: "List all reminder lists",
  inputSchema: {},
  outputSchema: {
    lists: z.array(z.object({ name: z.string(), id: z.string(), count: z.number() })),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const lists = await reminders.listReminderLists();
    return ok({ lists });
  } catch (e) { return err(e); }
});

server.registerTool("reminders_get", {
  description: "Get reminders with filtering. Default: incomplete only. Returns pagination metadata.",
  inputSchema: {
    list: z.string().optional().describe("Reminder list name (default: all lists)"),
    filter: z.enum(["all", "incomplete", "completed", "due_today", "overdue", "flagged"]).default("incomplete").describe("Filter: incomplete (default), due_today, overdue, flagged, completed, all"),
    limit: z.number().min(1).max(500).default(50).describe("Max reminders to return"),
    offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
  },
  outputSchema: paginatedOutput(ReminderSummaryZ),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ list, filter, limit, offset }) => {
  try {
    const items = await reminders.getReminders(list, filter, limit, offset);
    return ok(items);
  } catch (e) { return err(e); }
});

server.registerTool("reminders_get_detail", {
  description: "Get full details for a specific reminder",
  inputSchema: {
    reminderId: z.string(),
    list: z.string().describe("Reminder list name"),
  },
  outputSchema: ReminderFullZ.shape,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ reminderId, list }) => {
  try {
    const item = await reminders.getReminder(reminderId, list);
    return ok(item);
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
  outputSchema: SuccessIdZ,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ name, list, dueDate, body, priority, flagged }) => {
  try {
    const result = await reminders.createReminder(name, list, dueDate, body, priority, flagged);
    return ok(result, false);
  } catch (e) { return err(e); }
});

server.registerTool("reminders_complete", {
  description: "Mark a reminder as completed",
  inputSchema: {
    reminderId: z.string(),
    list: z.string(),
  },
  outputSchema: SuccessZ,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ reminderId, list }) => {
  try {
    const result = await reminders.completeReminder(reminderId, list);
    return ok(result, false);
  } catch (e) { return err(e); }
});

server.registerTool("reminders_delete", {
  description: "Delete a reminder",
  inputSchema: {
    reminderId: z.string(),
    list: z.string(),
  },
  outputSchema: SuccessZ,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
}, async ({ reminderId, list }) => {
  try {
    const result = await reminders.deleteReminder(reminderId, list);
    return ok(result, false);
  } catch (e) { return err(e); }
});

// ═══════════════════════════════════════════════════════════════════
// DAILY BRIEFING (convenience tool)
// ═══════════════════════════════════════════════════════════════════

server.registerTool("daily_briefing", {
  description: "Get a complete daily briefing: today's calendar events, due/overdue reminders, and flagged/unread emails. Each email includes a body preview. When presenting the briefing: (1) Group emails by account. (2) Use the preview field to accurately describe each email — never guess from the subject line. (3) Call mail_get_email for any email you want to summarize in detail.",
  inputSchema: {},
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
      flaggedCount: z.number(),
      flagged: z.array(EmailSummaryZ),
      unreadCount: z.number(),
      unread: z.array(EmailSummaryZ),
    }),
    errors: z.array(z.string()).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const empty = { total: 0, count: 0, offset: 0, items: [] as unknown[], has_more: false };
    type WithError = typeof empty & { error?: string };

    const [eventsResult, dueResult, overdueResult, incompleteResult, flaggedResult, unreadResult] =
      await Promise.all([
        calendar.getEventsToday().catch((e: Error) => ({ ...empty, error: e.message })) as Promise<WithError>,
        reminders.getReminders(undefined, "due_today").catch((e: Error) => ({ ...empty, error: e.message })) as Promise<WithError>,
        reminders.getReminders(undefined, "overdue").catch((e: Error) => ({ ...empty, error: e.message })) as Promise<WithError>,
        reminders.getReminders(undefined, "incomplete").catch((e: Error) => ({ ...empty, error: e.message })) as Promise<WithError>,
        mail.getEmails("INBOX", undefined, "flagged", 20).catch((e: Error) => ({ ...empty, error: e.message })) as Promise<WithError>,
        mail.getEmails("INBOX", undefined, "unread", 20).catch((e: Error) => ({ ...empty, error: e.message })) as Promise<WithError>,
      ]);

    // Collect any errors from sub-queries
    const errors: string[] = [];
    for (const [label, result] of [
      ["calendar", eventsResult],
      ["reminders_due", dueResult],
      ["reminders_overdue", overdueResult],
      ["reminders_incomplete", incompleteResult],
      ["mail_flagged", flaggedResult],
      ["mail_unread", unreadResult],
    ] as [string, WithError][]) {
      if (result.error) errors.push(`${label}: ${result.error}`);
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
        flaggedCount: flaggedResult.total,
        flagged: flaggedResult.items,
        unreadCount: unreadResult.total,
        unread: unreadResult.items,
      },
      ...(errors.length > 0 ? { errors } : {}),
    };

    return ok(briefing);
  } catch (e) { return err(e); }
});

// ═══════════════════════════════════════════════════════════════════
// CONTACTS TOOLS
// ═══════════════════════════════════════════════════════════════════

const ContactSummaryZ = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  organization: z.string(),
  jobTitle: z.string(),
  email: z.string(),
  phone: z.string(),
});

const ContactFullZ = ContactSummaryZ.extend({
  middleName: z.string(),
  nickname: z.string(),
  department: z.string(),
  title: z.string(),
  suffix: z.string(),
  birthday: z.string(),
  emails: z.array(z.object({ address: z.string(), label: z.string() })),
  phones: z.array(z.object({ number: z.string(), label: z.string() })),
  addresses: z.array(z.object({
    street: z.string(),
    city: z.string(),
    state: z.string(),
    zip: z.string(),
    country: z.string(),
    label: z.string(),
  })),
  note: z.string(),
});

server.registerTool("contacts_list", {
  description: "List or search contacts from the macOS Address Book. Returns pagination metadata.",
  inputSchema: {
    query: z.string().optional().describe("Search term to filter contacts by name or organization"),
    limit: z.number().min(1).max(500).default(50).describe("Max contacts to return"),
    offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
  },
  outputSchema: paginatedOutput(ContactSummaryZ),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ query, limit, offset }) => {
  try {
    const result = await contacts.listContacts(query, limit, offset);
    return ok(result);
  } catch (e) { return err(e); }
});

server.registerTool("contacts_get", {
  description: "Get full details for a specific contact including all emails, phones, addresses, and notes",
  inputSchema: {
    contactId: z.string().describe("Contact unique ID (from contacts_list or contacts_search)"),
  },
  outputSchema: ContactFullZ.shape,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ contactId }) => {
  try {
    const contact = await contacts.getContact(contactId);
    return ok(contact);
  } catch (e) { return err(e); }
});

server.registerTool("contacts_search", {
  description: "Search contacts by name, email, phone number, or organization",
  inputSchema: {
    query: z.string().describe("Search term"),
    scope: z.enum(["all", "name", "email", "phone", "organization"]).default("all").describe("Where to search: all, name, email, phone, organization"),
    limit: z.number().min(1).max(500).default(20).describe("Max results to return"),
    offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
  },
  outputSchema: paginatedOutput(ContactSummaryZ),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ query, scope, limit, offset }) => {
  try {
    const result = await contacts.searchContacts(query, scope, limit, offset);
    return ok(result);
  } catch (e) { return err(e); }
});

// ═══════════════════════════════════════════════════════════════════
// RESOURCES
// ═══════════════════════════════════════════════════════════════════

/** Wrap a resource handler with error handling. */
function resource(uri: string, fn: () => Promise<unknown>) {
  return async () => {
    try {
      return {
        contents: [{
          uri,
          mimeType: "application/json",
          text: JSON.stringify(await fn(), null, 2),
        }],
      };
    } catch (e) {
      return {
        contents: [{
          uri,
          mimeType: "text/plain",
          text: `Error: ${e instanceof Error ? e.message : String(e)}`,
        }],
      };
    }
  };
}

server.registerResource(
  "mail_accounts",
  "macos://mail/accounts",
  { description: "List of configured email accounts in Apple Mail" },
  resource("macos://mail/accounts", () => mail.listAccounts())
);

server.registerResource(
  "mail_mailboxes",
  new ResourceTemplate("macos://mail/{account}/mailboxes", { list: undefined }),
  { description: "List mailboxes for a specific email account" },
  async (uri, { account }) => {
    try {
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await mail.listMailboxes(account as string), null, 2),
        }],
      };
    } catch (e) {
      return {
        contents: [{
          uri: uri.href,
          mimeType: "text/plain",
          text: `Error: ${e instanceof Error ? e.message : String(e)}`,
        }],
      };
    }
  }
);

server.registerResource(
  "calendars",
  "macos://calendars",
  { description: "List of all calendars (iCloud, Google, Exchange, etc.)" },
  resource("macos://calendars", () => calendar.listCalendars())
);

server.registerResource(
  "reminder_lists",
  "macos://reminders/lists",
  { description: "List of all reminder lists" },
  resource("macos://reminders/lists", () => reminders.listReminderLists())
);

server.registerResource(
  "contacts_list",
  "macos://contacts",
  { description: "Browsable contacts from macOS Address Book (first 25)" },
  resource("macos://contacts", () => contacts.listContacts(undefined, 25, 0))
);

// ═══════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════

/**
 * Auto-build the FTS index on startup.
 * Runs in the background so it doesn't block tool calls.
 * First run indexes up to 10,000 messages; subsequent runs catch up incrementally.
 */
async function autoIndexOnStartup() {
  try {
    const stats = await mailFts.getIndexStats();
    const isFirstRun = stats.indexedCount === 0;
    const batchSize = isFirstRun ? 10_000 : 5_000;

    if (isFirstRun) {
      console.error("[macos-mcp] First run — building FTS email index in background...");
    } else if (stats.totalMessages > stats.indexedCount + stats.lastIndexedRowid * 0) {
      // Always run incremental to catch new messages
      console.error(`[macos-mcp] FTS index: ${stats.indexedCount}/${stats.totalMessages} messages indexed, updating...`);
    }

    const result = await mailFts.indexNewMessages(batchSize);
    if (result.indexed > 0) {
      console.error(`[macos-mcp] FTS index updated: ${result.indexed} new messages indexed`);
    }
  } catch (e) {
    // Non-fatal — FTS is optional, other tools still work
    console.error(`[macos-mcp] FTS auto-index skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Kick off FTS indexing in background after server is ready
  autoIndexOnStartup();
}

main().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});
