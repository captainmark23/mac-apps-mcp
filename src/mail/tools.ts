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

import { homedir } from "node:os";
import { join } from "node:path";
import { executeJxa, jxaString } from "../shared/applescript.js";
import { sqliteQuery, sqlEscape, sqlLikeEscape } from "../shared/sqlite.js";
import { getDefaultMailAccount } from "../shared/config.js";

const MAIL_DB = join(homedir(), "Library/Mail/V10/MailData/Envelope Index");

/**
 * Resolve an account name (e.g. "iCloud") to a UUID for mailbox URL matching.
 * Cached after first lookup.
 */
let _accountMap: Map<string, string> | null = null;
async function resolveAccountUuid(accountName: string): Promise<string | null> {
  if (!_accountMap) {
    try {
      const accounts = await executeJxa<{ name: string; id: string }[]>(`
        const Mail = Application("Mail");
        JSON.stringify(Mail.accounts().map(a => ({ name: a.name(), id: a.id() })));
      `);
      _accountMap = new Map(accounts.map((a) => [a.name.toLowerCase(), a.id]));
    } catch {
      _accountMap = new Map();
    }
  }
  return _accountMap.get(accountName.toLowerCase()) || null;
}

/** Build SQL filter for account-specific mailbox URL matching. */
async function accountMailboxFilter(
  mailbox: string,
  account?: string
): Promise<string> {
  const effectiveAccount = account || getDefaultMailAccount();
  const mailboxName = sqlLikeEscape(mailbox);

  if (effectiveAccount) {
    const uuid = await resolveAccountUuid(effectiveAccount);
    if (uuid) {
      return `mb.url LIKE '%${sqlLikeEscape(uuid)}/${mailboxName}' ESCAPE '\\'`;
    }
  }
  // No account specified or not resolved — match all accounts
  return `mb.url LIKE '%/${mailboxName}' ESCAPE '\\'`;
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

// ─── Read Tools (SQLite for listing/search, JXA for body) ───────

export async function listAccounts(): Promise<Account[]> {
  // Account names aren't in Envelope Index — use JXA
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
  // Mailbox names are associated with accounts via JXA
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
  limit = 50
): Promise<EmailSummary[]> {
  // Use SQLite for fast email listing
  let filterSql = "";
  if (filter === "unread") filterSql = "AND m.read = 0";
  else if (filter === "flagged") filterSql = "AND m.flagged = 1";
  else if (filter === "today") {
    filterSql = `AND m.date_received >= strftime('%s','now','start of day')`;
  } else if (filter === "this_week") {
    filterSql = `AND m.date_received >= strftime('%s','now','-7 days')`;
  }

  const mbFilter = await accountMailboxFilter(mailbox, account);

  const rows = await sqliteQuery(
    MAIL_DB,
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
     LIMIT ${limit};`
  );

  return rows.map((r) => ({
    id: typeof r.id === "number" ? r.id : parseInt(String(r.id), 10),
    subject: String(r.subject || ""),
    sender: String(r.sender || ""),
    dateReceived: String(r.date_received || ""),
    read: r.read === 1,
    flagged: r.flagged === 1,
  }));
}

export async function getEmail(
  messageId: number,
  mailbox = "INBOX",
  account?: string
): Promise<EmailFull> {
  // Get metadata from SQLite
  const rows = await sqliteQuery(
    MAIL_DB,
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

  // Get recipients
  const toRows = await sqliteQuery(
    MAIL_DB,
    `SELECT a.address
     FROM recipients rc
     JOIN addresses a ON rc.address_id = a.ROWID
     WHERE rc.message_id = ${messageId} AND rc.type = 0;`
  );
  const ccRows = await sqliteQuery(
    MAIL_DB,
    `SELECT a.address
     FROM recipients rc
     JOIN addresses a ON rc.address_id = a.ROWID
     WHERE rc.message_id = ${messageId} AND rc.type = 1;`
  );

  // Body content requires JXA (not stored in Envelope Index)
  let content = "";
  let replyTo = "";
  let msgId = "";
  try {
    const acctSetup = account
      ? `const acct = Mail.accounts.byName(${jxaString(account)});`
      : `const acct = Mail.accounts[0];`;

    const bodyResult = await executeJxa<{ content: string; replyTo: string; messageId: string }>(`
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
    // Body retrieval may fail if Mail.app automation not permitted
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
  limit = 20
): Promise<EmailSummary[]> {
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

  const rows = await sqliteQuery(
    MAIL_DB,
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
     LIMIT ${limit};`
  );

  return rows.map((r) => ({
    id: typeof r.id === "number" ? r.id : parseInt(String(r.id), 10),
    subject: String(r.subject || ""),
    sender: String(r.sender || ""),
    dateReceived: String(r.date_received || ""),
    read: r.read === 1,
    flagged: r.flagged === 1,
  }));
}

// ─── Write Tools (JXA — requires Mail.app) ──────────────────────

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

  return executeJxa(`
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

  return executeJxa(`
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

  return executeJxa(`
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

  return executeJxa(`
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

  return executeJxa(`
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

  return executeJxa(`
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
