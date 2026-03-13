/**
 * Apple Reminders MCP tools.
 *
 * Read operations query the Reminders SQLite database directly for instant
 * results. Write operations use JXA since the database is read-only.
 *
 * Provides: list_reminder_lists, get_reminders, get_reminder,
 * create_reminder, complete_reminder, delete_reminder
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { executeJxa, executeJxaWrite, jxaString } from "../shared/applescript.js";
import { sqliteQuery, sqlEscape } from "../shared/sqlite.js";
import { getReminderLists } from "../shared/config.js";
import { PaginatedResult, paginateRows } from "../shared/types.js";

const CORE_DATA_EPOCH_OFFSET = 978307200;
const REMINDER_ID_PREFIX = "x-apple-reminder://";

/**
 * Find the active Reminders SQLite database.
 * macOS stores multiple .sqlite files but typically only one has data.
 */
function findRemindersDb(): string {
  const storesDir = join(
    homedir(),
    "Library/Group Containers/group.com.apple.reminders/Container_v1/Stores"
  );
  let files: string[];
  try {
    files = readdirSync(storesDir).filter((f) => f.endsWith(".sqlite"));
  } catch {
    throw new Error(`Reminders database directory not found: ${storesDir}`);
  }
  if (files.length === 0) {
    throw new Error(`No .sqlite files found in: ${storesDir}`);
  }
  // Return the largest file (the one with actual data)
  let best = files[0];
  let bestSize = 0;
  for (const f of files) {
    try {
      const { size } = statSync(join(storesDir, f));
      if (size > bestSize) {
        bestSize = size;
        best = f;
      }
    } catch {}
  }
  return join(storesDir, best);
}

let _remindersDb: string | null = null;
function getRemindersDb(): string {
  if (!_remindersDb) _remindersDb = findRemindersDb();
  return _remindersDb;
}

/** Convert a Core Data timestamp to ISO string. */
function fromCoreDataTimestamp(ts: number | string | null | undefined): string {
  if (ts == null || ts === "") return "";
  const n = typeof ts === "string" ? parseFloat(ts) : ts;
  if (isNaN(n)) return "";
  return new Date((n + CORE_DATA_EPOCH_OFFSET) * 1000).toISOString();
}

/** Build SQL WHERE clause for configured reminder lists. */
function listWhereClause(list?: string): string {
  if (list) {
    return `AND l.ZNAME = '${sqlEscape(list)}'`;
  }
  const configured = getReminderLists();
  if (configured) {
    const names = configured.map((n) => `'${sqlEscape(n)}'`).join(", ");
    return `AND l.ZNAME IN (${names})`;
  }
  return "";
}

// ─── Types ───────────────────────────────────────────────────────

export interface ReminderList {
  name: string;
  id: string;
  count: number;
}

export interface ReminderSummary {
  id: string;
  name: string;
  completed: boolean;
  completionDate: string;
  dueDate: string;
  priority: number;
  list: string;
  flagged: boolean;
}

export interface ReminderFull extends ReminderSummary {
  body: string;
  creationDate: string;
  modificationDate: string;
}

// PaginatedResult<T> imported from shared/types.ts
export type { PaginatedResult } from "../shared/types.js";

// ─── Read Tools (SQLite — instant) ──────────────────────────────

export async function listReminderLists(): Promise<ReminderList[]> {
  const db = getRemindersDb();
  const listFilter = listWhereClause();
  const rows = await sqliteQuery(
    db,
    `SELECT l.ZNAME, l.ZCKIDENTIFIER,
       (SELECT COUNT(*) FROM ZREMCDREMINDER r
        WHERE r.ZLIST = l.Z_PK AND r.ZMARKEDFORDELETION = 0 AND r.ZCOMPLETED = 0) as cnt
     FROM ZREMCDBASELIST l
     WHERE l.ZMARKEDFORDELETION = 0 AND l.ZNAME IS NOT NULL AND l.ZISGROUP = 0
       ${listFilter}
     ORDER BY l.ZNAME;`
  );

  return rows.map((r) => ({
    name: String(r.ZNAME || ""),
    id: String(r.ZNAME || ""),
    count: typeof r.cnt === "number" ? r.cnt : parseInt(String(r.cnt || "0"), 10),
  }));
}

export async function getReminders(
  list?: string,
  filter: "all" | "incomplete" | "completed" | "due_today" | "overdue" | "flagged" = "incomplete",
  limit = 50,
  offset = 0
): Promise<PaginatedResult<ReminderSummary>> {
  const db = getRemindersDb();
  const listFilter = listWhereClause(list);

  // Use local timezone for date boundaries
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDayTs = Math.floor(startOfDay.getTime() / 1000) - CORE_DATA_EPOCH_OFFSET;
  const endOfDayTs = startOfDayTs + 86400;
  const nowTs = Math.floor(now.getTime() / 1000) - CORE_DATA_EPOCH_OFFSET;

  let filterSql: string;
  switch (filter) {
    case "completed":
      filterSql = "AND r.ZCOMPLETED = 1";
      break;
    case "all":
      filterSql = "";
      break;
    case "due_today":
      filterSql = `AND r.ZCOMPLETED = 0 AND r.ZDUEDATE IS NOT NULL
        AND r.ZDUEDATE >= ${startOfDayTs}
        AND r.ZDUEDATE < ${endOfDayTs}`;
      break;
    case "overdue":
      filterSql = `AND r.ZCOMPLETED = 0 AND r.ZDUEDATE IS NOT NULL
        AND r.ZDUEDATE < ${nowTs}`;
      break;
    case "flagged":
      filterSql = "AND r.ZCOMPLETED = 0 AND r.ZFLAGGED = 1";
      break;
    default: // incomplete
      filterSql = "AND r.ZCOMPLETED = 0";
  }

  const baseWhere = `r.ZMARKEDFORDELETION = 0 ${filterSql} ${listFilter}`;

  const [rows, countRows] = await Promise.all([
    sqliteQuery(
      db,
      `SELECT r.ZCKIDENTIFIER, r.ZTITLE, r.ZCOMPLETED, r.ZCOMPLETIONDATE,
         r.ZDUEDATE, r.ZPRIORITY, r.ZFLAGGED, l.ZNAME as list_name
       FROM ZREMCDREMINDER r
       JOIN ZREMCDBASELIST l ON r.ZLIST = l.Z_PK
       WHERE ${baseWhere}
       ORDER BY
         CASE WHEN r.ZDUEDATE IS NOT NULL THEN 0 ELSE 1 END,
         r.ZDUEDATE
       LIMIT ${limit} OFFSET ${offset};`
    ),
    sqliteQuery(
      db,
      `SELECT COUNT(*) as total
       FROM ZREMCDREMINDER r
       JOIN ZREMCDBASELIST l ON r.ZLIST = l.Z_PK
       WHERE ${baseWhere};`
    ),
  ]);

  const total =
    typeof countRows[0]?.total === "number"
      ? countRows[0].total
      : parseInt(String(countRows[0]?.total || "0"), 10);

  const items = rows.map((r) => ({
    id: REMINDER_ID_PREFIX + String(r.ZCKIDENTIFIER || ""),
    name: String(r.ZTITLE || ""),
    completed: r.ZCOMPLETED === 1 || r.ZCOMPLETED === "1",
    completionDate: fromCoreDataTimestamp(r.ZCOMPLETIONDATE),
    dueDate: fromCoreDataTimestamp(r.ZDUEDATE),
    priority: typeof r.ZPRIORITY === "number" ? r.ZPRIORITY : 0,
    list: String(r.list_name || ""),
    flagged: r.ZFLAGGED === 1 || r.ZFLAGGED === "1",
  }));

  return paginateRows(items, total, offset);
}

export async function getReminder(
  reminderId: string,
  list: string
): Promise<ReminderFull> {
  const db = getRemindersDb();
  // Strip x-apple-reminder:// prefix if present for DB lookup
  const ckId = reminderId.replace(REMINDER_ID_PREFIX, "");

  const rows = await sqliteQuery(
    db,
    `SELECT r.ZCKIDENTIFIER, r.ZTITLE, r.ZCOMPLETED, r.ZCOMPLETIONDATE,
       r.ZDUEDATE, r.ZPRIORITY, r.ZFLAGGED, r.ZNOTES,
       r.ZCREATIONDATE, r.ZLASTMODIFIEDDATE, l.ZNAME as list_name
     FROM ZREMCDREMINDER r
     JOIN ZREMCDBASELIST l ON r.ZLIST = l.Z_PK
     WHERE r.ZCKIDENTIFIER = '${sqlEscape(ckId)}'
       AND l.ZNAME = '${sqlEscape(list)}'
     LIMIT 1;`
  );

  if (!rows.length) throw new Error("Reminder not found");
  const r = rows[0];

  return {
    id: REMINDER_ID_PREFIX + String(r.ZCKIDENTIFIER || ""),
    name: String(r.ZTITLE || ""),
    completed: r.ZCOMPLETED === 1 || r.ZCOMPLETED === "1",
    completionDate: fromCoreDataTimestamp(r.ZCOMPLETIONDATE),
    dueDate: fromCoreDataTimestamp(r.ZDUEDATE),
    priority: typeof r.ZPRIORITY === "number" ? r.ZPRIORITY : 0,
    list: String(r.list_name || ""),
    flagged: r.ZFLAGGED === 1 || r.ZFLAGGED === "1",
    body: String(r.ZNOTES || ""),
    creationDate: fromCoreDataTimestamp(r.ZCREATIONDATE),
    modificationDate: fromCoreDataTimestamp(r.ZLASTMODIFIEDDATE),
  };
}

// ─── Write Tools (JXA — requires Reminders.app, serialized via queue) ─

export async function createReminder(
  name: string,
  list?: string,
  dueDate?: string,
  body?: string,
  priority?: number,
  flagged?: boolean
): Promise<{ success: boolean; id: string }> {
  const listSetup = list
    ? `const l = Rem.lists.byName(${jxaString(list)});`
    : `const l = Rem.defaultList();`;

  const props: string[] = [`name: ${jxaString(name)}`];
  if (body !== undefined) props.push(`body: ${jxaString(body)}`);
  if (priority !== undefined) props.push(`priority: ${priority}`);
  if (flagged !== undefined) props.push(`flagged: ${flagged}`);

  return executeJxaWrite(`
    const Rem = Application("Reminders");
    ${listSetup}
    const r = Rem.Reminder({
      ${props.join(",\n      ")}
    });
    l.reminders.push(r);
    ${dueDate ? `r.dueDate = new Date(${jxaString(dueDate)});` : ""}
    JSON.stringify({ success: true, id: r.id() });
  `);
}

export async function completeReminder(
  reminderId: string,
  list: string
): Promise<{ success: boolean }> {
  return executeJxaWrite(`
    const Rem = Application("Reminders");
    const l = Rem.lists.byName(${jxaString(list)});
    const r = l.reminders.byId(${jxaString(reminderId)});
    r.completed = true;
    JSON.stringify({ success: true });
  `);
}

export async function deleteReminder(
  reminderId: string,
  list: string
): Promise<{ success: boolean }> {
  return executeJxaWrite(`
    const Rem = Application("Reminders");
    const l = Rem.lists.byName(${jxaString(list)});
    const r = l.reminders.byId(${jxaString(reminderId)});
    Rem.delete(r);
    JSON.stringify({ success: true });
  `);
}
