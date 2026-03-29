/**
 * Reminders tool and resource registrations for the MCP server.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, err, isoDateString, paginatedOutput, SuccessZ, SuccessIdZ, resource } from "../shared/mcp-helpers.js";
import { isReadOnly } from "../shared/config.js";
import * as reminders from "./tools.js";

// ─── Output Schemas ─────────────────────────────────────────────

export const ReminderSummaryZ = z.object({
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

// ─── Tool Registrations ─────────────────────────────────────────

export function registerRemindersTools(server: McpServer): void {
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
      reminderId: z.string().max(500),
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

  if (!isReadOnly()) {
  server.registerTool("reminders_create", {
    title: "Create Reminder",
    description: "Create a new reminder. Use when: adding a task or to-do item, setting a due-date reminder",
    inputSchema: z.object({
      name: z.string().max(1000, "Name too long").describe("Reminder title"),
      list: z.string().max(200, "Name too long").optional().describe("List name (default: default list)"),
      dueDate: isoDateString.optional().describe("Due date (ISO 8601)"),
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
      reminderId: z.string().max(500),
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
      reminderId: z.string().max(500),
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
  } // end read-only guard
}

// ─── Resource Registrations ─────────────────────────────────────

export function registerRemindersResources(server: McpServer): void {
  server.registerResource(
    "reminder_lists",
    "macos://reminders/lists",
    { description: "List of all reminder lists" },
    resource("macos://reminders/lists", () => reminders.listReminderLists())
  );
}
