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

import { readFileSync } from "node:fs";
import { executeJxa, executeJxaWrite, jxaString } from "../shared/applescript.js";
import { sqliteQuery, sqlEscape, sqlLikeEscape, safeInt } from "../shared/sqlite.js";
import {
  getDefaultMailAccount,
  getMailDbPath,
  getMailAccountMap,
  resolveMailAccountUuid,
} from "../shared/config.js";
import { PaginatedResult, paginateRows } from "../shared/types.js";
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
function parseMailboxUrl(url: string): { accountId: string; mailboxName: string } | null {
  const match = url.match(/^(?:imap|ews|local|pop):\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return {
    accountId: match[1],
    mailboxName: decodeURIComponent(match[2]),
  };
}

/** Extract key headers (Message-ID, Reply-To) from an .emlx file. */
function parseEmlxHeaders(filePath: string): { messageId: string; replyTo: string } {
  try {
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
function cleanBodyForDisplay(raw: string): string {
  let text = decodeQuotedPrintable(raw);
  text = stripHtml(text);
  text = text.replace(/https?:\/\/\S{100,}/g, "[long URL removed]");
  text = text.replace(/[A-Za-z0-9+/=]{200,}/g, "[encoded content removed]");
  text = text.replace(/\s+/g, " ").trim();
  return text.substring(0, 50_000);
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
}

export interface EmailFull extends EmailSummary {
  content: string;
  dateSent: string;
  replyTo: string;
  messageId: string;
  to: string[];
  cc: string[];
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
       JOIN subjects s ON m.subject = s.ROWID
       JOIN addresses a ON m.sender = a.ROWID
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
    return {
      id: safeInt(r.id),
      subject: String(r.subject || ""),
      sender: String(r.sender || ""),
      dateReceived: String(r.date_received || ""),
      read: r.read === 1,
      flagged: r.flagged === 1,
      mailbox: parsed?.mailboxName || "",
      account: (parsed ? accountMap.get(parsed.accountId) : undefined) || "",
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
     JOIN subjects s ON m.subject = s.ROWID
     JOIN addresses a ON m.sender = a.ROWID
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
       JOIN addresses a ON rc.address_id = a.ROWID
       WHERE rc.message_id = ${safeInt(messageId)} AND rc.type = 0;`
    ),
    sqliteQuery(
      db,
      `SELECT a.address
       FROM recipients rc
       JOIN addresses a ON rc.address_id = a.ROWID
       WHERE rc.message_id = ${safeInt(messageId)} AND rc.type = 1;`
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
       JOIN subjects s ON m.subject = s.ROWID
       JOIN addresses a ON m.sender = a.ROWID
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
       JOIN subjects s ON m.subject = s.ROWID
       JOIN addresses a ON m.sender = a.ROWID
       JOIN mailboxes mb ON m.mailbox = mb.ROWID
       WHERE m.deleted = 0
         ${mbFilterSql}
         ${scopeSql};`
    ),
  ]);

  const total = safeInt(countRows[0]?.total ?? 0);

  const items = rows.map((r) => {
    const parsed = parseMailboxUrl(String(r.mailbox_url || ""));
    return {
      id: safeInt(r.id),
      subject: String(r.subject || ""),
      sender: String(r.sender || ""),
      dateReceived: String(r.date_received || ""),
      read: r.read === 1,
      flagged: r.flagged === 1,
      mailbox: parsed?.mailboxName || "",
      account: (parsed ? accountMap.get(parsed.accountId) : undefined) || "",
    };
  });

  return paginateRows(items, total, offset);
}

// ─── Write Tools (JXA — requires Mail.app, serialized via queue) ─

export async function sendEmail(
  to: string[],
  subject: string,
  body: string,
  cc?: string[],
  bcc?: string[],
  account?: string
): Promise<{ success: boolean; message: string }> {
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
  account?: string
): Promise<{ success: boolean; message: string }> {
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
  mailbox = "INBOX",
  account?: string
): Promise<{ success: boolean; message: string }> {
  const acctSetup = account
    ? `const acct = Mail.accounts.byName(${jxaString(account)});`
    : `const acct = Mail.accounts[0];`;

  return executeJxaWrite(`
    const Mail = Application("Mail");
    ${acctSetup}
    const mb = acct.mailboxes.byName(${jxaString(mailbox)});
    const ids = mb.messages.id();
    const idx = ids.indexOf(${safeInt(messageId)});
    if (idx === -1) throw new Error("Message not found");
    const msg = mb.messages[idx];
    const reply = msg.reply({ replyToAll: ${replyAll}, openingWindow: ${!send} });
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
  mailbox = "INBOX",
  account?: string
): Promise<{ success: boolean; message: string }> {
  const acctSetup = account
    ? `const acct = Mail.accounts.byName(${jxaString(account)});`
    : `const acct = Mail.accounts[0];`;

  return executeJxaWrite(`
    const Mail = Application("Mail");
    ${acctSetup}
    const mb = acct.mailboxes.byName(${jxaString(mailbox)});
    const ids = mb.messages.id();
    const idx = ids.indexOf(${safeInt(messageId)});
    if (idx === -1) throw new Error("Message not found");
    const msg = mb.messages[idx];
    const fwd = msg.forward({ openingWindow: ${!send} });
    if (fwd) {
      for (const addr of JSON.parse(${jxaString(JSON.stringify(to))})) {
        const r = Mail.ToRecipient({ address: addr });
        fwd.toRecipients.push(r);
      }
      ${body ? `fwd.content = ${jxaString(body)} + "\\n\\n" + fwd.content();` : ""}
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
  sourceMailbox = "INBOX",
  account?: string
): Promise<{ success: boolean }> {
  const acctSetup = account
    ? `const acct = Mail.accounts.byName(${jxaString(account)});`
    : `const acct = Mail.accounts[0];`;

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
  mailbox = "INBOX",
  account?: string
): Promise<{ success: boolean }> {
  const acctSetup = account
    ? `const acct = Mail.accounts.byName(${jxaString(account)});`
    : `const acct = Mail.accounts[0];`;

  const flagOps: string[] = [];
  if (flagged !== undefined) flagOps.push(`m.flaggedStatus = ${flagged};`);
  if (read !== undefined) flagOps.push(`m.readStatus = ${read};`);

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
