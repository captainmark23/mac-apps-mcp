/**
 * Builds the MCP server: every domain's tools and resources, plus the
 * cross-domain daily briefing. Shared by the stdio and HTTP transports.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { sanitizeErrorMessage } from "./shared/types.js";
import { ok, err, normalizeToolSchemaDialect } from "./shared/mcp-helpers.js";
import { registerMailTools, registerMailResources, EmailSummaryZ } from "./mail/register.js";
import { registerCalendarTools, registerCalendarResources, EventSummaryZ } from "./calendar/register.js";
import { registerRemindersTools, registerRemindersResources, ReminderSummaryZ } from "./reminders/register.js";
import { registerContactsTools, registerContactsResources } from "./contacts/register.js";
import { registerNotesTools, registerNotesResources, NoteSummaryZ } from "./notes/register.js";
import { registerMessagesTools, registerMessagesResources, MessageInChatZ } from "./messages/register.js";
import { isMessagesEnabled } from "./shared/config.js";

import * as mail from "./mail/tools.js";
import * as calendar from "./calendar/tools.js";
import * as reminders from "./reminders/tools.js";
import * as notes from "./notes/tools.js";
import * as messages from "./messages/tools.js";

export const SERVER_VERSION = "0.2.0";

/**
 * A fully registered server. `resources: false` leaves out the MCP resources,
 * which the HTTP transport does not expose (they bypass the tool audit log).
 */
export function createServer(opts: { resources?: boolean } = {}): McpServer {
  const server = new McpServer({
    name: "mac-apps-mcp-server",
    version: SERVER_VERSION,
  });

  registerMailTools(server);
  registerCalendarTools(server);
  registerRemindersTools(server);
  registerContactsTools(server);
  registerNotesTools(server);
  if (isMessagesEnabled()) registerMessagesTools(server);

  if (opts.resources !== false) {
    registerMailResources(server);
    registerCalendarResources(server);
    registerRemindersResources(server);
    registerContactsResources(server);
    registerNotesResources(server);
    if (isMessagesEnabled()) registerMessagesResources(server);
  }

  registerDailyBriefing(server);

  // Advertise tool schemas as JSON Schema 2020-12 (the SDK emits draft-07, which
  // strict MCP clients reject at response validation). Must run after all tools
  // are registered and before connecting the transport.
  normalizeToolSchemaDialect(server);
  return server;
}

// ═══════════════════════════════════════════════════════════════════
// DAILY BRIEFING (cross-domain convenience tool)
// ═══════════════════════════════════════════════════════════════════

function registerDailyBriefing(server: McpServer): void {
  server.registerTool("daily_briefing", {
    title: "Daily Briefing",
    description: "Get a complete daily briefing: today's calendar events, due/overdue reminders, flagged/unread emails across all configured mail accounts, recently modified notes, and unread texts. Each email includes a body preview. When presenting the briefing: (1) Group emails by account. (2) Use the preview field to accurately describe each email — never guess from the subject line. (3) Call mail_get_email for any email you want to summarize in detail. Use when: morning review, getting a quick overview of the day",
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
      texts: z.object({
        unreadCount: z.number(),
        unread: z.array(MessageInChatZ),
      }).optional(),
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

      // Texts: unread count and the newest five
      let texts: Awaited<ReturnType<typeof messages.unreadSummary>> | undefined;
      if (isMessagesEnabled()) {
        try {
          texts = await messages.unreadSummary(5);
        } catch (e) {
          errors.push(`texts: ${sanitizeErrorMessage(e instanceof Error ? e.message : String(e))}`);
        }
      }
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
        ...(texts ? { texts } : {}),
        ...(errors.length > 0 ? { errors } : {}),
      };

      return ok(briefing, true, response_format);
    } catch (e) { return err(e); }
  });
}
