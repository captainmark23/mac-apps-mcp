/**
 * Apple Notes MCP tools.
 *
 * Read operations query the Notes SQLite database directly for instant
 * results. Write operations use JXA since the database is read-only.
 *
 * Provides: listFolders, listNotes, getNote, searchNotes,
 * createNote, updateNote, deleteNote, moveNote, createFolder
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { executeJxa, executeJxaWrite, jxaString } from "../shared/applescript.js";
import { sqliteQuery, sqlEscape, sqlLikeEscape, safeInt } from "../shared/sqlite.js";
import { isSanitizeBodies } from "../shared/config.js";
import {
  PaginatedResult,
  paginateRows,
  CORE_DATA_EPOCH_OFFSET,
  SECONDS_PER_DAY,
  fromCoreDataTimestamp,
  stripInjectionPatterns,
  sanitizeBodyContent,
} from "../shared/types.js";

// ─── Database ────────────────────────────────────────────────────

let _notesDbPath: string | null = null;

export function getNotesDbPath(): string {
  if (_notesDbPath) return _notesDbPath;
  const dbPath = join(
    homedir(),
    "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"
  );
  if (!existsSync(dbPath)) {
    throw new Error("Notes database not found. Is Notes.app configured?");
  }
  _notesDbPath = dbPath;
  return _notesDbPath;
}

// ─── Configuration ───────────────────────────────────────────────

export function getNotesFolders(): string[] | null {
  const val = process.env.MACOS_MCP_NOTES_FOLDERS;
  if (!val) return null;
  return val.split(",").map((s) => s.trim()).filter(Boolean);
}

export function getDefaultNotesAccount(): string | undefined {
  return process.env.MACOS_MCP_NOTES_ACCOUNT || undefined;
}

/** Build SQL WHERE clause for configured note folders. */
function folderWhereClause(folder?: string): string {
  if (folder) {
    return `AND f.ZTITLE2 = '${sqlEscape(folder)}'`;
  }
  const configured = getNotesFolders();
  if (configured) {
    const names = configured.map((n) => `'${sqlEscape(n)}'`).join(", ");
    return `AND f.ZTITLE2 IN (${names})`;
  }
  return "";
}

// ─── Core Data Entity Types ─────────────────────────────────────
// All entities live in the polymorphic ZICCLOUDSYNCINGOBJECT table.

const ENT_NOTE = 12;
const ENT_FOLDER = 15;
const ENT_ACCOUNT = 14;

// ─── Types ───────────────────────────────────────────────────────

export interface NoteAccount {
  name: string;
  identifier: string;
}

export interface NoteFolder {
  name: string;
  identifier: string;
  folderType: number;
  noteCount: number;
  accountName: string;
}

export interface NoteSummary {
  identifier: string;
  title: string;
  snippet: string;
  creationDate: string;
  modificationDate: string;
  folder: string;
  account: string;
  isPinned: boolean;
  isLocked: boolean;
  hasChecklist: boolean;
}

export interface NoteFull extends NoteSummary {
  body: string;
  bodyFormat: "plaintext" | "html";
  attachmentCount: number;
  shared: boolean;
}

export type { PaginatedResult } from "../shared/types.js";

// ─── Read Tools (SQLite — instant) ──────────────────────────────

export async function listAccounts(): Promise<NoteAccount[]> {
  const db = getNotesDbPath();
  const rows = await sqliteQuery(
    db,
    `SELECT ZNAME, ZIDENTIFIER
     FROM ZICCLOUDSYNCINGOBJECT
     WHERE Z_ENT = ${ENT_ACCOUNT}
       AND ZNAME IS NOT NULL
     ORDER BY ZNAME;`
  );
  return rows.map((r) => ({
    name: String(r.ZNAME || ""),
    identifier: String(r.ZIDENTIFIER || ""),
  }));
}

export async function listFolders(
  account?: string,
  includeTrash = false
): Promise<NoteFolder[]> {
  const db = getNotesDbPath();
  const accountFilter = account
    ? `AND a.ZNAME = '${sqlEscape(account)}'`
    : "";
  const trashFilter = includeTrash
    ? ""
    : "AND (f.ZFOLDERTYPE IS NULL OR f.ZFOLDERTYPE = 0)";

  const rows = await sqliteQuery(
    db,
    `SELECT
       f.ZIDENTIFIER AS identifier,
       f.ZTITLE2 AS name,
       f.ZFOLDERTYPE AS folder_type,
       a.ZNAME AS account_name,
       (SELECT COUNT(*) FROM ZICCLOUDSYNCINGOBJECT n
        WHERE n.Z_ENT = ${ENT_NOTE} AND n.ZFOLDER = f.Z_PK
        AND (n.ZMARKEDFORDELETION IS NULL OR n.ZMARKEDFORDELETION = 0)
       ) AS note_count
     FROM ZICCLOUDSYNCINGOBJECT f
     LEFT JOIN ZICCLOUDSYNCINGOBJECT a ON a.Z_PK = f.ZACCOUNT8
     WHERE f.Z_ENT = ${ENT_FOLDER}
       AND f.ZTITLE2 IS NOT NULL
       ${trashFilter}
       ${accountFilter}
     ORDER BY f.ZTITLE2;`
  );

  return rows.map((r) => ({
    name: String(r.name || ""),
    identifier: String(r.identifier || ""),
    folderType: typeof r.folder_type === "number" ? r.folder_type : 0,
    noteCount: typeof r.note_count === "number" ? r.note_count : safeInt(r.note_count ?? 0),
    accountName: String(r.account_name || ""),
  }));
}

export async function listNotes(
  folder?: string,
  account?: string,
  filter: "all" | "pinned" | "with_checklist" | "today" | "this_week" = "all",
  sort: "modified" | "created" | "title" = "modified",
  limit = 25,
  offset = 0
): Promise<PaginatedResult<NoteSummary>> {
  const db = getNotesDbPath();
  const folderFilter = folderWhereClause(folder);
  const accountFilter = account
    ? `AND a.ZNAME = '${sqlEscape(account)}'`
    : "";

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDayTs = Math.floor(startOfDay.getTime() / 1000) - CORE_DATA_EPOCH_OFFSET;
  const startOfWeekTs = startOfDayTs - (now.getDay() * SECONDS_PER_DAY);

  let filterSql: string;
  switch (filter) {
    case "pinned":
      filterSql = "AND n.ZISPINNED = 1";
      break;
    case "with_checklist":
      filterSql = "AND n.ZHASCHECKLIST = 1";
      break;
    case "today":
      filterSql = `AND n.ZMODIFICATIONDATE1 >= ${safeInt(startOfDayTs)}`;
      break;
    case "this_week":
      filterSql = `AND n.ZMODIFICATIONDATE1 >= ${safeInt(startOfWeekTs)}`;
      break;
    default:
      filterSql = "";
  }

  let orderSql: string;
  switch (sort) {
    case "created":
      orderSql = "n.ZCREATIONDATE3 DESC";
      break;
    case "title":
      orderSql = "n.ZTITLE1 COLLATE NOCASE ASC";
      break;
    default:
      orderSql = "n.ZMODIFICATIONDATE1 DESC";
  }

  const baseWhere = `n.Z_ENT = ${ENT_NOTE}
    AND (n.ZMARKEDFORDELETION IS NULL OR n.ZMARKEDFORDELETION = 0)
    ${filterSql} ${folderFilter} ${accountFilter}`;

  const [rows, countRows] = await Promise.all([
    sqliteQuery(
      db,
      `SELECT
         n.ZIDENTIFIER AS identifier,
         n.ZTITLE1 AS title,
         n.ZSNIPPET AS snippet,
         n.ZCREATIONDATE3 AS creation_date,
         n.ZMODIFICATIONDATE1 AS modification_date,
         n.ZISPINNED AS is_pinned,
         n.ZISPASSWORDPROTECTED AS is_locked,
         n.ZHASCHECKLIST AS has_checklist,
         f.ZTITLE2 AS folder_name,
         a.ZNAME AS account_name
       FROM ZICCLOUDSYNCINGOBJECT n
       LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = n.ZFOLDER
       LEFT JOIN ZICCLOUDSYNCINGOBJECT a ON a.Z_PK = n.ZACCOUNT7
       WHERE ${baseWhere}
       ORDER BY ${orderSql}
       LIMIT ${safeInt(limit)} OFFSET ${safeInt(offset)};`
    ),
    sqliteQuery(
      db,
      `SELECT COUNT(*) as total
       FROM ZICCLOUDSYNCINGOBJECT n
       LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = n.ZFOLDER
       LEFT JOIN ZICCLOUDSYNCINGOBJECT a ON a.Z_PK = n.ZACCOUNT7
       WHERE ${baseWhere};`
    ),
  ]);

  const total = safeInt(countRows[0]?.total ?? 0);

  const items: NoteSummary[] = rows.map((r) => ({
    identifier: String(r.identifier || ""),
    title: String(r.title || ""),
    snippet: stripInjectionPatterns(String(r.snippet || "")),
    creationDate: fromCoreDataTimestamp(r.creation_date),
    modificationDate: fromCoreDataTimestamp(r.modification_date),
    folder: String(r.folder_name || ""),
    account: String(r.account_name || ""),
    isPinned: r.is_pinned === 1 || r.is_pinned === "1",
    isLocked: r.is_locked === 1 || r.is_locked === "1",
    hasChecklist: r.has_checklist === 1 || r.has_checklist === "1",
  }));

  return paginateRows(items, total, offset);
}

export async function searchNotes(
  query: string,
  scope: "title" | "snippet" | "all" = "all",
  folder?: string,
  limit = 20,
  offset = 0
): Promise<PaginatedResult<NoteSummary>> {
  const db = getNotesDbPath();
  const escapedQuery = sqlLikeEscape(query);
  const folderFilter = folderWhereClause(folder);

  let scopeSql: string;
  switch (scope) {
    case "title":
      scopeSql = `AND n.ZTITLE1 LIKE '%${escapedQuery}%' ESCAPE '\\'`;
      break;
    case "snippet":
      scopeSql = `AND n.ZSNIPPET LIKE '%${escapedQuery}%' ESCAPE '\\'`;
      break;
    default:
      scopeSql = `AND (n.ZTITLE1 LIKE '%${escapedQuery}%' ESCAPE '\\' OR n.ZSNIPPET LIKE '%${escapedQuery}%' ESCAPE '\\')`;
  }

  const baseWhere = `n.Z_ENT = ${ENT_NOTE}
    AND (n.ZMARKEDFORDELETION IS NULL OR n.ZMARKEDFORDELETION = 0)
    ${scopeSql} ${folderFilter}`;

  const [rows, countRows] = await Promise.all([
    sqliteQuery(
      db,
      `SELECT
         n.ZIDENTIFIER AS identifier,
         n.ZTITLE1 AS title,
         n.ZSNIPPET AS snippet,
         n.ZCREATIONDATE3 AS creation_date,
         n.ZMODIFICATIONDATE1 AS modification_date,
         n.ZISPINNED AS is_pinned,
         n.ZISPASSWORDPROTECTED AS is_locked,
         n.ZHASCHECKLIST AS has_checklist,
         f.ZTITLE2 AS folder_name,
         a.ZNAME AS account_name
       FROM ZICCLOUDSYNCINGOBJECT n
       LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = n.ZFOLDER
       LEFT JOIN ZICCLOUDSYNCINGOBJECT a ON a.Z_PK = n.ZACCOUNT7
       WHERE ${baseWhere}
       ORDER BY n.ZMODIFICATIONDATE1 DESC
       LIMIT ${safeInt(limit)} OFFSET ${safeInt(offset)};`
    ),
    sqliteQuery(
      db,
      `SELECT COUNT(*) as total
       FROM ZICCLOUDSYNCINGOBJECT n
       LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = n.ZFOLDER
       LEFT JOIN ZICCLOUDSYNCINGOBJECT a ON a.Z_PK = n.ZACCOUNT7
       WHERE ${baseWhere};`
    ),
  ]);

  const total = safeInt(countRows[0]?.total ?? 0);

  const items: NoteSummary[] = rows.map((r) => ({
    identifier: String(r.identifier || ""),
    title: String(r.title || ""),
    snippet: stripInjectionPatterns(String(r.snippet || "")),
    creationDate: fromCoreDataTimestamp(r.creation_date),
    modificationDate: fromCoreDataTimestamp(r.modification_date),
    folder: String(r.folder_name || ""),
    account: String(r.account_name || ""),
    isPinned: r.is_pinned === 1 || r.is_pinned === "1",
    isLocked: r.is_locked === 1 || r.is_locked === "1",
    hasChecklist: r.has_checklist === 1 || r.has_checklist === "1",
  }));

  return paginateRows(items, total, offset);
}

/**
 * Get full note details including body via JXA.
 * Body is fetched via JXA because SQLite stores it as gzip'd protobuf.
 */
export async function getNote(
  identifier: string,
  format: "plaintext" | "html" = "plaintext"
): Promise<NoteFull> {
  // First get metadata from SQLite (fast)
  const db = getNotesDbPath();
  const rows = await sqliteQuery(
    db,
    `SELECT
       n.Z_PK AS pk,
       n.ZIDENTIFIER AS identifier,
       n.ZTITLE1 AS title,
       n.ZSNIPPET AS snippet,
       n.ZCREATIONDATE3 AS creation_date,
       n.ZMODIFICATIONDATE1 AS modification_date,
       n.ZISPINNED AS is_pinned,
       n.ZISPASSWORDPROTECTED AS is_locked,
       n.ZHASCHECKLIST AS has_checklist,
       f.ZTITLE2 AS folder_name,
       a.ZNAME AS account_name,
       (SELECT COUNT(*) FROM ZICCLOUDSYNCINGOBJECT att
        WHERE att.Z_ENT = 5 AND att.ZNOTE = n.Z_PK
       ) AS attachment_count
     FROM ZICCLOUDSYNCINGOBJECT n
     LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = n.ZFOLDER
     LEFT JOIN ZICCLOUDSYNCINGOBJECT a ON a.Z_PK = n.ZACCOUNT7
     WHERE n.Z_ENT = ${ENT_NOTE}
       AND n.ZIDENTIFIER = '${sqlEscape(identifier)}'
     LIMIT 1;`
  );

  if (!rows.length) throw new Error("Note not found");
  const r = rows[0];
  const isLocked = r.is_locked === 1 || r.is_locked === "1";

  // Fetch body via JXA (required — body is protobuf in SQLite)
  let body = "";
  let shared = false;
  let attachmentCount = typeof r.attachment_count === "number"
    ? r.attachment_count
    : safeInt(r.attachment_count ?? 0);

  if (isLocked) {
    body = "[This note is password-protected. Unlock it in Notes.app to read the body.]";
  } else {
    // JXA note IDs are x-coredata:// URIs (e.g. x-coredata://UUID/ICNote/p133)
    // where the suffix 'p133' matches Z_PK in SQLite. The prefix varies per account.
    // We look up by title within the account, and disambiguate by
    // creation date if there are multiple notes with the same title.
    const noteTitle = String(r.title || "");
    const accountName = String(r.account_name || "");
    const creationIso = fromCoreDataTimestamp(r.creation_date);

    const jxaResult = await executeJxa<{
      plaintext: string;
      html: string;
      shared: boolean;
      attachmentCount: number;
    }>(`
      const app = Application("Notes");
      const title = ${jxaString(noteTitle)};
      const accountName = ${jxaString(accountName)};
      const targetCreation = ${jxaString(creationIso)};

      // Search within the account if known, otherwise all notes
      let candidates;
      if (accountName) {
        try {
          candidates = app.accounts.byName(accountName).notes.whose({name: title})();
        } catch(e) {
          candidates = app.notes.whose({name: title})();
        }
      } else {
        candidates = app.notes.whose({name: title})();
      }

      if (candidates.length === 0) throw new Error("Note not found via JXA");

      // Disambiguate by creation date if multiple matches
      let n = candidates[0];
      if (candidates.length > 1 && targetCreation) {
        const targetMs = new Date(targetCreation).getTime();
        for (const c of candidates) {
          if (Math.abs(c.creationDate().getTime() - targetMs) < 2000) {
            n = c;
            break;
          }
        }
      }

      JSON.stringify({
        plaintext: n.plaintext(),
        html: n.body(),
        shared: n.shared(),
        attachmentCount: n.attachments().length,
      });
    `);
    body = format === "html" ? jxaResult.html : jxaResult.plaintext;
    shared = jxaResult.shared;
    attachmentCount = jxaResult.attachmentCount;

    // Apply body sanitization if configured
    if (isSanitizeBodies()) {
      body = sanitizeBodyContent(body);
    } else {
      body = stripInjectionPatterns(body);
    }
  }

  return {
    identifier: String(r.identifier || ""),
    title: String(r.title || ""),
    snippet: stripInjectionPatterns(String(r.snippet || "")),
    creationDate: fromCoreDataTimestamp(r.creation_date),
    modificationDate: fromCoreDataTimestamp(r.modification_date),
    folder: String(r.folder_name || ""),
    account: String(r.account_name || ""),
    isPinned: r.is_pinned === 1 || r.is_pinned === "1",
    isLocked,
    hasChecklist: r.has_checklist === 1 || r.has_checklist === "1",
    body,
    bodyFormat: format,
    attachmentCount,
    shared,
  };
}

/**
 * Get notes modified today (for daily briefing integration).
 */
export async function getNotesModifiedToday(
  limit = 10
): Promise<PaginatedResult<NoteSummary>> {
  return listNotes(undefined, undefined, "today", "modified", limit, 0);
}

// ─── Write Tools (JXA — requires Notes.app, serialized via queue) ─

/**
 * Escape plain text for embedding in HTML body.
 * Converts newlines to <br> and escapes HTML entities.
 */
export function textToHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

/**
 * Resolve a note UUID (ZIDENTIFIER) to its title, account, and creation date
 * for JXA lookup. JXA uses x-coredata:// IDs which differ from SQLite UUIDs,
 * so we must look up by title + creation date for disambiguation.
 */
async function resolveNoteForJxa(identifier: string): Promise<{
  title: string;
  accountName: string;
  creationIso: string;
}> {
  const db = getNotesDbPath();
  const rows = await sqliteQuery(
    db,
    `SELECT n.ZTITLE1 AS title, a.ZNAME AS account_name, n.ZCREATIONDATE3 AS creation_date
     FROM ZICCLOUDSYNCINGOBJECT n
     LEFT JOIN ZICCLOUDSYNCINGOBJECT a ON a.Z_PK = n.ZACCOUNT7
     WHERE n.Z_ENT = ${ENT_NOTE}
       AND n.ZIDENTIFIER = '${sqlEscape(identifier)}'
     LIMIT 1;`
  );
  if (!rows.length) throw new Error("Note not found");
  return {
    title: String(rows[0].title || ""),
    accountName: String(rows[0].account_name || ""),
    creationIso: fromCoreDataTimestamp(rows[0].creation_date),
  };
}

/**
 * Build a JXA snippet that finds a note by title within an account,
 * disambiguating by creation date when multiple notes share the same title.
 * Returns the variable name 'n' pointing to the resolved note.
 */
function jxaFindNoteSnippet(title: string, accountName: string, creationIso: string): string {
  return `
      const _title = ${jxaString(title)};
      const _acct = ${jxaString(accountName)};
      const _targetCreation = ${jxaString(creationIso)};
      let _candidates;
      if (_acct) {
        try {
          _candidates = app.accounts.byName(_acct).notes.whose({name: _title})();
        } catch(e) {
          _candidates = app.notes.whose({name: _title})();
        }
      } else {
        _candidates = app.notes.whose({name: _title})();
      }
      if (_candidates.length === 0) throw new Error("Note not found");
      let n = _candidates[0];
      if (_candidates.length > 1 && _targetCreation) {
        const _targetMs = new Date(_targetCreation).getTime();
        for (const _c of _candidates) {
          if (Math.abs(_c.creationDate().getTime() - _targetMs) < 2000) {
            n = _c;
            break;
          }
        }
      }`;
}

export async function createNote(
  title: string,
  body: string,
  folder = "Notes",
  account?: string
): Promise<{ success: boolean; name: string; identifier: string }> {
  const htmlBody = `<h1>${textToHtml(title)}</h1><br>${textToHtml(body)}`;

  const folderRef = account
    ? `app.accounts.byName(${jxaString(account)}).folders.byName(${jxaString(folder)})`
    : `app.folders.byName(${jxaString(folder)})`;

  return executeJxaWrite(`
    const app = Application("Notes");
    const folder = ${folderRef};
    const note = app.make({
      new: "note",
      at: folder,
      withProperties: { body: ${jxaString(htmlBody)} }
    });
    JSON.stringify({
      success: true,
      name: note.name(),
      identifier: note.id(),
    });
  `);
}

export async function updateNote(
  identifier: string,
  body: string,
  format: "plaintext" | "html" = "plaintext"
): Promise<{ success: boolean; name: string }> {
  const htmlBody = format === "html" ? body : `<div>${textToHtml(body)}</div>`;
  const resolved = await resolveNoteForJxa(identifier);

  return executeJxaWrite(`
    const app = Application("Notes");
    ${jxaFindNoteSnippet(resolved.title, resolved.accountName, resolved.creationIso)}
    if (n.passwordProtected()) throw new Error("Cannot modify a password-protected note");
    n.body = ${jxaString(htmlBody)};
    JSON.stringify({
      success: true,
      name: n.name(),
    });
  `);
}

export async function deleteNote(
  identifier: string
): Promise<{ success: boolean }> {
  const resolved = await resolveNoteForJxa(identifier);

  return executeJxaWrite(`
    const app = Application("Notes");
    ${jxaFindNoteSnippet(resolved.title, resolved.accountName, resolved.creationIso)}
    app.delete(n);
    JSON.stringify({ success: true });
  `);
}

export async function moveNote(
  identifier: string,
  folder: string,
  account?: string
): Promise<{ success: boolean; folder: string }> {
  const resolved = await resolveNoteForJxa(identifier);
  const folderRef = account
    ? `app.accounts.byName(${jxaString(account)}).folders.byName(${jxaString(folder)})`
    : `app.folders.byName(${jxaString(folder)})`;

  return executeJxaWrite(`
    const app = Application("Notes");
    ${jxaFindNoteSnippet(resolved.title, resolved.accountName, resolved.creationIso)}
    const destFolder = ${folderRef};
    app.move(n, { to: destFolder });
    JSON.stringify({
      success: true,
      folder: destFolder.name(),
    });
  `);
}

export async function createFolder(
  name: string,
  account?: string
): Promise<{ success: boolean; name: string }> {
  const accountRef = account
    ? `app.accounts.byName(${jxaString(account)})`
    : "app";

  return executeJxaWrite(`
    const app = Application("Notes");
    const container = ${accountRef};
    const folder = app.make({
      new: "folder",
      at: container,
      withProperties: { name: ${jxaString(name)} }
    });
    JSON.stringify({
      success: true,
      name: folder.name(),
    });
  `);
}
