/**
 * Apple Calendar MCP tools.
 *
 * Read operations query the Calendar SQLite database directly for instant
 * results (vs ~2 minutes per calendar via AppleScript/JXA).
 * Write operations still use JXA since the database is read-only.
 *
 * Provides: list_calendars, get_events, get_events_today, get_events_this_week,
 * get_event, create_event, modify_event, delete_event
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { executeJxa, executeJxaWrite, jxaString } from "../shared/applescript.js";
import { sqliteQuery, sqlEscape, safeInt } from "../shared/sqlite.js";
import { getCalendarNames } from "../shared/config.js";
import { PaginatedResult, paginateArray, CORE_DATA_EPOCH_OFFSET, SECONDS_PER_DAY, fromCoreDataTimestamp } from "../shared/types.js";

/** Milliseconds in one day. Used for date arithmetic. */
const MS_PER_DAY = 86_400_000;

/** Maximum rows to fetch from OccurrenceCache before post-filtering. */
const MAX_OCCURRENCE_QUERY_ROWS = 2000;

/**
 * macOS stores Calendar data in a SQLite database.
 * Dates use Core Data epoch (2001-01-01) — offset from Unix epoch by 978307200 seconds.
 *
 * OccurrenceCache.occurrence_start_date is often NULL. To get the actual
 * occurrence start, we compute: occurrence_end_date - (ci.end_date - ci.start_date).
 * For all-day events, the start is the `day` column value.
 */
const CALENDAR_DB = join(
  homedir(),
  "Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb"
);

/**
 * Common SQL fragment for selecting events from OccurrenceCache.
 * Computes actual start time from end time minus event duration.
 */
const EVENT_SELECT = `
  SELECT ci.UUID, ci.summary, ci.all_day, ci.status,
    CASE
      WHEN ci.all_day = 1 THEN oc.day
      ELSE oc.occurrence_end_date - (ci.end_date - ci.start_date)
    END as computed_start,
    oc.occurrence_end_date,
    c.title as calendar_name,
    COALESCE((SELECT l.title FROM Location l WHERE l.ROWID = ci.location_id), '') as location
  FROM OccurrenceCache oc
  JOIN CalendarItem ci ON oc.event_id = ci.ROWID
  JOIN Calendar c ON oc.calendar_id = c.ROWID`;

// ─── Types ───────────────────────────────────────────────────────

export interface CalendarInfo {
  name: string;
  id: string;
  writable: boolean;
  color: string;
}

export interface EventSummary {
  id: string;
  summary: string;
  startDate: string;
  endDate: string;
  location: string;
  allDay: boolean;
  calendar: string;
  status: string;
}

export interface EventFull extends EventSummary {
  description: string;
  url: string;
  recurrence: string;
  attendees: { name: string; email: string; status: string }[];
}

// PaginatedResult<T> imported from shared/types.ts
export type { PaginatedResult } from "../shared/types.js";

// ─── Helpers ────────────────────────────────────────────────────

/** Build a SQL WHERE clause to filter by configured calendar names. */
function calendarWhereClause(calendar?: string): string {
  if (calendar) {
    return `AND c.title = '${sqlEscape(calendar)}'`;
  }
  const configured = getCalendarNames();
  if (configured) {
    const names = configured.map((n) => `'${sqlEscape(n)}'`).join(", ");
    return `AND c.title IN (${names})`;
  }
  return "";
}

/** Convert a JS Date or ISO string to Core Data timestamp. Throws on invalid dates. */
export function toCoreDataTimestamp(dateStr: string): number {
  const ms = new Date(dateStr).getTime();
  if (isNaN(ms)) {
    throw new Error(`Invalid date string: "${dateStr}". Use ISO 8601 format (e.g., '2024-01-15').`);
  }
  return Math.floor(ms / 1000) - CORE_DATA_EPOCH_OFFSET;
}

/** Map numeric status to human-readable string. */
export function statusLabel(status: string | null): string {
  switch (status) {
    case "0": return "none";
    case "1": return "confirmed";
    case "2": return "tentative";
    case "3": return "cancelled";
    default: return "none";
  }
}

/** Map participant status to human-readable string. */
export function participantStatusLabel(status: string | null): string {
  switch (status) {
    case "0": return "unknown";
    case "1": return "pending";
    case "2": return "accepted";
    case "3": return "declined";
    case "4": return "tentative";
    default: return "unknown";
  }
}

/** Map a SQLite row to an EventSummary. */
export function rowToEventSummary(r: Record<string, string | number | null>): EventSummary {
  return {
    id: String(r.UUID || ""),
    summary: String(r.summary || ""),
    startDate: fromCoreDataTimestamp(r.computed_start),
    endDate: fromCoreDataTimestamp(r.occurrence_end_date),
    location: String(r.location || ""),
    allDay: r.all_day === 1 || r.all_day === "1",
    calendar: String(r.calendar_name || ""),
    status: statusLabel(String(r.status ?? "")),
  };
}

// ─── Read Tools (SQLite — instant) ──────────────────────────────

export async function listCalendars(): Promise<CalendarInfo[]> {
  const rows = await sqliteQuery(
    CALENDAR_DB,
    `SELECT ROWID, title, color, symbolic_color_name, flags
     FROM Calendar
     WHERE title IS NOT NULL AND title != ''
     ORDER BY title;`
  );

  return rows.map((r) => ({
    name: String(r.title || ""),
    id: String(r.title || ""),
    writable: (Number(r.flags) & 1) === 0,
    color: String(r.symbolic_color_name || r.color || ""),
  }));
}

export async function getEvents(
  startDate: string,
  endDate: string,
  calendar?: string,
  limit = 200,
  offset = 0
): Promise<PaginatedResult<EventSummary>> {
  const startTs = toCoreDataTimestamp(startDate);
  const endTs = toCoreDataTimestamp(endDate);
  const calFilter = calendarWhereClause(calendar);

  const rows = await sqliteQuery(
    CALENDAR_DB,
    `${EVENT_SELECT}
     WHERE oc.day >= ${safeInt(startTs)} - ${SECONDS_PER_DAY}
       AND oc.day < ${safeInt(endTs)}
       ${calFilter}
     ORDER BY computed_start
     LIMIT ${MAX_OCCURRENCE_QUERY_ROWS};`
  );

  // Post-filter for precise range (day column is date-granularity)
  const allItems = rows
    .map(rowToEventSummary)
    .filter((e) => {
      const start = new Date(e.startDate).getTime();
      const sMs = new Date(startDate).getTime();
      const eMs = new Date(endDate).getTime();
      return start >= sMs && start < eMs;
    });

  return paginateArray(allItems, offset, limit);
}

export async function getEventsToday(
  calendar?: string,
  limit = 200,
  offset = 0
): Promise<PaginatedResult<EventSummary>> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay.getTime() + MS_PER_DAY);
  return getEvents(startOfDay.toISOString(), endOfDay.toISOString(), calendar, limit, offset);
}

export async function getEventsNext7Days(
  calendar?: string,
  limit = 200,
  offset = 0
): Promise<PaginatedResult<EventSummary>> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfWeek = new Date(startOfDay.getTime() + 7 * MS_PER_DAY);
  return getEvents(startOfDay.toISOString(), endOfWeek.toISOString(), calendar, limit, offset);
}

export async function getEvent(
  eventId: string,
  calendar: string
): Promise<EventFull> {
  const rows = await sqliteQuery(
    CALENDAR_DB,
    `SELECT ci.ROWID as item_rowid, ci.UUID, ci.summary, ci.all_day, ci.status,
       ci.start_date, ci.end_date, ci.description, ci.url, ci.has_recurrences,
       c.title as calendar_name,
       COALESCE((SELECT l.title FROM Location l WHERE l.ROWID = ci.location_id), '') as location,
       (SELECT CASE
         WHEN ci.all_day = 1 THEN oc2.day
         ELSE oc2.occurrence_end_date - (ci.end_date - ci.start_date)
       END FROM OccurrenceCache oc2
       WHERE oc2.event_id = ci.ROWID ORDER BY oc2.occurrence_end_date DESC LIMIT 1) as latest_start,
       (SELECT oc2.occurrence_end_date FROM OccurrenceCache oc2
       WHERE oc2.event_id = ci.ROWID ORDER BY oc2.occurrence_end_date DESC LIMIT 1) as latest_end
     FROM CalendarItem ci
     JOIN Calendar c ON ci.calendar_id = c.ROWID
     WHERE ci.UUID = '${sqlEscape(eventId)}'
       AND c.title = '${sqlEscape(calendar)}'
     LIMIT 1;`
  );

  if (!rows.length) throw new Error("Event not found");
  const r = rows[0];

  // Fetch attendees
  const attendeeRows = await sqliteQuery(
    CALENDAR_DB,
    `SELECT p.status, p.email,
       COALESCE(i.display_name, i.first_name || ' ' || i.last_name, '') as name
     FROM Participant p
     LEFT JOIN Identity i ON p.identity_id = i.ROWID
     WHERE p.owner_id = ${safeInt(r.item_rowid)};`
  );

  // Fetch recurrence info if applicable
  let recurrence = "";
  if (r.has_recurrences === 1 || r.has_recurrences === "1") {
    const recRows = await sqliteQuery(
      CALENDAR_DB,
      `SELECT * FROM Recurrence WHERE owner_id = ${safeInt(r.item_rowid)} LIMIT 1;`
    );
    if (recRows.length) {
      recurrence = "recurring";
    }
  }

  // Use occurrence dates if available (for recurring events), fall back to series dates
  const startDate = r.latest_start != null
    ? fromCoreDataTimestamp(r.latest_start)
    : fromCoreDataTimestamp(r.start_date);
  const endDate = r.latest_end != null
    ? fromCoreDataTimestamp(r.latest_end)
    : fromCoreDataTimestamp(r.end_date);

  return {
    id: String(r.UUID || ""),
    summary: String(r.summary || ""),
    startDate,
    endDate,
    location: String(r.location || ""),
    allDay: r.all_day === 1 || r.all_day === "1",
    calendar: String(r.calendar_name || ""),
    status: statusLabel(String(r.status ?? "")),
    description: String(r.description || ""),
    url: String(r.url || ""),
    recurrence,
    attendees: attendeeRows.map((a) => ({
      name: String(a.name || "").trim(),
      email: String(a.email || ""),
      status: participantStatusLabel(String(a.status ?? "")),
    })),
  };
}

// ─── Write Tools (JXA — requires Calendar.app, serialized via queue) ─

export async function createEvent(
  summary: string,
  startDate: string,
  endDate: string,
  calendar?: string,
  location?: string,
  description?: string,
  allDay = false
): Promise<{ success: boolean; id: string }> {
  const calSetup = calendar
    ? `const cal = Cal.calendars.byName(${jxaString(calendar)});`
    : `const cal = Cal.calendars()[0];`;

  return executeJxaWrite(`
    const Cal = Application("Calendar");
    ${calSetup}
    const props = {
      summary: ${jxaString(summary)},
      startDate: new Date(${jxaString(startDate)}),
      endDate: new Date(${jxaString(endDate)}),
      alldayEvent: ${Boolean(allDay)}
    };
    ${location ? `props.location = ${jxaString(location)};` : ""}
    ${description ? `props.description = ${jxaString(description)};` : ""}
    const e = Cal.Event(props);
    cal.events.push(e);
    JSON.stringify({ success: true, id: e.uid() });
  `);
}

export async function modifyEvent(
  eventId: string,
  calendar: string,
  updates: {
    summary?: string;
    startDate?: string;
    endDate?: string;
    location?: string;
    description?: string;
  }
): Promise<{ success: boolean }> {
  const ops: string[] = [];
  if (updates.summary !== undefined)
    ops.push(`e.summary = ${jxaString(updates.summary)};`);
  if (updates.startDate !== undefined)
    ops.push(`e.startDate = new Date(${jxaString(updates.startDate)});`);
  if (updates.endDate !== undefined)
    ops.push(`e.endDate = new Date(${jxaString(updates.endDate)});`);
  if (updates.location !== undefined)
    ops.push(`e.location = ${jxaString(updates.location)};`);
  if (updates.description !== undefined)
    ops.push(`e.description = ${jxaString(updates.description)};`);

  return executeJxaWrite(`
    const Cal = Application("Calendar");
    const cal = Cal.calendars.byName(${jxaString(calendar)});
    const matches = cal.events.whose({ uid: ${jxaString(eventId)} })();
    if (!matches.length) throw new Error("Event not found");
    const e = matches[0];
    ${ops.join("\n    ")}
    JSON.stringify({ success: true });
  `);
}

export async function deleteEvent(
  eventId: string,
  calendar: string
): Promise<{ success: boolean }> {
  return executeJxaWrite(`
    const Cal = Application("Calendar");
    const cal = Cal.calendars.byName(${jxaString(calendar)});
    const matches = cal.events.whose({ uid: ${jxaString(eventId)} })();
    if (!matches.length) throw new Error("Event not found");
    Cal.delete(matches[0]);
    JSON.stringify({ success: true });
  `);
}
