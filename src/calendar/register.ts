/**
 * Calendar tool and resource registrations for the MCP server.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, err, isoDateString, paginatedOutput, SuccessZ, SuccessIdZ, resource } from "../shared/mcp-helpers.js";
import * as calendar from "./tools.js";

// ─── Output Schemas ─────────────────────────────────────────────

export const EventSummaryZ = z.object({
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

// ─── Tool Registrations ─────────────────────────────────────────

export function registerCalendarTools(server: McpServer): void {
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
      const events = await calendar.getEventsNext7Days(cal, limit, offset);
      return ok(events, true, response_format);
    } catch (e) { return err(e); }
  });

  server.registerTool("calendar_get_events", {
    title: "Get Events by Date Range",
    description: "Get events in a date range. Dates should be ISO 8601 format (e.g. 2026-03-08). Returns pagination metadata. Use when: looking up events in a date range, checking availability for a period",
    inputSchema: z.object({
      startDate: isoDateString.describe("Start date (ISO 8601, e.g. 2026-03-08)"),
      endDate: isoDateString.describe("End date (ISO 8601)"),
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
      eventId: z.string().max(500).describe("Event ID (from calendar_today etc.)"),
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
      summary: z.string().max(1000, "Title too long").describe("Event title"),
      startDate: isoDateString.describe("Start date/time (ISO 8601)"),
      endDate: isoDateString.describe("End date/time (ISO 8601)"),
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
      eventId: z.string().max(500),
      calendar: z.string().max(200, "Name too long"),
      summary: z.string().max(1000, "Title too long").optional(),
      startDate: isoDateString.optional(),
      endDate: isoDateString.optional(),
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
      eventId: z.string().max(500),
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
}

// ─── Resource Registrations ─────────────────────────────────────

export function registerCalendarResources(server: McpServer): void {
  server.registerResource(
    "calendars",
    "macos://calendars",
    { description: "List of all calendars (iCloud, Google, Exchange, etc.)" },
    resource("macos://calendars", () => calendar.listCalendars())
  );
}
