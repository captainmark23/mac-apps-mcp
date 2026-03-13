/**
 * Apple Mail MCP tools.
 *
 * Read operations use the Mail Envelope Index SQLite database for instant
 * results. Write operations and body content retrieval use JXA.
 *
 * Provides: list_accounts, list_mailboxes, get_emails, get_email,
 * search_mail, send_email, create_draft, reply_to, forward,
 * move_message, flag_message, mark_read
 */

import { executeJxa, executeJxaWrite, jxaString } from "../shared/applescript.js";
import { sqliteQuery, sqlEscape, sqlLikeEscape } from "../shared/sqlite.js";
import {
  getDefaultMailAccount,
  getMailDbPath,
  resolveMailAccountUuid,
} from "../shared/config.js";
import { PaginatedResult, paginateRows } from "../shared/types.js";

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

// ─── Read Tools (SQLite for listing/search, JXA for body) ───────

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
  mailbox = "INBOX",
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

  const mbFilter = await accountMailboxFilter(mailbox, account);

  const [rows, countRows] = await Promise.all([
    sqliteQuery(
      db,
      `SELECT m.ROWID as id, s.subject, a.address as sender,
         datetime(m.date_received, 'unixepoch', 'localtime') as date_received,
         m.read, m.flagged
       FROM messages m
       JOIN subjects s ON m.subject = s.ROWID
       JOIN addresses a ON m.sender = a.ROWID
       JOIN mailboxes mb ON m.mailbox = mb.ROWID
       WHERE m.deleted = 0
         AND ${mbFilter}
         ${filterSql}
       ORDER BY m.date_received DESC
       LIMIT ${limit} OFFSET ${offset};`
    ),
    sqliteQuery(
      db,
      `SELECT COUNT(*) as total
       FROM messages m
       JOIN mailboxes mb ON m.mailbox = mb.ROWID
       WHERE m.deleted = 0
         AND ${mbFilter}
         ${filterSql};`
    ),
  ]);

  const total =
    typeof countRows[0]?.total === "number"
      ? countRows[0].total
      : parseInt(String(countRows[0]?.total || "0"), 10);

  const items = rows.map((r) => ({
    id: typeof r.id === "number" ? r.id : parseInt(String(r.id), 10),
    subject: String(r.subject || ""),
    sender: String(r.sender || ""),
    dateReceived: String(r.date_received || ""),
    read: r.read === 1,
    flagged: r.flagged === 1,
  }));

  return paginateRows(items, total, offset);
}

export async function getEmail(
  messageId: number,
  mailbox = "INBOX",
  account?: string
): Promise<EmailFull> {
  const db = getMailDbPath();

  const rows = await sqliteQuery(
    db,
    `SELECT m.ROWID as id, s.subject, a.address as sender,
       datetime(m.date_received, 'unixepoch', 'localtime') as date_received,
       datetime(m.date_sent, 'unixepoch', 'localtime') as date_sent,
       m.read, m.flagged, m.document_id
     FROM messages m
     JOIN subjects s ON m.subject = s.ROWID
     JOIN addresses a ON m.sender = a.ROWID
     WHERE m.ROWID = ${messageId}
     LIMIT 1;`
  );

  if (!rows.length) throw new Error(`Message not found: ${messageId}`);
  const r = rows[0];

  const [toRows, ccRows] = await Promise.all([
    sqliteQuery(
      db,
      `SELECT a.address
       FROM recipients rc
       JOIN addresses a ON rc.address_id = a.ROWID
       WHERE rc.message_id = ${messageId} AND rc.type = 0;`
    ),
    sqliteQuery(
      db,
      `SELECT a.address
       FROM recipients rc
       JOIN addresses a ON rc.address_id = a.ROWID
       WHERE rc.message_id = ${messageId} AND rc.type = 1;`
    ),
  ]);

  // Body content requires JXA (not stored in Envelope Index)
  let content = "";
  let replyTo = "";
  let msgId = "";
  try {
    const acctSetup = account
      ? `const acct = Mail.accounts.byName(${jxaString(account)});`
      : `const acct = Mail.accounts[0];`;

    const bodyResult = await executeJxa<{
      content: string;
      replyTo: string;
      messageId: string;
    }>(`
      const Mail = Application("Mail");
      ${acctSetup}
      const mb = acct.mailboxes.byName(${jxaString(mailbox)});
      const ids = mb.messages.id();
      const idx = ids.indexOf(${messageId});
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
    content = "(Body content unavailable — grant Mail automation access)";
  }

  return {
    id: typeof r.id === "number" ? r.id : parseInt(String(r.id), 10),
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
  };
}

export async function searchMail(
  query: string,
  scope: "subject" | "sender" | "all" = "all",
  mailbox = "INBOX",
  account?: string,
  limit = 20,
  offset = 0
): Promise<PaginatedResult<EmailSummary>> {
  const db = getMailDbPath();
  const safeQuery = sqlLikeEscape(query.toLowerCase());
  const mbFilter = await accountMailboxFilter(mailbox, account);

  let scopeSql: string;
  if (scope === "subject") {
    scopeSql = `AND LOWER(s.subject) LIKE '%${safeQuery}%' ESCAPE '\\'`;
  } else if (scope === "sender") {
    scopeSql = `AND LOWER(a.address) LIKE '%${safeQuery}%' ESCAPE '\\'`;
  } else {
    scopeSql = `AND (LOWER(s.subject) LIKE '%${safeQuery}%' ESCAPE '\\' OR LOWER(a.address) LIKE '%${safeQuery}%' ESCAPE '\\')`;
  }

  const [rows, countRows] = await Promise.all([
    sqliteQuery(
      db,
      `SELECT m.ROWID as id, s.subject, a.address as sender,
         datetime(m.date_received, 'unixepoch', 'localtime') as date_received,
         m.read, m.flagged
       FROM messages m
       JOIN subjects s ON m.subject = s.ROWID
       JOIN addresses a ON m.sender = a.ROWID
       JOIN mailboxes mb ON m.mailbox = mb.ROWID
       WHERE m.deleted = 0
         AND ${mbFilter}
         ${scopeSql}
       ORDER BY m.date_received DESC
       LIMIT ${limit} OFFSET ${offset};`
    ),
    sqliteQuery(
      db,
      `SELECT COUNT(*) as total
       FROM messages m
       JOIN subjects s ON m.subject = s.ROWID
       JOIN addresses a ON m.sender = a.ROWID
       JOIN mailboxes mb ON m.mailbox = mb.ROWID
       WHERE m.deleted = 0
         AND ${mbFilter}
         ${scopeSql};`
    ),
  ]);

  const total =
    typeof countRows[0]?.total === "number"
      ? countRows[0].total
      : parseInt(String(countRows[0]?.total || "0"), 10);

  const items = rows.map((r) => ({
    id: typeof r.id === "number" ? r.id : parseInt(String(r.id), 10),
    subject: String(r.subject || ""),
    sender: String(r.sender || ""),
    dateReceived: String(r.date_received || ""),
    read: r.read === 1,
    flagged: r.flagged === 1,
  }));

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
    const idx = ids.indexOf(${messageId});
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
    const idx = ids.indexOf(${messageId});
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
    const idx = ids.indexOf(${messageId});
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
    const idx = ids.indexOf(${messageId});
    if (idx === -1) throw new Error("Message not found");
    const m = mb.messages[idx];
    ${flagOps.join("\n    ")}
    JSON.stringify({ success: true });
  `);
}
