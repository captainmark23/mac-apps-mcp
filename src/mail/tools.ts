/**
 * Apple Mail MCP tools.
 *
 * Read operations use the Mail Envelope Index SQLite database for instant
 * results. Email body content is read directly from .emlx files on disk.
 * Write operations use JXA.
 *
 * Provides: list_accounts, list_mailboxes, get_emails, get_email,
 * search_mail, send_email, create_draft, reply_to, forward,
 * move_message, flag_message, mark_read
 */

import { readFileSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Maximum .emlx file size to read (50 MB). Larger files are skipped to prevent OOM. */
const MAX_EMLX_SIZE = 50 * 1024 * 1024;

/** Maximum characters of cleaned body text to return for display. */
const MAX_BODY_DISPLAY_CHARS = 50_000;

/** Maximum characters for the short body preview shown in email lists. */
const MAX_PREVIEW_CHARS = 200;

/** Maximum characters for filenames (path traversal defense). */
const MAX_FILENAME_LENGTH = 255;

/** Minimum length threshold for a long URL to be removed from body display. */
const LONG_URL_MIN_LENGTH = 100;

/** Minimum length threshold for base64/encoded content to be removed from body display. */
const ENCODED_CONTENT_MIN_LENGTH = 200;

import { executeJxa, executeJxaWrite, jxaString } from "../shared/applescript.js";
import { sqliteQuery, sqlEscape, sqlLikeEscape, safeInt } from "../shared/sqlite.js";
import {
  getDefaultMailAccount,
  getMailDbPath,
  getMailAccountMap,
  resolveMailAccountUuid,
} from "../shared/config.js";
import { PaginatedResult, paginateRows, sanitizeErrorMessage } from "../shared/types.js";
import {
  resolveEmlxPath,
  parseEmlxBody,
  decodeQuotedPrintable,
  stripHtml,
} from "./fts.js";

/** Build SQL filter for account-specific mailbox URL matching. */
async function accountMailboxFilter(
  mailbox: string,
  account?: string
): Promise<string> {
  const effectiveAccount = account || getDefaultMailAccount();
  const encodedMailbox = sqlLikeEscape(encodeURIComponent(mailbox));

  if (effectiveAccount) {
    const uuid = await resolveMailAccountUuid(effectiveAccount, executeJxa);
    if (uuid) {
      return `mb.url LIKE '%${sqlLikeEscape(uuid)}/${encodedMailbox}' ESCAPE '\\'`;
    }
  }
  return `mb.url LIKE '%/${encodedMailbox}' ESCAPE '\\'`;
}

/** Parse a mailbox URL into account ID and mailbox name. */
export function parseMailboxUrl(url: string): { accountId: string; mailboxName: string } | null {
  const match = url.match(/^(?:imap|ews|local|pop):\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  let mailboxName: string;
  try {
    mailboxName = decodeURIComponent(match[2]);
  } catch {
    // Malformed percent-encoding — fall back to raw string
    mailboxName = match[2];
  }
  return {
    accountId: match[1],
    mailboxName,
  };
}

/** Extract key headers (Message-ID, Reply-To) from an .emlx file. */
function parseEmlxHeaders(filePath: string): { messageId: string; replyTo: string } {
  try {
    const st = statSync(filePath);
    if (st.size > MAX_EMLX_SIZE) {
      return { messageId: "", replyTo: "" };
    }
    const buf = readFileSync(filePath);
    const firstNewline = buf.indexOf(0x0a);
    if (firstNewline === -1) return { messageId: "", replyTo: "" };
    const byteCount = parseInt(buf.subarray(0, firstNewline).toString("utf-8").trim(), 10);
    if (isNaN(byteCount)) return { messageId: "", replyTo: "" };

    const emailStart = firstNewline + 1;
    const emailContent = buf.subarray(emailStart, emailStart + byteCount).toString("utf-8");

    const headerEnd = emailContent.indexOf("\r\n\r\n");
    const headerEnd2 = emailContent.indexOf("\n\n");
    const splitPos =
      headerEnd >= 0 && headerEnd2 >= 0
        ? Math.min(headerEnd, headerEnd2)
        : headerEnd >= 0
          ? headerEnd
          : headerEnd2;
    if (splitPos < 0) return { messageId: "", replyTo: "" };

    const headerBlock = emailContent.substring(0, splitPos);
    // Unfold continuation lines (RFC 2822)
    const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, " ");

    let messageId = "";
    let replyTo = "";
    for (const line of unfolded.split(/\r?\n/)) {
      const lower = line.toLowerCase();
      if (lower.startsWith("message-id:")) {
        messageId = line.substring(11).trim();
      } else if (lower.startsWith("reply-to:")) {
        replyTo = line.substring(9).trim();
      }
    }
    return { messageId, replyTo };
  } catch {
    return { messageId: "", replyTo: "" };
  }
}

/** Clean raw .emlx body for display (more generous limit than FTS indexing). */
export function cleanBodyForDisplay(raw: string): string {
  let text = decodeQuotedPrintable(raw);
  text = stripHtml(text);
  text = text.replace(new RegExp(`https?:\\/\\/\\S{${LONG_URL_MIN_LENGTH},}`, "g"), "[long URL removed]");
  text = text.replace(new RegExp(`[A-Za-z0-9+/=]{${ENCODED_CONTENT_MIN_LENGTH},}`, "g"), "[encoded content removed]");
  text = text.replace(/\s+/g, " ").trim();
  return text.substring(0, MAX_BODY_DISPLAY_CHARS);
}

/** Get a short body preview for an email (first ~200 chars of cleaned body). */
function getBodyPreview(messageId: number, mailboxUrl: string): string {
  try {
    const emlxPath = resolveEmlxPath(messageId, mailboxUrl);
    if (!emlxPath) return "";
    const rawBody = parseEmlxBody(emlxPath);
    let text = decodeQuotedPrintable(rawBody);
    text = stripHtml(text);
    text = text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
    return text.substring(0, MAX_PREVIEW_CHARS);
  } catch {
    return "";
  }
}

/**
 * Resolve the mailbox name and account name for a message from SQLite.
 * Used by write operations so callers don't need to guess the right mailbox/account.
 */
async function resolveMessageLocation(
  messageId: number
): Promise<{ mailboxName: string; accountName: string }> {
  const db = getMailDbPath();
  const rows = await sqliteQuery(
    db,
    `SELECT mb.url as mailbox_url
     FROM messages m
     JOIN mailboxes mb ON m.mailbox = mb.ROWID
     WHERE m.ROWID = ${safeInt(messageId)} AND m.deleted = 0
     LIMIT 1;`
  );
  if (!rows.length) throw new Error(`Message not found: ${safeInt(messageId)}`);

  const mailboxUrl = String(rows[0].mailbox_url || "");
  const parsed = parseMailboxUrl(mailboxUrl);
  if (!parsed) throw new Error(`Cannot resolve mailbox for message ${safeInt(messageId)}`);

  const accountMap = await getMailAccountMap(executeJxa);
  const accountName = accountMap.get(parsed.accountId);
  if (!accountName) throw new Error(`Cannot resolve account for message ${safeInt(messageId)}`);

  return { mailboxName: parsed.mailboxName, accountName };
}

// ─── Attachment Metadata ─────────────────────────────────────────

/** Cache whether the attachments table exists in the Envelope Index. */
let _attachmentsTableExists: boolean | null = null;

/**
 * Query attachment metadata from the Envelope Index (if the table exists)
 * or fall back to parsing MIME headers from the .emlx file.
 */
async function queryAttachmentMetadata(
  messageId: number,
  mailboxUrl: string
): Promise<{ filename: string; mimeType: string; size: number }[]> {
  const db = getMailDbPath();

  // Check if attachments table exists (cached after first check)
  if (_attachmentsTableExists === null) {
    try {
      const tables = await sqliteQuery(
        db,
        `SELECT name FROM sqlite_master WHERE type='table' AND name='attachments';`
      );
      _attachmentsTableExists = tables.length > 0;
    } catch {
      _attachmentsTableExists = false;
    }
  }

  if (_attachmentsTableExists) {
    try {
      const rows = await sqliteQuery(
        db,
        `SELECT name
         FROM attachments
         WHERE message = ${safeInt(messageId)};`
      );
      if (rows.length > 0) {
        // DB only stores name; get type/size from MIME fallback and merge
        const mimeInfo = parseAttachmentHeaders(messageId, mailboxUrl);
        return rows.map((r, i) => {
          const name = sanitizeFilename(String(r.name || "unknown"));
          const mime = mimeInfo.find((m) => m.filename === name) || mimeInfo[i];
          return {
            filename: name,
            mimeType: mime?.mimeType || "application/octet-stream",
            size: mime?.size || 0,
          };
        });
      }
    } catch (e) {
      // Fall through to MIME parsing; log so DB errors aren't silently lost
      console.error(`[mail] attachment query failed for message ${safeInt(messageId)}, falling back to MIME:`, sanitizeErrorMessage(String(e)));
    }
  }

  // Fallback: parse MIME headers from .emlx file
  return parseAttachmentHeaders(messageId, mailboxUrl);
}

/** Strip path traversal and limit filename length for safety. */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/\.\./g, "")
    .replace(/[/\\]/g, "_")
    .substring(0, MAX_FILENAME_LENGTH);
}

/**
 * Extract attachment metadata from MIME headers in an .emlx file.
 * Scans for Content-Disposition: attachment parts.
 */
function parseAttachmentHeaders(
  messageId: number,
  mailboxUrl: string
): { filename: string; mimeType: string; size: number }[] {
  try {
    const emlxPath = resolveEmlxPath(messageId, mailboxUrl);
    if (!emlxPath) return [];

    const st = statSync(emlxPath);
    if (st.size > MAX_EMLX_SIZE) {
      return [];
    }
    const buf = readFileSync(emlxPath);
    const firstNewline = buf.indexOf(0x0a);
    if (firstNewline === -1) return [];
    const byteCount = parseInt(buf.subarray(0, firstNewline).toString("utf-8").trim(), 10);
    if (isNaN(byteCount)) return [];

    const emailStart = firstNewline + 1;
    const emailContent = buf.subarray(emailStart, emailStart + byteCount).toString("utf-8");

    const attachments: { filename: string; mimeType: string; size: number }[] = [];

    // Split on MIME boundaries and look for attachment parts
    // Boundaries can contain alphanumeric, hyphens, plus, equals, underscores, etc.
    const parts = emailContent.split(/^--[\w\-+='.()/:? ]+$/m);
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (!lower.includes("content-disposition") || !lower.includes("attachment")) continue;

      // Extract filename from Content-Disposition or Content-Type
      let filename = "unknown";
      const fnMatch = part.match(/filename\*?=(?:UTF-8''|"?)([^";\r\n]+)/i);
      if (fnMatch) {
        filename = decodeURIComponent(fnMatch[1].replace(/^"/, "").replace(/"$/, "").trim());
      }

      // Extract MIME type from Content-Type
      let mimeType = "application/octet-stream";
      const ctMatch = part.match(/Content-Type:\s*([^\s;]+)/i);
      if (ctMatch) {
        mimeType = ctMatch[1].trim();
      }

      // Estimate size from the encoded content length
      const headerEnd = part.indexOf("\r\n\r\n") >= 0
        ? part.indexOf("\r\n\r\n") + 4
        : part.indexOf("\n\n") >= 0
          ? part.indexOf("\n\n") + 2
          : -1;
      const size = headerEnd >= 0 ? Math.floor((part.length - headerEnd) * 0.75) : 0;

      attachments.push({
        filename: sanitizeFilename(filename),
        mimeType,
        size: Math.max(0, size),
      });
    }

    return attachments;
  } catch {
    return [];
  }
}

// ─── Types ───────────────────────────────────────────────────────

export interface Account {
  name: string;
  id: string;
}

export interface Mailbox {
  name: string;
  unreadCount: number;
}

export interface EmailSummary {
  id: number;
  subject: string;
  sender: string;
  dateReceived: string;
  read: boolean;
  flagged: boolean;
  mailbox: string;
  account: string;
  preview: string;
}

export interface AttachmentMeta {
  filename: string;
  mimeType: string;
  size: number;
}

export interface EmailFull extends EmailSummary {
  content: string;
  dateSent: string;
  replyTo: string;
  messageId: string;
  to: string[];
  cc: string[];
  attachments: AttachmentMeta[];
}

// PaginatedResult<T> imported from shared/types.ts
export type { PaginatedResult } from "../shared/types.js";

// ─── Read Tools (SQLite for listing/search, .emlx for body) ─────

export async function listAccounts(): Promise<Account[]> {
  return executeJxa<Account[]>(`
    const Mail = Application("Mail");
    const accounts = Mail.accounts();
    JSON.stringify(accounts.map(a => ({
      name: a.name(),
      id: a.id()
    })));
  `);
}

export async function listMailboxes(account?: string): Promise<Mailbox[]> {
  const acctSetup = account
    ? `const acct = Mail.accounts.byName(${jxaString(account)});`
    : `const acct = Mail.accounts[0];`;

  return executeJxa<Mailbox[]>(`
    const Mail = Application("Mail");
    ${acctSetup}
    const mbs = acct.mailboxes();
    JSON.stringify(mbs.map(mb => ({
      name: mb.name(),
      unreadCount: mb.unreadCount()
    })));
  `);
}

export async function getEmails(
  mailbox?: string,
  account?: string,
  filter: "all" | "unread" | "flagged" | "today" | "this_week" = "all",
  limit = 50,
  offset = 0
): Promise<PaginatedResult<EmailSummary>> {
  const db = getMailDbPath();
  let filterSql = "";
  if (filter === "unread") filterSql = "AND m.read = 0";
  else if (filter === "flagged") filterSql = "AND m.flagged = 1";
  else if (filter === "today") {
    filterSql = `AND m.date_received >= strftime('%s','now','start of day')`;
  } else if (filter === "this_week") {
    filterSql = `AND m.date_received >= strftime('%s','now','-7 days')`;
  }

  let mbFilterSql = "";
  if (mailbox) {
    const mbFilter = await accountMailboxFilter(mailbox, account);
    mbFilterSql = `AND ${mbFilter}`;
  }

  const accountMap = await getMailAccountMap(executeJxa);

  const [rows, countRows] = await Promise.all([
    sqliteQuery(
      db,
      `SELECT m.ROWID as id, s.subject, a.address as sender,
         datetime(m.date_received, 'unixepoch', 'localtime') as date_received,
         m.read, m.flagged, mb.url as mailbox_url
       FROM messages m
       LEFT JOIN subjects s ON m.subject = s.ROWID
       LEFT JOIN addresses a ON m.sender = a.ROWID
       JOIN mailboxes mb ON m.mailbox = mb.ROWID
       WHERE m.deleted = 0
         ${mbFilterSql}
         ${filterSql}
       ORDER BY m.date_received DESC
       LIMIT ${safeInt(limit)} OFFSET ${safeInt(offset)};`
    ),
    sqliteQuery(
      db,
      `SELECT COUNT(*) as total
       FROM messages m
       JOIN mailboxes mb ON m.mailbox = mb.ROWID
       WHERE m.deleted = 0
         ${mbFilterSql}
         ${filterSql};`
    ),
  ]);

  const total = safeInt(countRows[0]?.total ?? 0);

  const items = rows.map((r) => {
    const parsed = parseMailboxUrl(String(r.mailbox_url || ""));
    const id = safeInt(r.id);
    return {
      id,
      subject: String(r.subject || ""),
      sender: String(r.sender || ""),
      dateReceived: String(r.date_received || ""),
      read: r.read === 1,
      flagged: r.flagged === 1,
      mailbox: parsed?.mailboxName || "",
      account: (parsed ? accountMap.get(parsed.accountId) : undefined) || "",
      preview: getBodyPreview(id, String(r.mailbox_url || "")),
    };
  });

  return paginateRows(items, total, offset);
}

export async function getEmail(
  messageId: number
): Promise<EmailFull> {
  const db = getMailDbPath();

  const rows = await sqliteQuery(
    db,
    `SELECT m.ROWID as id, s.subject, a.address as sender,
       datetime(m.date_received, 'unixepoch', 'localtime') as date_received,
       datetime(m.date_sent, 'unixepoch', 'localtime') as date_sent,
       m.read, m.flagged, mb.url as mailbox_url
     FROM messages m
     LEFT JOIN subjects s ON m.subject = s.ROWID
     LEFT JOIN addresses a ON m.sender = a.ROWID
     JOIN mailboxes mb ON m.mailbox = mb.ROWID
     WHERE m.ROWID = ${safeInt(messageId)}
     LIMIT 1;`
  );

  if (!rows.length) throw new Error(`Message not found: ${safeInt(messageId)}`);
  const r = rows[0];
  const mailboxUrl = String(r.mailbox_url || "");
  const parsed = parseMailboxUrl(mailboxUrl);

  const [toRows, ccRows] = await Promise.all([
    sqliteQuery(
      db,
      `SELECT a.address
       FROM recipients rc
       JOIN addresses a ON rc.address = a.ROWID
       WHERE rc.message = ${safeInt(messageId)} AND rc.type = 0;`
    ),
    sqliteQuery(
      db,
      `SELECT a.address
       FROM recipients rc
       JOIN addresses a ON rc.address = a.ROWID
       WHERE rc.message = ${safeInt(messageId)} AND rc.type = 1;`
    ),
  ]);

  // Read body and headers directly from .emlx file (fast, no JXA needed)
  let content = "";
  let replyTo = "";
  let msgId = "";

  const emlxPath = resolveEmlxPath(safeInt(messageId), mailboxUrl);
  if (emlxPath) {
    try {
      const rawBody = parseEmlxBody(emlxPath);
      content = cleanBodyForDisplay(rawBody);
      const headers = parseEmlxHeaders(emlxPath);
      replyTo = headers.replyTo;
      msgId = headers.messageId;
    } catch {
      content = "(Body content unavailable)";
    }
  } else {
    // Fallback: try JXA for messages not yet downloaded to disk
    try {
      const mailboxName = parsed?.mailboxName || "INBOX";
      const accountMap = await getMailAccountMap(executeJxa);
      const accountName = parsed ? accountMap.get(parsed.accountId) : undefined;

      const acctSetup = accountName
        ? `const acct = Mail.accounts.byName(${jxaString(accountName)});`
        : `const acct = Mail.accounts[0];`;

      const bodyResult = await executeJxa<{
        content: string;
        replyTo: string;
        messageId: string;
      }>(`
        const Mail = Application("Mail");
        ${acctSetup}
        const mb = acct.mailboxes.byName(${jxaString(mailboxName)});
        const ids = mb.messages.id();
        const idx = ids.indexOf(${safeInt(messageId)});
        if (idx === -1) throw new Error("Message not found via JXA");
        const m = mb.messages[idx];
        JSON.stringify({
          content: m.content() || "",
          replyTo: m.replyTo() || "",
          messageId: m.messageId() || ""
        });
      `);
      content = bodyResult.content;
      replyTo = bodyResult.replyTo;
      msgId = bodyResult.messageId;
    } catch {
      content = "(Body content unavailable — email may not be downloaded)";
    }
  }

  // Get attachment metadata
  const attachments = await queryAttachmentMetadata(safeInt(messageId), mailboxUrl);

  const accountMap = await getMailAccountMap(executeJxa);

  return {
    id: safeInt(r.id),
    subject: String(r.subject || ""),
    sender: String(r.sender || ""),
    dateReceived: String(r.date_received || ""),
    dateSent: String(r.date_sent || ""),
    read: r.read === 1,
    flagged: r.flagged === 1,
    content,
    replyTo,
    messageId: msgId,
    to: toRows.map((t) => String(t.address || "")),
    cc: ccRows.map((c) => String(c.address || "")),
    mailbox: parsed?.mailboxName || "",
    account: (parsed ? accountMap.get(parsed.accountId) : undefined) || "",
    preview: content.substring(0, MAX_PREVIEW_CHARS),
    attachments,
  };
}

export async function searchMail(
  query: string,
  scope: "subject" | "sender" | "all" = "all",
  mailbox?: string,
  account?: string,
  limit = 20,
  offset = 0
): Promise<PaginatedResult<EmailSummary>> {
  const db = getMailDbPath();
  const safeQuery = sqlLikeEscape(query.toLowerCase());

  let mbFilterSql = "";
  if (mailbox) {
    const mbFilter = await accountMailboxFilter(mailbox, account);
    mbFilterSql = `AND ${mbFilter}`;
  }

  let scopeSql: string;
  if (scope === "subject") {
    scopeSql = `AND LOWER(s.subject) LIKE '%${safeQuery}%' ESCAPE '\\'`;
  } else if (scope === "sender") {
    scopeSql = `AND LOWER(a.address) LIKE '%${safeQuery}%' ESCAPE '\\'`;
  } else {
    scopeSql = `AND (LOWER(s.subject) LIKE '%${safeQuery}%' ESCAPE '\\' OR LOWER(a.address) LIKE '%${safeQuery}%' ESCAPE '\\')`;
  }

  const accountMap = await getMailAccountMap(executeJxa);

  const [rows, countRows] = await Promise.all([
    sqliteQuery(
      db,
      `SELECT m.ROWID as id, s.subject, a.address as sender,
         datetime(m.date_received, 'unixepoch', 'localtime') as date_received,
         m.read, m.flagged, mb.url as mailbox_url
       FROM messages m
       LEFT JOIN subjects s ON m.subject = s.ROWID
       LEFT JOIN addresses a ON m.sender = a.ROWID
       JOIN mailboxes mb ON m.mailbox = mb.ROWID
       WHERE m.deleted = 0
         ${mbFilterSql}
         ${scopeSql}
       ORDER BY m.date_received DESC
       LIMIT ${safeInt(limit)} OFFSET ${safeInt(offset)};`
    ),
    sqliteQuery(
      db,
      `SELECT COUNT(*) as total
       FROM messages m
       LEFT JOIN subjects s ON m.subject = s.ROWID
       LEFT JOIN addresses a ON m.sender = a.ROWID
       JOIN mailboxes mb ON m.mailbox = mb.ROWID
       WHERE m.deleted = 0
         ${mbFilterSql}
         ${scopeSql};`
    ),
  ]);

  const total = safeInt(countRows[0]?.total ?? 0);

  const items = rows.map((r) => {
    const parsed = parseMailboxUrl(String(r.mailbox_url || ""));
    const id = safeInt(r.id);
    return {
      id,
      subject: String(r.subject || ""),
      sender: String(r.sender || ""),
      dateReceived: String(r.date_received || ""),
      read: r.read === 1,
      flagged: r.flagged === 1,
      mailbox: parsed?.mailboxName || "",
      account: (parsed ? accountMap.get(parsed.accountId) : undefined) || "",
      preview: getBodyPreview(id, String(r.mailbox_url || "")),
    };
  });

  return paginateRows(items, total, offset);
}

// ─── HTML Email via iCloud SMTP ──────────────────────────────────

/** Keychain service name for the iCloud SMTP app-specific password. */
const SMTP_KEYCHAIN_SERVICE = "macos-mcp-smtp";
const SMTP_HOST = "smtp.mail.me.com";
const SMTP_PORT = 587;
const SMTP_USER = "markdphillips@mac.com";

/** Retrieve the SMTP password from macOS Keychain. */
function getSmtpPassword(): string {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  const result = execFileSync(
    "/usr/bin/security",
    ["find-generic-password", "-s", SMTP_KEYCHAIN_SERVICE, "-a", SMTP_USER, "-w"],
    { timeout: 5000 }
  );
  return result.toString().trim();
}

/**
 * Send an HTML email via iCloud SMTP using Python3's smtplib.
 * Reads SMTP credentials from macOS Keychain. Constructs a proper
 * multipart/alternative MIME message with text/plain and text/html.
 */
async function sendHtmlViaSmtp(opts: {
  to: string[];
  subject: string;
  body: string;
  htmlBody: string;
  cc?: string[];
  bcc?: string[];
}): Promise<{ success: boolean; message: string }> {
  const password = getSmtpPassword();

  // Write HTML and plain text to temp files to avoid shell escaping issues
  const id = randomUUID();
  const htmlFile = join(tmpdir(), `macos-mcp-html-${id}.html`);
  const textFile = join(tmpdir(), `macos-mcp-text-${id}.txt`);

  try {
    writeFileSync(htmlFile, opts.htmlBody, "utf-8");
    writeFileSync(textFile, opts.body, "utf-8");

    const allRecipients = [...opts.to, ...(opts.cc || []), ...(opts.bcc || [])];

    const pyScript = `
import smtplib, json, sys
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

with open(${JSON.stringify(textFile)}, 'r') as f:
    plain = f.read()
with open(${JSON.stringify(htmlFile)}, 'r') as f:
    html = f.read()

msg = MIMEMultipart('alternative')
msg['From'] = ${JSON.stringify(SMTP_USER)}
msg['To'] = ${JSON.stringify(opts.to.join(", "))}
${opts.cc?.length ? `msg['Cc'] = ${JSON.stringify(opts.cc.join(", "))}` : ""}
msg['Subject'] = ${JSON.stringify(opts.subject)}
msg.attach(MIMEText(plain, 'plain', 'utf-8'))
msg.attach(MIMEText(html, 'html', 'utf-8'))

with smtplib.SMTP(${JSON.stringify(SMTP_HOST)}, ${SMTP_PORT}) as s:
    s.starttls()
    s.login(${JSON.stringify(SMTP_USER)}, ${JSON.stringify(password)})
    s.sendmail(${JSON.stringify(SMTP_USER)}, ${JSON.stringify(allRecipients)}, msg.as_string())
`;

    await new Promise<void>((resolve, reject) => {
      execFileCb(
        "/usr/bin/python3",
        ["-c", pyScript],
        { timeout: 30000 },
        (err, _stdout, stderr) => {
          if (err) reject(new Error(`SMTP send failed: ${stderr?.toString().trim() || err.message}`));
          else resolve();
        }
      );
    });

    return { success: true, message: "HTML email sent" };
  } finally {
    try { unlinkSync(htmlFile); } catch {}
    try { unlinkSync(textFile); } catch {}
  }
}

// ─── Write Tools (JXA — requires Mail.app, serialized via queue) ─

export async function sendEmail(
  to: string[],
  subject: string,
  body: string,
  cc?: string[],
  bcc?: string[],
  account?: string,
  htmlBody?: string
): Promise<{ success: boolean; message: string }> {
  // Use iCloud SMTP for HTML emails (Apple Mail's scripting strips HTML from outgoing)
  if (htmlBody) {
    return sendHtmlViaSmtp({ to, subject, body, htmlBody, cc, bcc });
  }

  const acctSetup = account
    ? `const acct = Mail.accounts.byName(${jxaString(account)});`
    : `const acct = Mail.accounts[0];`;

  const ccBlock = cc?.length
    ? `for (const addr of JSON.parse(${jxaString(JSON.stringify(cc))})) {
         const r = Mail.CcRecipient({ address: addr });
         msg.ccRecipients.push(r);
       }`
    : "";

  const bccBlock = bcc?.length
    ? `for (const addr of JSON.parse(${jxaString(JSON.stringify(bcc))})) {
         const r = Mail.BccRecipient({ address: addr });
         msg.bccRecipients.push(r);
       }`
    : "";

  return executeJxaWrite(`
    const Mail = Application("Mail");
    ${acctSetup}
    const msg = Mail.OutgoingMessage({
      subject: ${jxaString(subject)},
      content: ${jxaString(body)},
      sender: acct.emailAddresses()[0]
    });
    Mail.outgoingMessages.push(msg);
    for (const addr of JSON.parse(${jxaString(JSON.stringify(to))})) {
      const r = Mail.ToRecipient({ address: addr });
      msg.toRecipients.push(r);
    }
    ${ccBlock}
    ${bccBlock}
    msg.send();
    JSON.stringify({ success: true, message: "Email sent" });
  `);
}

export async function createDraft(
  to: string[],
  subject: string,
  body: string,
  cc?: string[],
  account?: string,
  htmlBody?: string
): Promise<{ success: boolean; message: string }> {
  // Use iCloud SMTP for HTML drafts — sends immediately since Mail.app can't compose HTML drafts
  if (htmlBody) {
    return sendHtmlViaSmtp({ to, subject, body, htmlBody, cc });
  }

  const acctSetup = account
    ? `const acct = Mail.accounts.byName(${jxaString(account)});`
    : `const acct = Mail.accounts[0];`;

  const ccBlock = cc?.length
    ? `for (const addr of JSON.parse(${jxaString(JSON.stringify(cc))})) {
         const r = Mail.CcRecipient({ address: addr });
         msg.ccRecipients.push(r);
       }`
    : "";

  return executeJxaWrite(`
    const Mail = Application("Mail");
    ${acctSetup}
    const msg = Mail.OutgoingMessage({
      subject: ${jxaString(subject)},
      content: ${jxaString(body)},
      sender: acct.emailAddresses()[0],
      visible: true
    });
    Mail.outgoingMessages.push(msg);
    for (const addr of JSON.parse(${jxaString(JSON.stringify(to))})) {
      const r = Mail.ToRecipient({ address: addr });
      msg.toRecipients.push(r);
    }
    ${ccBlock}
    JSON.stringify({ success: true, message: "Draft created — review in Mail.app" });
  `);
}

export async function replyTo(
  messageId: number,
  body: string,
  replyAll = false,
  send = true,
  mailbox?: string,
  account?: string,
  htmlBody?: string
): Promise<{ success: boolean; message: string }> {
  if (!mailbox || !account) {
    const loc = await resolveMessageLocation(messageId);
    mailbox = mailbox || loc.mailboxName;
    account = account || loc.accountName;
  }

  const acctSetup = `const acct = Mail.accounts.byName(${jxaString(account)});`;

  // Note: htmlBody is accepted but ignored for replies — JXA htmlContent is read-only
  // on outgoing messages. Replies use plain text body. HTML replies would need MIME approach
  // with thread context, which is not yet implemented.

  return executeJxaWrite(`
    const Mail = Application("Mail");
    ${acctSetup}
    const mb = acct.mailboxes.byName(${jxaString(mailbox)});
    const ids = mb.messages.id();
    const idx = ids.indexOf(${safeInt(messageId)});
    if (idx === -1) throw new Error("Message not found");
    const msg = mb.messages[idx];
    const reply = msg.reply({ replyToAll: ${Boolean(replyAll)}, openingWindow: ${!Boolean(send)} });
    if (reply) {
      reply.content = ${jxaString(body)} + "\\n\\n" + reply.content();
      ${send ? "reply.send();" : ""}
    }
    JSON.stringify({
      success: true,
      message: ${send ? '"Reply sent"' : '"Reply draft created — review in Mail.app"'}
    });
  `);
}

export async function forwardMessage(
  messageId: number,
  to: string[],
  body?: string,
  send = true,
  mailbox?: string,
  account?: string,
  htmlBody?: string
): Promise<{ success: boolean; message: string }> {
  if (!mailbox || !account) {
    const loc = await resolveMessageLocation(messageId);
    mailbox = mailbox || loc.mailboxName;
    account = account || loc.accountName;
  }

  const acctSetup = `const acct = Mail.accounts.byName(${jxaString(account)});`;

  // Note: htmlBody is accepted but ignored for forwards — JXA htmlContent is read-only
  const fwdContentBlock = body
    ? `fwd.content = ${jxaString(body)} + "\\n\\n" + fwd.content();`
    : "";

  return executeJxaWrite(`
    const Mail = Application("Mail");
    ${acctSetup}
    const mb = acct.mailboxes.byName(${jxaString(mailbox)});
    const ids = mb.messages.id();
    const idx = ids.indexOf(${safeInt(messageId)});
    if (idx === -1) throw new Error("Message not found");
    const msg = mb.messages[idx];
    const fwd = msg.forward({ openingWindow: ${!Boolean(send)} });
    if (fwd) {
      for (const addr of JSON.parse(${jxaString(JSON.stringify(to))})) {
        const r = Mail.ToRecipient({ address: addr });
        fwd.toRecipients.push(r);
      }
      ${fwdContentBlock}
      ${send ? "fwd.send();" : ""}
    }
    JSON.stringify({
      success: true,
      message: ${send ? '"Message forwarded"' : '"Forward draft created — review in Mail.app"'}
    });
  `);
}

export async function moveMessage(
  messageId: number,
  targetMailbox: string,
  sourceMailbox?: string,
  account?: string
): Promise<{ success: boolean }> {
  if (!sourceMailbox || !account) {
    const loc = await resolveMessageLocation(messageId);
    sourceMailbox = sourceMailbox || loc.mailboxName;
    account = account || loc.accountName;
  }

  const acctSetup = `const acct = Mail.accounts.byName(${jxaString(account)});`;

  return executeJxaWrite(`
    const Mail = Application("Mail");
    ${acctSetup}
    const srcMb = acct.mailboxes.byName(${jxaString(sourceMailbox)});
    const tgtMb = acct.mailboxes.byName(${jxaString(targetMailbox)});
    const ids = srcMb.messages.id();
    const idx = ids.indexOf(${safeInt(messageId)});
    if (idx === -1) throw new Error("Message not found");
    Mail.move(srcMb.messages[idx], { to: tgtMb });
    JSON.stringify({ success: true });
  `);
}

export async function setMessageFlags(
  messageId: number,
  flagged?: boolean,
  read?: boolean,
  mailbox?: string,
  account?: string
): Promise<{ success: boolean }> {
  if (!mailbox || !account) {
    const loc = await resolveMessageLocation(messageId);
    mailbox = mailbox || loc.mailboxName;
    account = account || loc.accountName;
  }

  const acctSetup = `const acct = Mail.accounts.byName(${jxaString(account)});`;

  const flagOps: string[] = [];
  if (flagged !== undefined) flagOps.push(`m.flaggedStatus = ${Boolean(flagged)};`);
  if (read !== undefined) flagOps.push(`m.readStatus = ${Boolean(read)};`);

  return executeJxaWrite(`
    const Mail = Application("Mail");
    ${acctSetup}
    const mb = acct.mailboxes.byName(${jxaString(mailbox)});
    const ids = mb.messages.id();
    const idx = ids.indexOf(${safeInt(messageId)});
    if (idx === -1) throw new Error("Message not found");
    const m = mb.messages[idx];
    ${flagOps.join("\n    ")}
    JSON.stringify({ success: true });
  `);
}
