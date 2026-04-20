/**
 * Apple Notes MCP tools.
 *
 * Hybrid read strategy:
 *   - iCloud notes are in NoteStore.sqlite → SQLite for fast reads.
 *   - Exchange / Gmail / other accounts keep data in separate Core Data
 *     stores that are NOT in NoteStore.sqlite → JXA for reads.
 *   - Write operations always use JXA (database is read-only).
 *
 * Provides: listAccounts, listFolders, listNotes, getNote, searchNotes,
 * createNote, updateNote, deleteNote, moveNote, createFolder
 */

import { executeJxa, executeJxaWrite, jxaString } from "../shared/applescript.js";
import { sqliteQuery, sqlEscape, sqlLikeEscape, safeInt } from "../shared/sqlite.js";
import { isSanitizeBodies, getNotesFolders, getDefaultNotesAccount, getNotesDbPath } from "../shared/config.js";
import {
  PaginatedResult,
  paginateArray,
  paginateRows,
  CORE_DATA_EPOCH_OFFSET,
  SECONDS_PER_DAY,
  fromCoreDataTimestamp,
  stripInjectionPatterns,
  sanitizeBodyContent,
} from "../shared/types.js";

export { getNotesFolders, getDefaultNotesAccount, getNotesDbPath } from "../shared/config.js";

/** Build SQL WHERE clause for configured note folders. */
function folderWhereClause(folder?: string): string {
  if (folder) {
    return `AND f.ZTITLE2 = '${sqlEscape(folder)}'`;
  }
  const configured = getNotesFolders();
  if (configured && configured.length > 0) {
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

// ─── Read Tools ─────────────────────────────────────────────────
// Hybrid: SQLite for iCloud accounts, JXA for non-iCloud (Exchange, Gmail, etc.)

/**
 * Get the set of account names whose data lives in NoteStore.sqlite.
 * Non-iCloud accounts (Exchange, Gmail) use separate Core Data stores
 * and must be queried via JXA.
 */
async function getSqliteAccountNames(): Promise<Set<string>> {
  try {
    const db = getNotesDbPath();
    const rows = await sqliteQuery(
      db,
      `SELECT ZNAME FROM ZICCLOUDSYNCINGOBJECT
       WHERE Z_ENT = ${ENT_ACCOUNT} AND ZNAME IS NOT NULL;`
    );
    return new Set(rows.map((r) => String(r.ZNAME)));
  } catch {
    return new Set();
  }
}

export async function listAccounts(): Promise<NoteAccount[]> {
  // JXA returns all accounts (iCloud, Exchange, Gmail, etc.)
  return executeJxa<NoteAccount[]>(`
    const app = Application("Notes");
    const accounts = app.accounts();
    JSON.stringify(accounts.map(a => ({
      name: a.name(),
      identifier: a.id(),
    })));
  `);
}

export async function listFolders(
  account?: string,
  includeTrash = false
): Promise<NoteFolder[]> {
  // Try SQLite first for iCloud folders (has richer metadata)
  const sqliteAccounts = await getSqliteAccountNames();
  const results: NoteFolder[] = [];

  // SQLite path: iCloud folders (unless user requested a specific non-SQLite account)
  if (!account || sqliteAccounts.has(account)) {
    try {
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

      for (const r of rows) {
        results.push({
          name: String(r.name || ""),
          identifier: String(r.identifier || ""),
          folderType: typeof r.folder_type === "number" ? r.folder_type : 0,
          noteCount: typeof r.note_count === "number" ? r.note_count : safeInt(r.note_count ?? 0),
          accountName: String(r.account_name || ""),
        });
      }
    } catch { /* SQLite unavailable — fall through to JXA */ }
  }

  // JXA path: non-iCloud accounts (or all accounts if SQLite failed)
  const jxaAccountFilter = account ? jxaString(account) : "null";
  const jxaFolders = await executeJxa<Array<{
    name: string;
    identifier: string;
    noteCount: number;
    accountName: string;
  }>>(`
    const app = Application("Notes");
    const filterAccount = ${jxaAccountFilter};
    const accounts = filterAccount
      ? [app.accounts.byName(filterAccount)]
      : app.accounts();
    const sqliteAccounts = ${JSON.stringify([...sqliteAccounts])};
    const results = [];
    for (const acct of accounts) {
      const acctName = acct.name();
      if (sqliteAccounts.includes(acctName)) continue; // already handled via SQLite
      try {
        const folders = acct.folders();
        for (const f of folders) {
          results.push({
            name: f.name(),
            identifier: f.id(),
            noteCount: f.notes().length,
            accountName: acctName,
          });
        }
      } catch(e) { /* skip inaccessible accounts */ }
    }
    JSON.stringify(results);
  `);

  for (const f of jxaFolders) {
    // Skip trash for JXA folders (trash folder names vary by locale)
    if (!includeTrash && /recently deleted|trash/i.test(f.name)) continue;
    results.push({
      name: f.name,
      identifier: f.identifier,
      folderType: 0,
      noteCount: f.noteCount,
      accountName: f.accountName,
    });
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Fetch notes from non-iCloud accounts via JXA.
 * Returns NoteSummary objects with limited metadata (no snippet/pinned/checklist).
 */
async function listNotesViaJxa(
  sqliteAccounts: Set<string>,
  account?: string,
  folder?: string,
): Promise<NoteSummary[]> {
  const jxaAccountFilter = account ? jxaString(account) : "null";
  const jxaFolderFilter = folder ? jxaString(folder) : "null";
  const configuredFolders = getNotesFolders();
  const jxaConfiguredFolders = configuredFolders ? JSON.stringify(configuredFolders) : "null";

  return executeJxa<NoteSummary[]>(`
    const app = Application("Notes");
    const filterAccount = ${jxaAccountFilter};
    const filterFolder = ${jxaFolderFilter};
    const configuredFolders = ${jxaConfiguredFolders};
    const sqliteAccounts = ${JSON.stringify([...sqliteAccounts])};
    const results = [];
    const accounts = filterAccount
      ? [app.accounts.byName(filterAccount)]
      : app.accounts();
    for (const acct of accounts) {
      const acctName = acct.name();
      if (sqliteAccounts.includes(acctName)) continue;
      try {
        const folders = filterFolder
          ? [acct.folders.byName(filterFolder)]
          : acct.folders();
        for (const f of folders) {
          const folderName = f.name();
          if (configuredFolders && !configuredFolders.includes(folderName)) continue;
          if (/recently deleted|trash/i.test(folderName)) continue;
          const notes = f.notes();
          for (const n of notes) {
            results.push({
              identifier: n.id(),
              title: n.name(),
              snippet: "",
              creationDate: n.creationDate().toISOString(),
              modificationDate: n.modificationDate().toISOString(),
              folder: folderName,
              account: acctName,
              isPinned: false,
              isLocked: n.passwordProtected(),
              hasChecklist: false,
            });
          }
        }
      } catch(e) { /* skip inaccessible */ }
    }
    JSON.stringify(results);
  `);
}

export async function listNotes(
  folder?: string,
  account?: string,
  filter: "all" | "pinned" | "with_checklist" | "today" | "this_week" = "all",
  sort: "modified" | "created" | "title" = "modified",
  limit = 25,
  offset = 0
): Promise<PaginatedResult<NoteSummary>> {
  const sqliteAccounts = await getSqliteAccountNames();
  const isJxaOnlyAccount = account ? !sqliteAccounts.has(account) : false;

  // ── SQLite path (iCloud accounts) ──
  let sqliteItems: NoteSummary[] = [];
  let sqliteTotal = 0;

  if (!isJxaOnlyAccount) {
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
         -- Over-fetch from SQLite so we have enough rows after merging with
         -- JXA (non-iCloud) results and re-sorting the combined set.
         LIMIT ${safeInt(limit + 200)} OFFSET 0;`
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

    sqliteTotal = safeInt(countRows[0]?.total ?? 0);
    sqliteItems = rows.map((r) => ({
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
  }

  // ── JXA path (non-iCloud accounts) ──
  // Skip JXA for iCloud-only requests or filters that JXA can't handle
  let jxaItems: NoteSummary[] = [];
  const skipJxa = isJxaOnlyAccount === false && !!account; // specific iCloud account requested
  const jxaUnsupportedFilter = filter === "pinned" || filter === "with_checklist";

  if (!skipJxa && !jxaUnsupportedFilter) {
    const rawJxa = await listNotesViaJxa(sqliteAccounts, account, folder);
    // Apply date filters client-side for JXA notes
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfDay);
    startOfWeek.setDate(startOfWeek.getDate() - now.getDay());

    jxaItems = rawJxa.filter((n) => {
      if (filter === "today") return new Date(n.modificationDate) >= startOfDay;
      if (filter === "this_week") return new Date(n.modificationDate) >= startOfWeek;
      return true;
    });
  }

  // ── Merge & sort ──
  const allItems = [...sqliteItems, ...jxaItems];
  const total = sqliteTotal + jxaItems.length;

  // Sort merged results
  switch (sort) {
    case "created":
      allItems.sort((a, b) => new Date(b.creationDate).getTime() - new Date(a.creationDate).getTime());
      break;
    case "title":
      allItems.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
      break;
    default:
      allItems.sort((a, b) => new Date(b.modificationDate).getTime() - new Date(a.modificationDate).getTime());
  }

  // Apply pagination to merged results
  const paged = allItems.slice(offset, offset + limit);
  return paginateRows(paged, total, offset);
}

export async function searchNotes(
  query: string,
  scope: "title" | "snippet" | "all" = "all",
  folder?: string,
  limit = 20,
  offset = 0
): Promise<PaginatedResult<NoteSummary>> {
  const sqliteAccounts = await getSqliteAccountNames();

  // ── SQLite path (iCloud) ──
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
       -- Over-fetch from SQLite so we have enough rows after merging with
       -- JXA (non-iCloud) results and re-sorting the combined set.
       LIMIT ${safeInt(limit + 200)} OFFSET 0;`
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

  const sqliteTotal = safeInt(countRows[0]?.total ?? 0);
  const sqliteItems: NoteSummary[] = rows.map((r) => ({
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

  // ── JXA path (non-iCloud accounts): search by title via .whose() ──
  const jxaItems = await executeJxa<NoteSummary[]>(`
    const app = Application("Notes");
    const sqliteAccounts = ${JSON.stringify([...sqliteAccounts])};
    const query = ${jxaString(query)}.toLowerCase();
    const scope = ${jxaString(scope)};
    const results = [];
    for (const acct of app.accounts()) {
      const acctName = acct.name();
      if (sqliteAccounts.includes(acctName)) continue;
      try {
        // JXA .whose() only supports name matching, so always search by title
        const matches = acct.notes.whose({name: {_contains: ${jxaString(query)}}})();
        for (const n of matches) {
          const folderName = n.container().name();
          ${folder ? `if (folderName !== ${jxaString(folder)}) continue;` : ""}
          results.push({
            identifier: n.id(),
            title: n.name(),
            snippet: "",
            creationDate: n.creationDate().toISOString(),
            modificationDate: n.modificationDate().toISOString(),
            folder: folderName,
            account: acctName,
            isPinned: false,
            isLocked: n.passwordProtected(),
            hasChecklist: false,
          });
        }
      } catch(e) { /* skip */ }
    }
    JSON.stringify(results);
  `);

  // Merge and paginate
  const allItems = [...sqliteItems, ...jxaItems];
  const total = sqliteTotal + jxaItems.length;
  allItems.sort((a, b) => new Date(b.modificationDate).getTime() - new Date(a.modificationDate).getTime());
  const paged = allItems.slice(offset, offset + limit);
  return paginateRows(paged, total, offset);
}

/**
 * Check if an identifier is a JXA x-coredata URL (non-iCloud note).
 */
function isJxaIdentifier(identifier: string): boolean {
  return identifier.startsWith("x-coredata://");
}

/**
 * Get full note details including body.
 * For iCloud notes: metadata from SQLite, body via JXA.
 * For non-iCloud notes (Exchange, etc.): everything via JXA.
 */
export async function getNote(
  identifier: string,
  format: "plaintext" | "html" = "plaintext"
): Promise<NoteFull> {
  // ── JXA-only path (non-iCloud notes use x-coredata:// identifiers) ──
  if (isJxaIdentifier(identifier)) {
    return getNoteViaJxa(identifier, format);
  }

  // ── SQLite + JXA path (iCloud notes) ──
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

  let body = "";
  let shared = false;
  let attachmentCount = typeof r.attachment_count === "number"
    ? r.attachment_count
    : safeInt(r.attachment_count ?? 0);

  if (isLocked) {
    body = "[This note is password-protected. Unlock it in Notes.app to read the body.]";
  } else {
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
      ${jxaFindNoteSnippet(noteTitle, accountName, creationIso)}

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

    if (isSanitizeBodies()) {
      body = sanitizeBodyContent(body, "NOTE");
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
 * Get a note entirely via JXA (for non-iCloud accounts like Exchange/Gmail).
 * Uses the x-coredata:// ID to look up the note directly via byId().
 */
async function getNoteViaJxa(
  jxaId: string,
  format: "plaintext" | "html"
): Promise<NoteFull> {
  const result = await executeJxa<{
    identifier: string;
    title: string;
    creationDate: string;
    modificationDate: string;
    folder: string;
    account: string;
    isLocked: boolean;
    shared: boolean;
    attachmentCount: number;
    plaintext: string;
    html: string;
  }>(`
    const app = Application("Notes");
    const jxaId = ${jxaString(jxaId)};
    // Direct lookup by Core Data ID — avoids iterating all notes
    let n;
    try {
      n = app.notes.byId(jxaId);
      n.name(); // force resolution — throws if not found
    } catch(e) {
      throw new Error("Note not found");
    }
    JSON.stringify({
      identifier: n.id(),
      title: n.name(),
      creationDate: n.creationDate().toISOString(),
      modificationDate: n.modificationDate().toISOString(),
      folder: n.container().name(),
      account: n.container().container().name(),
      isLocked: n.passwordProtected(),
      shared: n.shared(),
      attachmentCount: n.attachments().length,
      plaintext: n.passwordProtected() ? "" : n.plaintext(),
      html: n.passwordProtected() ? "" : n.body(),
    });
  `);

  let body: string;
  if (result.isLocked) {
    body = "[This note is password-protected. Unlock it in Notes.app to read the body.]";
  } else {
    body = format === "html" ? result.html : result.plaintext;
    if (isSanitizeBodies()) {
      body = sanitizeBodyContent(body, "NOTE");
    } else {
      body = stripInjectionPatterns(body);
    }
  }

  return {
    identifier: result.identifier,
    title: result.title,
    snippet: "",
    creationDate: result.creationDate,
    modificationDate: result.modificationDate,
    folder: result.folder,
    account: result.account,
    isPinned: false,
    isLocked: result.isLocked,
    hasChecklist: false,
    body,
    bodyFormat: format,
    attachmentCount: result.attachmentCount,
    shared: result.shared,
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
 * Resolve a note identifier to its title, account, and creation date for JXA lookup.
 * For iCloud notes (SQLite UUID): queries NoteStore.sqlite.
 * For non-iCloud notes (x-coredata:// URL): queries JXA directly.
 */
async function resolveNoteForJxa(identifier: string): Promise<{
  title: string;
  accountName: string;
  creationIso: string;
}> {
  if (isJxaIdentifier(identifier)) {
    // Non-iCloud: resolve via direct byId() lookup
    return executeJxa(`
      const app = Application("Notes");
      const jxaId = ${jxaString(identifier)};
      let n;
      try {
        n = app.notes.byId(jxaId);
        n.name(); // force resolution — throws if not found
      } catch(e) {
        throw new Error("Note not found");
      }
      JSON.stringify({
        title: n.name(),
        accountName: n.container().container().name(),
        creationIso: n.creationDate().toISOString(),
      });
    `);
  }

  // iCloud: resolve via SQLite
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
        // SQLite and JXA may report slightly different creation timestamps
        // (Core Data vs JXA bridging). 2s tolerance handles the drift while
        // remaining tight enough to distinguish genuinely different notes.
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
