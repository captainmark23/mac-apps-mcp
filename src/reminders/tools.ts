/**
 * Apple Reminders MCP tools.
 *
 * Hybrid read strategy:
 *   - macOS stores each Reminders account in a separate SQLite file under
 *     ~/Library/Group Containers/group.com.apple.reminders/Container_v1/Stores/
 *   - The previous single-DB approach only queried the largest file, missing
 *     non-iCloud accounts (Exchange, etc.) stored in smaller databases.
 *   - Now we query ALL viable .sqlite files and merge results.
 *   - Write operations always use JXA (database is read-only).
 *
 * Provides: list_reminder_lists, get_reminders, get_reminder,
 * create_reminder, complete_reminder, delete_reminder
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { executeJxa, executeJxaWrite, jxaString } from "../shared/applescript.js";
import { sqliteQuery, SqliteRow, sqlEscape, safeInt } from "../shared/sqlite.js";
import { getReminderLists } from "../shared/config.js";
import { PaginatedResult, paginateRows, CORE_DATA_EPOCH_OFFSET, SECONDS_PER_DAY, fromCoreDataTimestamp } from "../shared/types.js";

export const REMINDER_ID_PREFIX = "x-apple-reminder://";

/** Minimum file size (bytes) to consider a .sqlite file as containing real data. */
const MIN_DB_SIZE = 200 * 1024; // 200 KB — empty/placeholder databases are ~32-50 KB

/** Internal system list names that should never appear in user-facing results. */
const SYSTEM_LIST_NAMES = new Set(["SiriFoundInApps"]);

/**
 * Find ALL active Reminders SQLite databases (one per account).
 * macOS stores each account (iCloud, Exchange, etc.) in a separate .sqlite file.
 * We filter out tiny placeholder files and return paths for all viable databases.
 */
export function findAllRemindersDbs(): string[] {
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

  const viable: string[] = [];
  for (const f of files) {
    try {
      const fullPath = join(storesDir, f);
      const { size } = statSync(fullPath);
      if (size >= MIN_DB_SIZE) {
        viable.push(fullPath);
      }
    } catch { /* skip inaccessible files */ }
  }

  if (viable.length === 0) {
    throw new Error(`No Reminders databases with data found in: ${storesDir}`);
  }
  return viable;
}

let _remindersDbs: string[] | null = null;
let _remindersDbsExpiry = 0;
const DB_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getAllRemindersDbs(): string[] {
  if (!_remindersDbs || Date.now() > _remindersDbsExpiry) {
    _remindersDbs = findAllRemindersDbs();
    _remindersDbsExpiry = Date.now() + DB_CACHE_TTL_MS;
  }
  return _remindersDbs;
}

/**
 * Run a SQL query across all Reminders databases and merge results.
 * Gracefully skips databases that error (e.g. locked or incompatible schema).
 */
async function queryAllDbs<T extends SqliteRow = SqliteRow>(sql: string): Promise<T[]> {
  const dbs = getAllRemindersDbs();
  const results = await Promise.all(
    dbs.map((db) => sqliteQuery<T>(db, sql).catch(() => []))
  );
  return results.flat();
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

// ─── Read Tools (SQLite — multi-database, instant) ──────────────

export async function listReminderLists(): Promise<ReminderList[]> {
  const listFilter = listWhereClause();
  const rows = await queryAllDbs(
    `SELECT l.ZNAME, l.ZCKIDENTIFIER,
       (SELECT COUNT(*) FROM ZREMCDREMINDER r
        WHERE r.ZLIST = l.Z_PK AND r.ZMARKEDFORDELETION = 0 AND r.ZCOMPLETED = 0) as cnt
     FROM ZREMCDBASELIST l
     WHERE l.ZMARKEDFORDELETION = 0 AND l.ZNAME IS NOT NULL AND l.ZISGROUP = 0
       ${listFilter}
     ORDER BY l.ZNAME;`
  );

  // Deduplicate by name (same list could appear as marked-for-deletion in one DB
  // and active in another) and filter out system lists
  const seen = new Map<string, ReminderList>();
  for (const r of rows) {
    const name = String(r.ZNAME || "");
    if (SYSTEM_LIST_NAMES.has(name)) continue;
    const count = typeof r.cnt === "number" ? r.cnt : parseInt(String(r.cnt || "0"), 10);
    const existing = seen.get(name);
    if (existing) {
      // Merge counts from the same-named list across databases
      existing.count += count;
    } else {
      seen.set(name, { name, id: name, count });
    }
  }

  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getReminders(
  list?: string,
  filter: "all" | "incomplete" | "completed" | "due_today" | "overdue" | "flagged" = "incomplete",
  limit = 50,
  offset = 0
): Promise<PaginatedResult<ReminderSummary>> {
  const listFilter = listWhereClause(list);

  // Use local timezone for date boundaries
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDayTs = Math.floor(startOfDay.getTime() / 1000) - CORE_DATA_EPOCH_OFFSET;
  const endOfDayTs = startOfDayTs + SECONDS_PER_DAY;
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
        AND r.ZDUEDATE >= ${safeInt(startOfDayTs)}
        AND r.ZDUEDATE < ${safeInt(endOfDayTs)}`;
      break;
    case "overdue":
      filterSql = `AND r.ZCOMPLETED = 0 AND r.ZDUEDATE IS NOT NULL
        AND r.ZDUEDATE < ${safeInt(nowTs)}`;
      break;
    case "flagged":
      filterSql = "AND r.ZCOMPLETED = 0 AND r.ZFLAGGED = 1";
      break;
    default: // incomplete
      filterSql = "AND r.ZCOMPLETED = 0";
  }

  const baseWhere = `r.ZMARKEDFORDELETION = 0 ${filterSql} ${listFilter}`;

  // Query all databases in parallel
  const dbs = getAllRemindersDbs();
  const [allRows, allCounts] = await Promise.all([
    Promise.all(
      dbs.map((db) =>
        sqliteQuery(
          db,
          `SELECT r.ZCKIDENTIFIER, r.ZTITLE, r.ZCOMPLETED, r.ZCOMPLETIONDATE,
             r.ZDUEDATE, r.ZPRIORITY, r.ZFLAGGED, l.ZNAME as list_name
           FROM ZREMCDREMINDER r
           JOIN ZREMCDBASELIST l ON r.ZLIST = l.Z_PK
           WHERE ${baseWhere}
           ORDER BY
             CASE WHEN r.ZDUEDATE IS NOT NULL THEN 0 ELSE 1 END,
             r.ZDUEDATE;`
        ).catch(() => [])
      )
    ),
    Promise.all(
      dbs.map((db) =>
        sqliteQuery(
          db,
          `SELECT COUNT(*) as total
           FROM ZREMCDREMINDER r
           JOIN ZREMCDBASELIST l ON r.ZLIST = l.Z_PK
           WHERE ${baseWhere};`
        ).catch(() => [{ total: 0 }])
      )
    ),
  ]);

  const rows = allRows.flat().filter((r) => !SYSTEM_LIST_NAMES.has(String(r.list_name || "")));
  const total = allCounts.flat().reduce(
    (sum, r) => sum + safeInt(r?.total ?? 0),
    0
  );

  const items: ReminderSummary[] = rows.map((r) => ({
    id: REMINDER_ID_PREFIX + String(r.ZCKIDENTIFIER || ""),
    name: String(r.ZTITLE || ""),
    completed: r.ZCOMPLETED === 1 || r.ZCOMPLETED === "1",
    completionDate: fromCoreDataTimestamp(r.ZCOMPLETIONDATE),
    dueDate: fromCoreDataTimestamp(r.ZDUEDATE),
    priority: typeof r.ZPRIORITY === "number" ? r.ZPRIORITY : 0,
    list: String(r.list_name || ""),
    flagged: r.ZFLAGGED === 1 || r.ZFLAGGED === "1",
  }));

  // Re-sort merged results from multiple databases
  items.sort((a, b) => {
    const aHasDue = a.dueDate !== "";
    const bHasDue = b.dueDate !== "";
    if (aHasDue !== bHasDue) return aHasDue ? -1 : 1;
    if (aHasDue && bHasDue) return a.dueDate.localeCompare(b.dueDate);
    return 0;
  });

  // Apply pagination to merged results
  const paged = items.slice(offset, offset + limit);
  return paginateRows(paged, total, offset);
}

export async function getReminder(
  reminderId: string,
  list: string
): Promise<ReminderFull> {
  // Strip x-apple-reminder:// prefix if present for DB lookup
  const ckId = reminderId.replace(REMINDER_ID_PREFIX, "");

  // Search across all databases — the reminder could be in any account's DB
  const rows = await queryAllDbs(
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
  if (priority !== undefined) props.push(`priority: ${safeInt(priority)}`);
  if (flagged !== undefined) props.push(`flagged: ${Boolean(flagged)}`);

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
  // Strip x-apple-reminder:// prefix if present for JXA lookup
  const cleanId = reminderId.replace(REMINDER_ID_PREFIX, "");
  return executeJxaWrite(`
    const Rem = Application("Reminders");
    const l = Rem.lists.byName(${jxaString(list)});
    const r = l.reminders.byId(${jxaString(cleanId)});
    r.completed = true;
    JSON.stringify({ success: true });
  `);
}

export async function deleteReminder(
  reminderId: string,
  list: string
): Promise<{ success: boolean }> {
  // Strip x-apple-reminder:// prefix if present for JXA lookup
  const cleanId = reminderId.replace(REMINDER_ID_PREFIX, "");
  return executeJxaWrite(`
    const Rem = Application("Reminders");
    const l = Rem.lists.byName(${jxaString(list)});
    const r = l.reminders.byId(${jxaString(cleanId)});
    Rem.delete(r);
    JSON.stringify({ success: true });
  `);
}
