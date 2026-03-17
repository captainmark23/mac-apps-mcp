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

import { sanitizeErrorMessage } from "./shared/types.js";

/** Maximum characters for a JSON-stringified response before truncation kicks in. */
const CHARACTER_LIMIT = 25000;

/** Wrap handler with standard error handling. Sanitizes paths from messages. */
function err(error: unknown): { isError: true; content: [{ type: "text"; text: string }] } {
  const raw = error instanceof Error ? error.message : String(error);
  const msg = sanitizeErrorMessage(raw);
  return { isError: true, content: [{ type: "text", text: `Error: ${msg}` }] };
}

/** Convert structured data to human-readable markdown. */
function toMarkdown(data: unknown, indent = 0): string {
  const prefix = "  ".repeat(indent);
  if (data === null || data === undefined) return `${prefix}_none_`;
  if (typeof data === "string") return `${prefix}${data}`;
  if (typeof data === "number" || typeof data === "boolean") return `${prefix}${String(data)}`;
  if (Array.isArray(data)) {
    if (data.length === 0) return `${prefix}_empty list_`;
    return data.map((item, i) => {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const lines = toMarkdown(item, indent + 1);
        return `${prefix}- **Item ${i + 1}**\n${lines}`;
      }
      return `${prefix}- ${typeof item === "object" ? JSON.stringify(item) : String(item)}`;
    }).join("\n");
  }
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return `${prefix}_empty_`;
    return keys.map((key) => {
      const val = obj[key];
      if (typeof val === "object" && val !== null) {
        return `${prefix}**${key}:**\n${toMarkdown(val, indent + 1)}`;
      }
      return `${prefix}**${key}:** ${val === null || val === undefined ? "_none_" : String(val)}`;
    }).join("\n");
  }
  return `${prefix}${String(data)}`;
}

/** Format a successful tool response with structured content. */
function ok(data: object, pretty = true, format?: string) {
  // Markdown format: return plain text without structuredContent
  if (format === "markdown") {
    return {
      content: [{ type: "text" as const, text: toMarkdown(data) }],
    };
  }

  // JSON format (default): check for truncation
  const result = data as Record<string, unknown>;
  let json = JSON.stringify(result, null, pretty ? 2 : undefined);

  if (json.length > CHARACTER_LIMIT && Array.isArray(result.items)) {
    const totalItems = result.items.length;
    let items = [...result.items];

    // Binary search for the right number of items that fits
    while (items.length > 0) {
      const candidate = {
        ...result,
        items,
        truncation_message: `Response truncated. Use pagination (offset/limit) or filters to narrow results. Showing ${items.length} of ${totalItems} items.`,
      };
      const candidateJson = JSON.stringify(candidate, null, pretty ? 2 : undefined);
      if (candidateJson.length <= CHARACTER_LIMIT) {
        return {
          content: [{ type: "text" as const, text: candidateJson }],
          structuredContent: candidate,
        };
      }
      // Remove ~20% of remaining items each iteration
      items = items.slice(0, Math.max(Math.floor(items.length * 0.8), items.length - 1));
    }

    // Fallback: no items fit
    const fallback = {
      ...result,
      items: [],
      truncation_message: `Response truncated. Use pagination (offset/limit) or filters to narrow results. Showing 0 of ${totalItems} items.`,
    };
    const fallbackJson = JSON.stringify(fallback, null, pretty ? 2 : undefined);
    return {
      content: [{ type: "text" as const, text: fallbackJson }],
      structuredContent: fallback,
    };
  }

  return {
    content: [{ type: "text" as const, text: json }],
    structuredContent: result,
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
  title: "List Mail Accounts",
  description: "List all configured email accounts in Apple Mail. Use when: discovering available email accounts, checking account configuration",
  inputSchema: z.object({
    response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
  }).strict(),
  outputSchema: {
    accounts: z.array(z.object({ name: z.string(), id: z.string() })),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ response_format }) => {
  try {
    const accounts = await mail.listAccounts();
    return ok({ accounts }, true, response_format);
  } catch (e) { return err(e); }
});

server.registerTool("mail_list_mailboxes", {
  title: "List Mailboxes",
  description: "List all mailboxes for an email account. Use when: browsing mailbox structure, checking unread counts per folder",
  inputSchema: z.object({
    account: z.string().max(200, "Name too long").optional().describe("Account name (default: first account)"),
    response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
  }).strict(),
  outputSchema: {
    mailboxes: z.array(z.object({ name: z.string(), unreadCount: z.number() })),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ account, response_format }) => {
  try {
    const mailboxes = await mail.listMailboxes(account);
    return ok({ mailboxes }, true, response_format);
  } catch (e) { return err(e); }
});

server.registerTool("mail_get_emails", {
  title: "Get Emails",
  description: "Get emails with optional filtering. Each result includes the account, mailbox, and a body preview (~200 chars). Omit mailbox to search across all mailboxes and accounts. TRIAGE GUIDELINES: (1) Group results by account when presenting to the user. (2) Use the preview field to understand what each email is about — never guess from the subject line alone. (3) For any email you want to describe in detail, call mail_get_email first to read the full body. Returns newest first with pagination metadata. Use when: triaging inbox, reviewing recent messages",
  inputSchema: z.object({
    mailbox: z.string().max(200, "Name too long").optional().describe("Mailbox name (e.g. 'INBOX'). Omit to search all mailboxes across all accounts."),
    account: z.string().max(200, "Name too long").optional().describe("Account name (e.g. 'iCloud'). Omit to search all accounts."),
    filter: z.enum(["all", "unread", "flagged", "today", "this_week"]).default("all").describe("Filter: all, unread, flagged, today, this_week"),
    limit: z.number().min(1).max(500).default(50).describe("Max emails to return"),
    offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
    response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
  }).strict(),
  outputSchema: paginatedOutput(EmailSummaryZ),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ mailbox, account, filter, limit, offset, response_format }) => {
  try {
    const result = await mail.getEmails(mailbox, account, filter, limit, offset);
    return ok(result, true, response_format);
  } catch (e) { return err(e); }
});

server.registerTool("mail_get_email", {
  title: "Get Email Details",
  description: "Get a single email with full content including body text. Reads the email body directly from disk — no need to specify mailbox or account. Returns the account and mailbox the email belongs to. Use when: reading full email content, preparing to reply or forward",
  inputSchema: z.object({
    messageId: z.number().describe("Email ID (from mail_get_emails or mail_search)"),
    response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
  }).strict(),
  outputSchema: EmailFullZ.shape,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ messageId, response_format }) => {
  try {
    const email = await mail.getEmail(messageId);
    return ok(email, true, response_format);
  } catch (e) { return err(e); }
});

server.registerTool("mail_search", {
  title: "Search Emails",
  description: "Search emails by subject and/or sender. Each result includes the account, mailbox, and a body preview (~200 chars). Omit mailbox to search across all mailboxes and accounts. Use the preview field to understand results — never guess content from the subject line alone. Returns pagination metadata. Use when: finding emails by subject, sender, or keyword",
  inputSchema: z.object({
    query: z.string().min(1, "Query must not be empty").max(1000, "Query too long").describe("Search term"),
    scope: z.enum(["all", "subject", "sender"]).default("all").describe("Where to search"),
    mailbox: z.string().max(200, "Name too long").optional().describe("Mailbox name. Omit to search all mailboxes across all accounts."),
    account: z.string().max(200, "Name too long").optional().describe("Account name. Omit to search all accounts."),
    limit: z.number().min(1).max(500).default(20).describe("Max results to return"),
    offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
    response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
  }).strict(),
  outputSchema: paginatedOutput(EmailSummaryZ),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ query, scope, mailbox, account, limit, offset, response_format }) => {
  try {
    const results = await mail.searchMail(query, scope, mailbox, account, limit, offset);
    return ok(results, true, response_format);
  } catch (e) { return err(e); }
});

server.registerTool("mail_send", {
  title: "Send Email",
  description: "Send an email. For important emails, prefer mail_create_draft so the user can review first. Use when: sending a quick reply, automated email dispatch",
  inputSchema: z.object({
    to: z.array(z.string().email("Invalid email address")).min(1, "At least one recipient required").describe("Recipient email addresses"),
    subject: z.string().max(1000, "Query too long").describe("Email subject"),
    body: z.string().max(100000).describe("Email body text"),
    cc: z.array(z.string().email("Invalid email address")).optional().describe("CC addresses"),
    bcc: z.array(z.string().email("Invalid email address")).optional().describe("BCC addresses"),
    account: z.string().max(200, "Name too long").optional(),
  }).strict(),
  outputSchema: SuccessMessageZ,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ to, subject, body, cc, bcc, account }) => {
  try {
    const result = await mail.sendEmail(to, subject, body, cc, bcc, account);
    return ok(result, false);
  } catch (e) { return err(e); }
});

server.registerTool("mail_create_draft", {
  title: "Create Email Draft",
  description: "Create a draft email for user review in Mail.app. Preferred for important emails. Use when: composing an important email that needs review, preparing a message for later",
  inputSchema: z.object({
    to: z.array(z.string().email("Invalid email address")).min(1, "At least one recipient required").describe("Recipient email addresses"),
    subject: z.string().max(1000, "Query too long"),
    body: z.string().max(100000),
    cc: z.array(z.string().email("Invalid email address")).optional(),
    account: z.string().max(200, "Name too long").optional(),
  }).strict(),
  outputSchema: SuccessMessageZ,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ to, subject, body, cc, account }) => {
  try {
    const result = await mail.createDraft(to, subject, body, cc, account);
    return ok(result, false);
  } catch (e) { return err(e); }
});

server.registerTool("mail_reply", {
  title: "Reply to Email",
  description: "Reply to an email. Set send=false to save as draft for review. Use when: responding to a conversation, following up on a thread",
  inputSchema: z.object({
    messageId: z.number().describe("Email ID to reply to"),
    body: z.string().max(100000).describe("Reply body"),
    replyAll: z.boolean().default(false),
    send: z.boolean().default(true).describe("Send immediately or save as draft"),
    mailbox: z.string().max(200, "Name too long").default("INBOX"),
    account: z.string().max(200, "Name too long").optional(),
  }).strict(),
  outputSchema: SuccessMessageZ,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ messageId, body, replyAll, send, mailbox, account }) => {
  try {
    const result = await mail.replyTo(messageId, body, replyAll, send, mailbox, account);
    return ok(result, false);
  } catch (e) { return err(e); }
});

server.registerTool("mail_forward", {
  title: "Forward Email",
  description: "Forward an email. Set send=false to save as draft for review. Use when: sharing an email with someone else, delegating a message",
  inputSchema: z.object({
    messageId: z.number().describe("Email ID to forward"),
    to: z.array(z.string().email("Invalid email address")).min(1, "At least one recipient required").describe("Forward to these addresses"),
    body: z.string().max(100000).optional().describe("Message to prepend"),
    send: z.boolean().default(true),
    mailbox: z.string().max(200, "Name too long").default("INBOX"),
    account: z.string().max(200, "Name too long").optional(),
  }).strict(),
  outputSchema: SuccessMessageZ,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ messageId, to, body, send, mailbox, account }) => {
  try {
    const result = await mail.forwardMessage(messageId, to, body, send, mailbox, account);
    return ok(result, false);
  } catch (e) { return err(e); }
});

server.registerTool("mail_move", {
  title: "Move Email",
  description: "Move an email to a different mailbox. Use when: organizing emails into folders, archiving messages",
  inputSchema: z.object({
    messageId: z.number(),
    targetMailbox: z.string().max(200, "Name too long").describe("Destination mailbox name"),
    sourceMailbox: z.string().max(200, "Name too long").default("INBOX"),
    account: z.string().max(200, "Name too long").optional(),
  }).strict(),
  outputSchema: SuccessZ,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ messageId, targetMailbox, sourceMailbox, account }) => {
  try {
    const result = await mail.moveMessage(messageId, targetMailbox, sourceMailbox, account);
    return ok(result, false);
  } catch (e) { return err(e); }
});

server.registerTool("mail_set_flags", {
  title: "Set Email Flags",
  description: "Set flagged and/or read status on an email. Use when: marking emails as read/unread, flagging important messages",
  inputSchema: z.object({
    messageId: z.number(),
    flagged: z.boolean().optional().describe("Set flagged status"),
    read: z.boolean().optional().describe("Set read status"),
    mailbox: z.string().max(200, "Name too long").default("INBOX"),
    account: z.string().max(200, "Name too long").optional(),
  }).strict(),
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
  title: "Search Email Bodies",
  description: "Search email body content using full-text search. Searches inside the actual email text, not just subject/sender. Requires the FTS index to be built first (use mail_fts_index). Returns pagination metadata. Use when: searching for specific content within emails, finding messages mentioning a topic",
  inputSchema: z.object({
    query: z.string().min(1, "Query must not be empty").max(1000, "Query too long").describe("Search term(s) to find in email bodies"),
    mailbox: z.string().max(200, "Name too long").default("INBOX"),
    account: z.string().max(200, "Name too long").optional(),
    limit: z.number().min(1).max(500).default(20).describe("Max results to return"),
    offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
    response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
  }).strict(),
  outputSchema: paginatedOutput(FtsResultZ),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ query, mailbox, account, limit, offset, response_format }) => {
  try {
    const results = await mailFts.searchBody(query, mailbox, account, limit, offset);
    return ok(results, true, response_format);
  } catch (e) { return err(e); }
});

server.registerTool("mail_fts_index", {
  title: "Build FTS Index",
  description: "Build or update the full-text search index for email bodies. Run with rebuild=true for a full re-index, or rebuild=false (default) for incremental updates. Use when: preparing for body search, updating search index after new emails",
  inputSchema: z.object({
    rebuild: z.boolean().default(false).describe("Full rebuild (true) or incremental update (false)"),
    limit: z.number().min(1).max(50000).default(5000).describe("Max messages to process per batch"),
  }).strict(),
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
  title: "FTS Index Statistics",
  description: "Get statistics about the full-text search index: how many messages are indexed, total messages, index size. Use when: checking if FTS index is up to date, diagnosing search issues",
  inputSchema: z.object({
    response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
  }).strict(),
  outputSchema: {
    indexedCount: z.number(),
    totalMessages: z.number(),
    lastIndexedRowid: z.number(),
    dbSizeMb: z.number(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ response_format }) => {
  try {
    const stats = await mailFts.getIndexStats();
    return ok(stats, true, response_format);
  } catch (e) { return err(e); }
});

// ═══════════════════════════════════════════════════════════════════
// CALENDAR TOOLS
// ═══════════════════════════════════════════════════════════════════

server.registerTool("calendar_list", {
  title: "List Calendars",
  description: "List all calendars (iCloud, Google, Exchange, etc.). Use when: discovering available calendars, checking which calendars are configured",
  inputSchema: z.object({
    response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
  }).strict(),
  outputSchema: {
    calendars: z.array(z.object({
      name: z.string(),
      id: z.string(),
      writable: z.boolean(),
      color: z.string(),
    })),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ response_format }) => {
  try {
    const calendars = await calendar.listCalendars();
    return ok({ calendars }, true, response_format);
  } catch (e) { return err(e); }
});

server.registerTool("calendar_today", {
  title: "Today's Events",
  description: "Get all events for today. Returns pagination metadata. Use when: checking today's schedule, daily planning",
  inputSchema: z.object({
    calendar: z.string().max(200, "Name too long").optional().describe("Calendar name (default: all calendars)"),
    limit: z.number().min(1).max(500).default(200).describe("Max events to return"),
    offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
    response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
  }).strict(),
  outputSchema: paginatedOutput(EventSummaryZ),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ calendar: cal, limit, offset, response_format }) => {
  try {
    const events = await calendar.getEventsToday(cal, limit, offset);
    return ok(events, true, response_format);
  } catch (e) { return err(e); }
});

server.registerTool("calendar_this_week", {
  title: "This Week's Events",
  description: "Get all events for the next 7 days. Returns pagination metadata. Use when: weekly planning, checking upcoming schedule",
  inputSchema: z.object({
    calendar: z.string().max(200, "Name too long").optional(),
    limit: z.number().min(1).max(500).default(200).describe("Max events to return"),
    offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
    response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
  }).strict(),
  outputSchema: paginatedOutput(EventSummaryZ),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ calendar: cal, limit, offset, response_format }) => {
  try {
    const events = await calendar.getEventsThisWeek(cal, limit, offset);
    return ok(events, true, response_format);
  } catch (e) { return err(e); }
});

server.registerTool("calendar_get_events", {
  title: "Get Events by Date Range",
  description: "Get events in a date range. Dates should be ISO 8601 format (e.g. 2026-03-08). Returns pagination metadata. Use when: looking up events in a date range, checking availability for a period",
  inputSchema: z.object({
    startDate: z.string().describe("Start date (ISO 8601, e.g. 2026-03-08)"),
    endDate: z.string().describe("End date (ISO 8601)"),
    calendar: z.string().max(200, "Name too long").optional(),
    limit: z.number().min(1).max(500).default(200).describe("Max events to return"),
    offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
    response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
  }).strict(),
  outputSchema: paginatedOutput(EventSummaryZ),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ startDate, endDate, calendar: cal, limit, offset, response_format }) => {
  try {
    const events = await calendar.getEvents(startDate, endDate, cal, limit, offset);
    return ok(events, true, response_format);
  } catch (e) { return err(e); }
});

server.registerTool("calendar_get_event", {
  title: "Get Event Details",
  description: "Get full details for a specific event including attendees. Use when: viewing event details, checking attendee list or event description",
  inputSchema: z.object({
    eventId: z.string().describe("Event ID (from calendar_today etc.)"),
    calendar: z.string().max(200, "Name too long").describe("Calendar name the event belongs to"),
    response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
  }).strict(),
  outputSchema: EventFullZ.shape,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ eventId, calendar: cal, response_format }) => {
  try {
    const event = await calendar.getEvent(eventId, cal);
    return ok(event, true, response_format);
  } catch (e) { return err(e); }
});

server.registerTool("calendar_create_event", {
  title: "Create Calendar Event",
  description: "Create a new calendar event. Use when: scheduling a meeting, adding an event to the calendar",
  inputSchema: z.object({
    summary: z.string().max(1000, "Query too long").describe("Event title"),
    startDate: z.string().describe("Start date/time (ISO 8601)"),
    endDate: z.string().describe("End date/time (ISO 8601)"),
    calendar: z.string().max(200, "Name too long").optional().describe("Calendar name (default: first calendar)"),
    location: z.string().max(1000).optional(),
    description: z.string().max(1000).optional(),
    allDay: z.boolean().default(false),
  }).strict(),
  outputSchema: SuccessIdZ,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ summary, startDate, endDate, calendar: cal, location, description, allDay }) => {
  try {
    const result = await calendar.createEvent(summary, startDate, endDate, cal, location, description, allDay);
    return ok(result, false);
  } catch (e) { return err(e); }
});

server.registerTool("calendar_modify_event", {
  title: "Modify Calendar Event",
  description: "Modify an existing calendar event. You can update the title (summary), start/end dates, location, and/or description. Only include the fields you want to change. Use when: rescheduling a meeting, updating event details",
  inputSchema: z.object({
    eventId: z.string(),
    calendar: z.string().max(200, "Name too long"),
    summary: z.string().max(1000, "Query too long").optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    location: z.string().max(1000).optional(),
    description: z.string().max(1000).optional(),
  }).strict(),
  outputSchema: SuccessZ,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ eventId, calendar: cal, ...updates }) => {
  try {
    const result = await calendar.modifyEvent(eventId, cal, updates);
    return ok(result, false);
  } catch (e) { return err(e); }
});

server.registerTool("calendar_delete_event", {
  title: "Delete Calendar Event",
  description: "Delete a calendar event. Use when: cancelling a meeting, removing an event from the calendar",
  inputSchema: z.object({
    eventId: z.string(),
    calendar: z.string().max(200, "Name too long"),
  }).strict(),
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
  title: "List Reminder Lists",
  description: "List all reminder lists. Use when: discovering available reminder lists, checking list names before creating reminders",
  inputSchema: z.object({
    response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
  }).strict(),
  outputSchema: {
    lists: z.array(z.object({ name: z.string(), id: z.string(), count: z.number() })),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ response_format }) => {
  try {
    const lists = await reminders.listReminderLists();
    return ok({ lists }, true, response_format);
  } catch (e) { return err(e); }
});

server.registerTool("reminders_get", {
  title: "Get Reminders",
  description: "Get reminders with filtering. Default: incomplete only. Returns pagination metadata. Use when: checking tasks for a specific list, reviewing to-dos",
  inputSchema: z.object({
    list: z.string().max(200, "Name too long").optional().describe("Reminder list name (default: all lists)"),
    filter: z.enum(["all", "incomplete", "completed", "due_today", "overdue", "flagged"]).default("incomplete").describe("Filter: incomplete (default), due_today, overdue, flagged, completed, all"),
    limit: z.number().min(1).max(500).default(50).describe("Max reminders to return"),
    offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
    response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
  }).strict(),
  outputSchema: paginatedOutput(ReminderSummaryZ),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ list, filter, limit, offset, response_format }) => {
  try {
    const items = await reminders.getReminders(list, filter, limit, offset);
    return ok(items, true, response_format);
  } catch (e) { return err(e); }
});

server.registerTool("reminders_get_detail", {
  title: "Get Reminder Details",
  description: "Get full details for a specific reminder. Use when: viewing reminder notes, checking reminder metadata",
  inputSchema: z.object({
    reminderId: z.string(),
    list: z.string().max(200, "Name too long").describe("Reminder list name"),
    response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
  }).strict(),
  outputSchema: ReminderFullZ.shape,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ reminderId, list, response_format }) => {
  try {
    const item = await reminders.getReminder(reminderId, list);
    return ok(item, true, response_format);
  } catch (e) { return err(e); }
});

server.registerTool("reminders_create", {
  title: "Create Reminder",
  description: "Create a new reminder. Use when: adding a task or to-do item, setting a due-date reminder",
  inputSchema: z.object({
    name: z.string().max(1000, "Query too long").describe("Reminder title"),
    list: z.string().max(200, "Name too long").optional().describe("List name (default: default list)"),
    dueDate: z.string().optional().describe("Due date (ISO 8601)"),
    body: z.string().max(10000).optional().describe("Notes/description"),
    priority: z.number().min(0).max(9).optional().describe("Priority: 0=none, 1=high, 5=medium, 9=low"),
    flagged: z.boolean().optional(),
  }).strict(),
  outputSchema: SuccessIdZ,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ name, list, dueDate, body, priority, flagged }) => {
  try {
    const result = await reminders.createReminder(name, list, dueDate, body, priority, flagged);
    return ok(result, false);
  } catch (e) { return err(e); }
});

server.registerTool("reminders_complete", {
  title: "Complete Reminder",
  description: "Mark a reminder as completed. Use when: finishing a task, checking off a to-do",
  inputSchema: z.object({
    reminderId: z.string(),
    list: z.string().max(200, "Name too long"),
  }).strict(),
  outputSchema: SuccessZ,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ reminderId, list }) => {
  try {
    const result = await reminders.completeReminder(reminderId, list);
    return ok(result, false);
  } catch (e) { return err(e); }
});

server.registerTool("reminders_delete", {
  title: "Delete Reminder",
  description: "Delete a reminder. Use when: removing a task that is no longer needed",
  inputSchema: z.object({
    reminderId: z.string(),
    list: z.string().max(200, "Name too long"),
  }).strict(),
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
  title: "Daily Briefing",
  description: "Get a complete daily briefing: today's calendar events, due/overdue reminders, and flagged/unread emails. Each email includes a body preview. When presenting the briefing: (1) Group emails by account. (2) Use the preview field to accurately describe each email — never guess from the subject line. (3) Call mail_get_email for any email you want to summarize in detail. Use when: morning review, getting a quick overview of the day",
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
      flaggedCount: z.number(),
      flagged: z.array(EmailSummaryZ),
      unreadCount: z.number(),
      unread: z.array(EmailSummaryZ),
    }),
    errors: z.array(z.string()).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ response_format }) => {
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

    return ok(briefing, true, response_format);
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
  title: "List Contacts",
  description: "Browse contacts alphabetically with pagination. Use when: browsing the address book, listing contacts without a specific search term",
  inputSchema: z.object({
    query: z.string().max(1000, "Query too long").optional().describe("Search term to filter contacts by name or organization"),
    limit: z.number().min(1).max(500).default(50).describe("Max contacts to return"),
    offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
    response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
  }).strict(),
  outputSchema: paginatedOutput(ContactSummaryZ),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ query, limit, offset, response_format }) => {
  try {
    const result = await contacts.listContacts(query, limit, offset);
    return ok(result, true, response_format);
  } catch (e) { return err(e); }
});

server.registerTool("contacts_get", {
  title: "Get Contact Details",
  description: "Get full details for a specific contact including all emails, phones, addresses, and notes. Use when: viewing complete contact information, getting phone numbers or addresses",
  inputSchema: z.object({
    contactId: z.string().describe("Contact unique ID (from contacts_list or contacts_search)"),
    response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
  }).strict(),
  outputSchema: ContactFullZ.shape,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ contactId, response_format }) => {
  try {
    const contact = await contacts.getContact(contactId);
    return ok(contact, true, response_format);
  } catch (e) { return err(e); }
});

server.registerTool("contacts_search", {
  title: "Search Contacts",
  description: "Search contacts by name, email, phone number, or organization. Use when: finding a specific person's contact details by name or email",
  inputSchema: z.object({
    query: z.string().min(1, "Query must not be empty").max(1000, "Query too long").describe("Search term"),
    scope: z.enum(["all", "name", "email", "phone", "organization"]).default("all").describe("Where to search: all, name, email, phone, organization"),
    limit: z.number().min(1).max(500).default(20).describe("Max results to return"),
    offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
    response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
  }).strict(),
  outputSchema: paginatedOutput(ContactSummaryZ),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ query, scope, limit, offset, response_format }) => {
  try {
    const result = await contacts.searchContacts(query, scope, limit, offset);
    return ok(result, true, response_format);
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
          text: `Error: ${sanitizeErrorMessage(e instanceof Error ? e.message : String(e))}`,
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
          text: `Error: ${sanitizeErrorMessage(e instanceof Error ? e.message : String(e))}`,
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
 * First run indexes the entire mailbox; subsequent runs catch up incrementally.
 */
async function autoIndexOnStartup() {
  try {
    const stats = await mailFts.getIndexStats();
    const isFirstRun = stats.indexedCount === 0;

    if (isFirstRun) {
      console.error(`[macos-mcp] First run — building FTS index for ${stats.totalMessages} messages in background...`);
      const result = await mailFts.rebuildIndex(5_000);
      console.error(`[macos-mcp] FTS index built: ${result.indexed} messages indexed, ${result.skipped} skipped`);
    } else {
      const result = await mailFts.indexNewMessages(50_000);
      if (result.indexed > 0) {
        console.error(`[macos-mcp] FTS index updated: ${result.indexed} new messages indexed`);
      }
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
