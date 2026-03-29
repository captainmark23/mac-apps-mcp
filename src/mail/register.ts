/**
 * Mail tool and resource registrations for the MCP server.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, err, paginatedOutput, SuccessZ, SuccessMessageZ, resource } from "../shared/mcp-helpers.js";
import { sanitizeErrorMessage } from "../shared/types.js";
import { isReadOnly } from "../shared/config.js";
import * as mail from "./tools.js";
import * as mailFts from "./fts.js";

// ─── Output Schemas ─────────────────────────────────────────────

export const EmailSummaryZ = z.object({
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

const AttachmentMetaZ = z.object({
  filename: z.string(),
  mimeType: z.string(),
  size: z.number().describe("Size in bytes (may be approximate for MIME-parsed attachments)"),
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
  preview: z.string(),
  attachments: z.array(AttachmentMetaZ).describe("Attachment metadata (filename, type, size). Content not included — metadata only."),
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

// ─── Tool Registrations ─────────────────────────────────────────

export function registerMailTools(server: McpServer): void {
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

  if (!isReadOnly()) {
  server.registerTool("mail_send", {
    title: "Send Email",
    description: "Send an email. Supports HTML formatting via htmlBody for rich text (bold, italic, links, tables, etc). For important emails, prefer mail_create_draft so the user can review first. Use when: sending a quick reply, automated email dispatch",
    inputSchema: z.object({
      to: z.array(z.string().email("Invalid email address")).min(1, "At least one recipient required").describe("Recipient email addresses"),
      subject: z.string().max(1000, "Subject too long").describe("Email subject"),
      body: z.string().max(100000).describe("Plain text body (also used as fallback for email clients that don't support HTML)"),
      htmlBody: z.string().max(200000).optional().describe("HTML body for rich text formatting. When provided, the email is sent as HTML with the plain text body as fallback."),
      cc: z.array(z.string().email("Invalid email address")).optional().describe("CC addresses"),
      bcc: z.array(z.string().email("Invalid email address")).optional().describe("BCC addresses"),
      account: z.string().max(200, "Name too long").optional(),
    }).strict(),
    outputSchema: SuccessMessageZ,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ to, subject, body, htmlBody, cc, bcc, account }) => {
    try {
      const result = await mail.sendEmail(to, subject, body, cc, bcc, account, htmlBody);
      return ok(result, false);
    } catch (e) { return err(e); }
  });

  server.registerTool("mail_create_draft", {
    title: "Create Email Draft",
    description: "Create a plain text draft email for user review in Mail.app. Preferred for important emails. Note: HTML drafts are not supported — use mail_send for HTML emails. Use when: composing an important email that needs review, preparing a message for later",
    inputSchema: z.object({
      to: z.array(z.string().email("Invalid email address")).min(1, "At least one recipient required").describe("Recipient email addresses"),
      subject: z.string().max(1000, "Subject too long"),
      body: z.string().max(100000).describe("Plain text body"),
      htmlBody: z.string().max(200000).optional().describe("HTML body for rich text formatting. NOTE: HTML drafts are NOT supported — an error will be returned. Use mail_send for HTML emails."),
      cc: z.array(z.string().email("Invalid email address")).optional(),
      account: z.string().max(200, "Name too long").optional(),
    }).strict(),
    outputSchema: SuccessMessageZ,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ to, subject, body, htmlBody, cc, account }) => {
    try {
      const result = await mail.createDraft(to, subject, body, cc, account, htmlBody);
      return ok(result, false);
    } catch (e) { return err(e); }
  });

  server.registerTool("mail_reply", {
    title: "Reply to Email",
    description: "Reply to an email (plain text only). Set send=false to save as draft for review. Use when: responding to a conversation, following up on a thread",
    inputSchema: z.object({
      messageId: z.number().describe("Email ID to reply to"),
      body: z.string().max(100000).describe("Plain text reply body"),
      replyAll: z.boolean().default(false),
      send: z.boolean().default(true).describe("Send immediately or save as draft"),
      mailbox: z.string().max(200, "Name too long").optional().describe("Mailbox name. If omitted, auto-resolved from the message ID."),
      account: z.string().max(200, "Name too long").optional().describe("Account name. If omitted, auto-resolved from the message ID."),
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
    description: "Forward an email (plain text only). Set send=false to save as draft for review. Mailbox and account are auto-resolved from the message ID if not provided. Use when: sharing an email with someone else, delegating a message",
    inputSchema: z.object({
      messageId: z.number().describe("Email ID to forward"),
      to: z.array(z.string().email("Invalid email address")).min(1, "At least one recipient required").describe("Forward to these addresses"),
      body: z.string().max(100000).optional().describe("Plain text message to prepend"),
      send: z.boolean().default(true),
      mailbox: z.string().max(200, "Name too long").optional().describe("Mailbox name. If omitted, auto-resolved from the message ID."),
      account: z.string().max(200, "Name too long").optional().describe("Account name. If omitted, auto-resolved from the message ID."),
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
    description: "Move an email to a different mailbox. Source mailbox and account are auto-resolved from the message ID if not provided. Use when: organizing emails into folders, archiving messages",
    inputSchema: z.object({
      messageId: z.number(),
      targetMailbox: z.string().max(200, "Name too long").describe("Destination mailbox name"),
      sourceMailbox: z.string().max(200, "Name too long").optional().describe("Source mailbox name. If omitted, auto-resolved from the message ID."),
      account: z.string().max(200, "Name too long").optional().describe("Account name. If omitted, auto-resolved from the message ID."),
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
    description: "Set flagged and/or read status on an email. Mailbox and account are auto-resolved from the message ID if not provided. Use when: marking emails as read/unread, flagging important messages",
    inputSchema: z.object({
      messageId: z.number(),
      flagged: z.boolean().optional().describe("Set flagged status"),
      read: z.boolean().optional().describe("Set read status"),
      mailbox: z.string().max(200, "Name too long").optional().describe("Mailbox name. If omitted, auto-resolved from the message ID."),
      account: z.string().max(200, "Name too long").optional().describe("Account name. If omitted, auto-resolved from the message ID."),
    }).strict(),
    outputSchema: SuccessZ,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ messageId, flagged, read, mailbox, account }) => {
    try {
      const result = await mail.setMessageFlags(messageId, flagged, read, mailbox, account);
      return ok(result, false);
    } catch (e) { return err(e); }
  });
  } // end read-only guard

  // ─── FTS Tools ──────────────────────────────────────────────────

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
}

// ─── Resource Registrations ─────────────────────────────────────

export function registerMailResources(server: McpServer): void {
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
            text: JSON.stringify(await mail.listMailboxes(typeof account === "string" ? account : String(account)), null, 2),
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
}
