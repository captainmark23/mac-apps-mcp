/**
 * FTS5 full-text search index for Apple Mail.
 *
 * Builds and maintains a separate SQLite FTS5 index of email body content
 * by reading .emlx files from Apple Mail's on-disk storage.
 *
 * The index is stored at ~/.macos-mcp/mail-fts.db and can be rebuilt
 * at any time without affecting Apple Mail.
 *
 * Architecture:
 *   Envelope Index (Apple's DB) → message metadata (subject, sender, dates)
 *   .emlx files (on disk) → email body content
 *   mail-fts.db (our DB) → FTS5 index of body text, keyed by message ROWID
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { sqliteQuery, sqlLikeEscape } from "../shared/sqlite.js";
import { getMailDbPath, getMailDir, resolveMailAccountUuid, getDefaultMailAccount } from "../shared/config.js";
import { PaginatedResult, paginateRows } from "../shared/types.js";

const FTS_DIR = join(homedir(), ".macos-mcp");
const FTS_DB = join(FTS_DIR, "mail-fts.db");
const SQLITE3 = "/usr/bin/sqlite3";


// ─── .emlx Path Resolution ──────────────────────────────────────

/**
 * Compute the on-disk path for an .emlx file given its ROWID and mailbox URL.
 *
 * Apple Mail stores .emlx files in a directory hierarchy derived from
 * floor(ROWID / 1000) with digits reversed into nested single-digit dirs.
 *   84      → Data/Messages/84.emlx
 *   1243    → Data/1/Messages/1243.emlx
 *   548864  → Data/8/4/5/Messages/548864.emlx
 */
function emlxSubpath(rowid: number): string {
  const bucket = Math.floor(rowid / 1000);
  if (bucket === 0) return `Messages/${rowid}.emlx`;
  const digits = String(bucket).split("").reverse().join("/");
  return `${digits}/Messages/${rowid}.emlx`;
}

/**
 * Convert a mailbox URL (e.g. imap://UUID/INBOX) to a filesystem path
 * under ~/Library/Mail/V10/.
 * Handles URL-encoded names (Sent%20Items → Sent Items.mbox) and
 * nested paths ([Gmail]/All Mail → [Gmail].mbox/All Mail.mbox).
 */
function mailboxUrlToDir(url: string): string | null {
  // imap://UUID/MailboxName or ews://UUID/MailboxName or pop://...
  const match = url.match(/^(?:imap|ews|local|pop):\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  const [, accountUuid, rawMailboxName] = match;
  // Decode URL encoding and split nested path segments
  const decoded = decodeURIComponent(rawMailboxName);
  const segments = decoded.split("/");
  // Each segment gets .mbox appended: [Gmail]/All Mail → [Gmail].mbox/All Mail.mbox
  const mboxPath = segments.map((s) => `${s}.mbox`).join("/");
  return join(getMailDir(), accountUuid, mboxPath);
}

/**
 * Find the Data UUID directory inside a .mbox directory.
 * Each .mbox contains one UUID subdirectory with the actual data.
 */
function findDataDir(mboxDir: string): string | null {
  if (!existsSync(mboxDir)) return null;
  const entries = readdirSync(mboxDir);
  // Look for UUID-like directory (contains hyphens, 36 chars)
  const uuid = entries.find(
    (e) => e.length === 36 && e.includes("-") && statSync(join(mboxDir, e)).isDirectory()
  );
  if (!uuid) return null;
  return join(mboxDir, uuid, "Data");
}

/**
 * Resolve the full path to an .emlx file.
 */
function resolveEmlxPath(rowid: number, mailboxUrl: string): string | null {
  const mboxDir = mailboxUrlToDir(mailboxUrl);
  if (!mboxDir) return null;
  const dataDir = findDataDir(mboxDir);
  if (!dataDir) return null;
  const path = join(dataDir, emlxSubpath(rowid));
  return existsSync(path) ? path : null;
}

// ─── .emlx Parsing ──────────────────────────────────────────────

/**
 * Extract plain text body from an .emlx file.
 * Format: first line is byte count, then RFC 822 email, then Apple plist metadata.
 */
function parseEmlxBody(filePath: string): string {
  const buf = readFileSync(filePath);

  // First line is the byte count of the email portion
  const firstNewline = buf.indexOf(0x0a); // '\n'
  if (firstNewline === -1) return "";
  const byteCount = parseInt(buf.subarray(0, firstNewline).toString("utf-8").trim(), 10);
  if (isNaN(byteCount)) return "";

  // Extract the email portion using byte offsets, then decode to string
  const emailStart = firstNewline + 1;
  const emailContent = buf.subarray(emailStart, emailStart + byteCount).toString("utf-8");

  // Split headers from body (double newline separates them)
  const headerEnd = emailContent.indexOf("\r\n\r\n");
  const headerEnd2 = emailContent.indexOf("\n\n");
  const splitPos =
    headerEnd >= 0 && headerEnd2 >= 0
      ? Math.min(headerEnd, headerEnd2)
      : headerEnd >= 0
        ? headerEnd
        : headerEnd2;

  if (splitPos < 0) return "";

  const body = emailContent.substring(
    splitPos + (emailContent[splitPos] === "\r" ? 4 : 2)
  );

  return body;
}

/**
 * Decode quoted-printable encoding, handling multi-byte UTF-8 sequences.
 */
function decodeQuotedPrintable(text: string): string {
  // Remove soft line breaks first
  const cleaned = text.replace(/=\r?\n/g, "");
  // Collect encoded byte sequences and decode as UTF-8
  return cleaned.replace(/(?:=[0-9A-Fa-f]{2})+/g, (match) => {
    const bytes = match.split("=").filter(Boolean).map((hex) => parseInt(hex, 16));
    try {
      return Buffer.from(bytes).toString("utf-8");
    } catch {
      return match;
    }
  });
}

/**
 * Strip HTML tags and decode entities. Simple but effective for search indexing.
 */
function stripHtml(html: string): string {
  return html
    // Remove style and script blocks entirely
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    // Replace block elements with newlines
    .replace(/<\/?(p|div|br|h[1-6]|li|tr|td|th|table|blockquote)[^>]*>/gi, "\n")
    // Remove all remaining tags
    .replace(/<[^>]+>/g, "")
    // Decode common HTML entities
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    // Collapse whitespace
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
}

/**
 * Clean and truncate email body for indexing.
 * Pipeline: decode QP → strip HTML → remove noise → truncate.
 */
function cleanBodyForIndex(raw: string): string {
  // Decode quoted-printable first so HTML tags are visible for stripping
  let text = decodeQuotedPrintable(raw);
  // Strip HTML once
  text = stripHtml(text);
  // Remove long URLs
  text = text.replace(/https?:\/\/\S{50,}/g, "");
  // Remove base64 blocks
  text = text.replace(/[A-Za-z0-9+/=]{100,}/g, "");
  // Collapse whitespace again after cleanup
  text = text.replace(/\s+/g, " ").trim();
  // Limit to 10KB for indexing (plenty for search, keeps DB manageable)
  return text.substring(0, 10_000);
}

// ─── FTS5 Index Management ──────────────────────────────────────

/** Run a SQL command against the FTS database via stdin (avoids E2BIG for large SQL). */
function ftsExec(sql: string): void {
  execFileSync(SQLITE3, [FTS_DB], {
    input: sql,
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

/** Ensure the FTS database and tables exist. */
function ensureFtsDb(): void {
  if (!existsSync(FTS_DIR)) {
    mkdirSync(FTS_DIR, { recursive: true });
  }

  if (!existsSync(FTS_DB)) {
    ftsExec(`
      CREATE TABLE IF NOT EXISTS email_content (
        rowid INTEGER PRIMARY KEY,
        body TEXT NOT NULL,
        indexed_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS email_fts USING fts5(
        body,
        content='email_content',
        content_rowid='rowid'
      );
      -- Triggers to keep FTS in sync with content table
      CREATE TRIGGER IF NOT EXISTS email_content_ai AFTER INSERT ON email_content BEGIN
        INSERT INTO email_fts(rowid, body) VALUES(new.rowid, new.body);
      END;
      CREATE TRIGGER IF NOT EXISTS email_content_ad AFTER DELETE ON email_content BEGIN
        INSERT INTO email_fts(email_fts, rowid, body) VALUES('delete', old.rowid, old.body);
      END;
      CREATE TABLE IF NOT EXISTS index_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  }
}

/**
 * Get the highest ROWID we've indexed so far.
 */
async function getLastIndexedRowid(): Promise<number> {
  ensureFtsDb();
  const rows = await sqliteQuery(
    FTS_DB,
    `SELECT COALESCE(MAX(rowid), 0) as max_id FROM email_content;`
  );
  const val = rows[0]?.max_id;
  return typeof val === "number" ? val : parseInt(String(val || "0"), 10);
}

/**
 * Index new messages since the last indexed ROWID.
 * Returns the number of messages indexed.
 */
export async function indexNewMessages(limit = 5000): Promise<{
  indexed: number;
  skipped: number;
  total: number;
}> {
  ensureFtsDb();
  const lastRowid = await getLastIndexedRowid();

  // Get new messages from Envelope Index
  const messages = await sqliteQuery(
    getMailDbPath(),
    `SELECT m.ROWID, mb.url as mailbox_url
     FROM messages m
     JOIN mailboxes mb ON m.mailbox = mb.ROWID
     WHERE m.ROWID > ${lastRowid} AND m.deleted = 0
     ORDER BY m.ROWID
     LIMIT ${limit};`
  );

  let indexed = 0;
  let skipped = 0;
  const now = Math.floor(Date.now() / 1000);

  // Process in batches to avoid huge SQL statements
  const BATCH_SIZE = 100;
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    const inserts: string[] = [];

    for (const msg of batch) {
      const rowid = typeof msg.ROWID === "number" ? msg.ROWID : parseInt(String(msg.ROWID), 10);
      const mailboxUrl = String(msg.mailbox_url || "");

      const emlxPath = resolveEmlxPath(rowid, mailboxUrl);
      if (!emlxPath) {
        skipped++;
        // Insert empty body so we track it and don't retry
        inserts.push(`INSERT OR IGNORE INTO email_content(rowid, body, indexed_at) VALUES(${rowid}, '', ${now});`);
        continue;
      }

      try {
        const rawBody = parseEmlxBody(emlxPath);
        const body = cleanBodyForIndex(rawBody);
        // Use hex encoding to safely embed body in SQL (avoids all escaping issues)
        const hexBody = Buffer.from(body, "utf-8").toString("hex");
        inserts.push(`INSERT OR IGNORE INTO email_content(rowid, body, indexed_at) VALUES(${rowid}, CAST(X'${hexBody}' AS TEXT), ${now});`);
        if (body.length > 10) {
          indexed++;
        } else {
          skipped++;
        }
      } catch {
        skipped++;
        inserts.push(`INSERT OR IGNORE INTO email_content(rowid, body, indexed_at) VALUES(${rowid}, '', ${now});`);
      }
    }

    if (inserts.length > 0) {
      ftsExec(inserts.join("\n"));
    }
  }

  return { indexed, skipped, total: messages.length };
}

/**
 * Rebuild the entire FTS index from scratch.
 * Drops existing data and re-indexes all messages.
 * This can take a while for large mailboxes.
 */
export async function rebuildIndex(batchSize = 5000): Promise<{
  indexed: number;
  skipped: number;
  total: number;
}> {
  // Drop and recreate
  if (existsSync(FTS_DB)) {
    unlinkSync(FTS_DB);
    // Also remove WAL/SHM files
    try { unlinkSync(FTS_DB + "-wal"); } catch {}
    try { unlinkSync(FTS_DB + "-shm"); } catch {}
  }
  ensureFtsDb();

  // Get total message count
  const countRows = await sqliteQuery(
    getMailDbPath(),
    `SELECT COUNT(*) as cnt FROM messages WHERE deleted = 0;`
  );
  const totalMessages =
    typeof countRows[0]?.cnt === "number"
      ? countRows[0].cnt
      : parseInt(String(countRows[0]?.cnt || "0"), 10);

  let totalIndexed = 0;
  let totalSkipped = 0;
  let processed = 0;

  // Process in chunks
  while (processed < totalMessages) {
    const result = await indexNewMessages(batchSize);
    totalIndexed += result.indexed;
    totalSkipped += result.skipped;
    processed += result.total;
    if (result.total === 0) break; // No more messages
  }

  return { indexed: totalIndexed, skipped: totalSkipped, total: processed };
}

// ─── FTS5 Search ────────────────────────────────────────────────

export interface FtsSearchResult {
  id: number;
  subject: string;
  sender: string;
  dateReceived: string;
  read: boolean;
  flagged: boolean;
  snippet: string;
}

/**
 * Build a mailbox URL filter for use in Envelope Index queries.
 * Uses the shared account resolver from config.ts.
 */
async function ftsMailboxFilter(
  mailbox: string,
  account?: string
): Promise<string> {
  const effectiveAccount = account || getDefaultMailAccount();
  const encodedMailbox = sqlLikeEscape(encodeURIComponent(mailbox));

  if (effectiveAccount) {
    try {
      const { executeJxa } = await import("../shared/applescript.js");
      const uuid = await resolveMailAccountUuid(effectiveAccount, executeJxa);
      if (uuid) {
        return `mb.url LIKE '%${sqlLikeEscape(uuid)}/${encodedMailbox}' ESCAPE '\\'`;
      }
    } catch {
      // Fall through to unfiltered mailbox match
    }
  }
  return `mb.url LIKE '%/${encodedMailbox}' ESCAPE '\\'`;
}

/**
 * Search email body content using FTS5.
 * Returns results sorted by date (newest first) with text snippets and pagination.
 */
export async function searchBody(
  query: string,
  mailbox = "INBOX",
  account?: string,
  limit = 20,
  offset = 0
): Promise<PaginatedResult<FtsSearchResult>> {
  ensureFtsDb();

  const mbFilter = await ftsMailboxFilter(mailbox, account);

  // Sanitize FTS5 query: strip all quotes and FTS5 special characters
  const safeQuery = query
    .replace(/["'""''*+\-^{}():<>]/g, " ")
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!safeQuery) return paginateRows([], 0, offset);

  // Use hex encoding for the FTS5 MATCH phrase to avoid any SQL quoting issues
  const matchPhrase = `"${safeQuery}"`;
  const matchHex = Buffer.from(matchPhrase, "utf-8").toString("hex");

  // Query FTS for matching rowids — fetch extra to account for mailbox filtering
  const ftsResults = await sqliteQuery(
    FTS_DB,
    `SELECT rowid, snippet(email_fts, 0, '>>>', '<<<', '...', 40) as snippet
     FROM email_fts
     WHERE email_fts MATCH CAST(X'${matchHex}' AS TEXT)
     ORDER BY rank
     LIMIT ${(limit + offset) * 3};`
  );

  if (!ftsResults.length) return paginateRows([], 0, offset);

  // Get metadata + total count from Envelope Index for matching rowids
  const rowids = ftsResults.map((r) => r.rowid).join(",");
  const [metaRows, countRows] = await Promise.all([
    sqliteQuery(
      getMailDbPath(),
      `SELECT m.ROWID as id, s.subject, a.address as sender,
         datetime(m.date_received, 'unixepoch', 'localtime') as date_received,
         m.read, m.flagged
       FROM messages m
       JOIN subjects s ON m.subject = s.ROWID
       JOIN addresses a ON m.sender = a.ROWID
       JOIN mailboxes mb ON m.mailbox = mb.ROWID
       WHERE m.ROWID IN (${rowids})
         AND m.deleted = 0
         AND ${mbFilter}
       ORDER BY m.date_received DESC
       LIMIT ${limit} OFFSET ${offset};`
    ),
    sqliteQuery(
      getMailDbPath(),
      `SELECT COUNT(*) as total
       FROM messages m
       JOIN mailboxes mb ON m.mailbox = mb.ROWID
       WHERE m.ROWID IN (${rowids})
         AND m.deleted = 0
         AND ${mbFilter};`
    ),
  ]);

  const total =
    typeof countRows[0]?.total === "number"
      ? countRows[0].total
      : parseInt(String(countRows[0]?.total || "0"), 10);

  // Build snippet map from FTS results
  const snippetMap = new Map(
    ftsResults.map((r) => [
      typeof r.rowid === "number" ? r.rowid : parseInt(String(r.rowid), 10),
      String(r.snippet || ""),
    ])
  );

  const items = metaRows.map((r) => {
    const id = typeof r.id === "number" ? r.id : parseInt(String(r.id), 10);
    return {
      id,
      subject: String(r.subject || ""),
      sender: String(r.sender || ""),
      dateReceived: String(r.date_received || ""),
      read: r.read === 1,
      flagged: r.flagged === 1,
      snippet: snippetMap.get(id) || "",
    };
  });

  return paginateRows(items, total, offset);
}

/**
 * Get index statistics.
 */
export async function getIndexStats(): Promise<{
  indexedCount: number;
  totalMessages: number;
  lastIndexedRowid: number;
  dbSizeMb: number;
}> {
  ensureFtsDb();

  const [indexedRows, totalRows, lastRows] = await Promise.all([
    sqliteQuery(FTS_DB, `SELECT COUNT(*) as cnt FROM email_content WHERE body != '';`),
    sqliteQuery(getMailDbPath(), `SELECT COUNT(*) as cnt FROM messages WHERE deleted = 0;`),
    sqliteQuery(FTS_DB, `SELECT COALESCE(MAX(rowid), 0) as max_id FROM email_content;`),
  ]);

  let dbSize = 0;
  try {
    dbSize = statSync(FTS_DB).size / (1024 * 1024);
  } catch {}

  return {
    indexedCount:
      typeof indexedRows[0]?.cnt === "number"
        ? indexedRows[0].cnt
        : parseInt(String(indexedRows[0]?.cnt || "0"), 10),
    totalMessages:
      typeof totalRows[0]?.cnt === "number"
        ? totalRows[0].cnt
        : parseInt(String(totalRows[0]?.cnt || "0"), 10),
    lastIndexedRowid:
      typeof lastRows[0]?.max_id === "number"
        ? lastRows[0].max_id
        : parseInt(String(lastRows[0]?.max_id || "0"), 10),
    dbSizeMb: Math.round(dbSize * 10) / 10,
  };
}
