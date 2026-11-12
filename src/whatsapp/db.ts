/**
 * WhatsApp ChatStorage.sqlite queries.
 *
 * Read-only through the system sqlite3 (`-readonly`), like the Messages
 * module, so WhatsApp's files are never written or locked. Every function
 * takes the database path so tests can use a fixture.
 *
 * Schema facts relied on (checked against WhatsApp for Mac, November 2026):
 * - ZMESSAGEDATE is seconds since 2001-01-01 UTC, as a float.
 * - ZWACHATSESSION.ZSESSIONTYPE: 0 = one-to-one, 1 = group. Broadcast lists,
 *   Status, community parents and Channels (2-5) are left out.
 * - ZMESSAGETYPE 6 and 10 are system events (joins, renames, encryption
 *   notices) and are skipped.
 * - Nearly every message has a ZWAMEDIAITEM row, text included, so the media
 *   kind comes from ZMESSAGETYPE. Captions are in ZWAMEDIAITEM.ZTITLE.
 * - Contacts are identified by "<digits>@s.whatsapp.net" or by a privacy id
 *   "<digits>@lid" that carries no phone number.
 * - In groups the sender is ZWAGROUPMEMBER.ZMEMBERJID via ZWAMESSAGE.ZGROUPMEMBER;
 *   ZFROMJID is usually the group itself. ZWAMESSAGE.ZPUSHNAME is encoded and
 *   ZWAGROUPMEMBER.ZCONTACTNAME is empty, so neither gives a name.
 * - A group can have no subject (ZPARTNERNAME is ''); WhatsApp then shows its
 *   members, so those groups carry their member ids for naming.
 * - There is no per-message read flag. A chat's ZUNREADCOUNT says how many of
 *   its newest incoming messages are unread.
 */

import { sqliteQuery, sqlEscape, sqlLikeEscape, safeInt, SqliteRow } from "../shared/sqlite.js";

// ─── SQL fragments ───────────────────────────────────────────────

const APPLE_EPOCH_SEC = 978307200;

const DATE_MS = (col: string) => `CAST(ROUND((${col} + ${APPLE_EPOCH_SEC}) * 1000) AS INTEGER)`;

const CHATS = "s.ZSESSIONTYPE IN (0, 1) AND COALESCE(s.ZREMOVED, 0) = 0 AND COALESCE(s.ZHIDDEN, 0) = 0";
const VISIBLE = "m.ZMESSAGETYPE NOT IN (6, 10)";
const NEWEST_FIRST = "m.ZMESSAGEDATE DESC, m.Z_PK DESC";

const CHAT_COLUMNS = `s.Z_PK AS chat_id, s.ZCONTACTJID AS chat_jid, s.ZPARTNERNAME AS chat_name,
  s.ZSESSIONTYPE AS session_type`;

const MESSAGE_SELECT = `m.Z_PK AS id, ${DATE_MS("m.ZMESSAGEDATE")} AS date_ms, m.ZISFROMME AS from_me,
  m.ZMESSAGETYPE AS type, m.ZTEXT AS text, i.ZTITLE AS title, i.ZMEDIALOCALPATH AS local_path,
  CASE WHEN s.ZSESSIONTYPE = 1
    THEN COALESCE(g.ZMEMBERJID, CASE WHEN m.ZFROMJID NOT LIKE '%@g.us' THEN m.ZFROMJID END)
    ELSE s.ZCONTACTJID END AS sender_jid,
  ${CHAT_COLUMNS}`;

const MESSAGE_FROM = `FROM ZWAMESSAGE m
  JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION
  LEFT JOIN ZWAGROUPMEMBER g ON g.Z_PK = m.ZGROUPMEMBER
  LEFT JOIN ZWAMEDIAITEM i ON i.Z_PK = m.ZMEDIAITEM`;

function sqlList(values: string[]): string {
  return values.map((v) => `'${sqlEscape(v)}'`).join(", ");
}

function sinceSql(sinceMs: number | undefined): string {
  return sinceMs == null ? "" : ` AND m.ZMESSAGEDATE >= ${sinceMs / 1000 - APPLE_EPOCH_SEC}`;
}

// ─── Types ───────────────────────────────────────────────────────

export interface ChatInfo {
  id: number;
  jid: string;
  /** Group subject, or WhatsApp's own name for a one-to-one chat. May be empty. */
  name: string;
  isGroup: boolean;
  /** Member ids, loaded only for a group with no subject, to name it by. */
  memberJids?: string[];
}

export interface MessageRow {
  id: number;
  dateMs: number | null;
  isFromMe: boolean;
  type: number;
  text: string;
  /** Caption, link title or document name, depending on the type. */
  title: string;
  localPath: string;
  /** Sender for incoming messages; empty for own messages or when unknown. */
  senderJid: string;
  chat: ChatInfo;
}

export interface ChatListRow extends ChatInfo {
  lastMs: number | null;
  unreadCount: number;
  archived: boolean;
  lastMessage: MessageRow | null;
}

export interface Page<T> {
  items: T[];
  total: number;
}

// ─── Row mapping ─────────────────────────────────────────────────

function toChat(r: SqliteRow): ChatInfo {
  return {
    id: safeInt(r.chat_id),
    jid: String(r.chat_jid || ""),
    name: String(r.chat_name || ""),
    isGroup: Number(r.session_type) === 1,
  };
}

function toMessage(r: SqliteRow): MessageRow {
  const isFromMe = Number(r.from_me) === 1;
  return {
    id: safeInt(r.id),
    dateMs: r.date_ms == null ? null : Number(r.date_ms),
    isFromMe,
    type: Number(r.type ?? 0),
    text: String(r.text || ""),
    title: String(r.title || ""),
    localPath: String(r.local_path || ""),
    senderJid: isFromMe ? "" : String(r.sender_jid || ""),
    chat: toChat(r),
  };
}

/** Load the members of any group that has no subject. Chats may repeat; all copies are filled. */
async function attachMembers<T extends ChatInfo>(db: string, chats: T[]): Promise<T[]> {
  const unnamed = chats.filter((c) => c.isGroup && !c.name);
  if (unnamed.length === 0) return chats;
  const ids = [...new Set(unnamed.map((c) => c.id))];
  const rows = await sqliteQuery(db,
    `SELECT ZCHATSESSION AS chat_id, ZMEMBERJID AS jid FROM ZWAGROUPMEMBER
      WHERE ZCHATSESSION IN (${ids.join(", ")}) AND ZMEMBERJID IS NOT NULL ORDER BY Z_PK;`);
  const members = new Map<number, string[]>();
  for (const r of rows) {
    const id = safeInt(r.chat_id);
    members.set(id, [...(members.get(id) ?? []), String(r.jid)]);
  }
  for (const c of unnamed) c.memberJids = members.get(c.id) ?? [];
  return chats;
}

async function count(db: string, sql: string): Promise<number> {
  const rows = await sqliteQuery(db, sql);
  return safeInt(rows[0]?.n ?? 0);
}

async function messagePage(db: string, where: string, limit: number, offset: number): Promise<Page<MessageRow>> {
  const [rows, total] = await Promise.all([
    sqliteQuery(db, `SELECT ${MESSAGE_SELECT} ${MESSAGE_FROM} WHERE ${where}
      ORDER BY ${NEWEST_FIRST} LIMIT ${safeInt(limit)} OFFSET ${safeInt(offset)};`),
    count(db, `SELECT COUNT(*) AS n ${MESSAGE_FROM} WHERE ${where};`),
  ]);
  const items = rows.map(toMessage);
  await attachMembers(db, items.map((m) => m.chat));
  return { items, total };
}

// ─── Chats ───────────────────────────────────────────────────────

/** Chats with any history, newest first, each with its last message. */
export async function listChats(db: string, limit: number, offset: number): Promise<Page<ChatListRow>> {
  const where = `${CHATS} AND s.ZLASTMESSAGEDATE IS NOT NULL`;
  const [rows, total] = await Promise.all([
    sqliteQuery(db, `SELECT ${CHAT_COLUMNS}, ${DATE_MS("s.ZLASTMESSAGEDATE")} AS last_ms,
        COALESCE(s.ZUNREADCOUNT, 0) AS unread, COALESCE(s.ZARCHIVED, 0) AS archived, s.ZLASTMESSAGE AS last_id
      FROM ZWACHATSESSION s WHERE ${where}
      ORDER BY s.ZLASTMESSAGEDATE DESC, s.Z_PK DESC LIMIT ${safeInt(limit)} OFFSET ${safeInt(offset)};`),
    count(db, `SELECT COUNT(*) AS n FROM ZWACHATSESSION s WHERE ${where};`),
  ]);

  const lastIds = rows.filter((r) => r.last_id != null).map((r) => safeInt(r.last_id));
  const last = new Map<number, MessageRow>();
  if (lastIds.length > 0) {
    const messages = await sqliteQuery(db,
      `SELECT ${MESSAGE_SELECT} ${MESSAGE_FROM} WHERE m.Z_PK IN (${lastIds.join(", ")}) AND ${VISIBLE};`);
    for (const m of messages.map(toMessage)) last.set(m.id, m);
  }

  const items = rows.map((r): ChatListRow => ({
    ...toChat(r),
    lastMs: r.last_ms == null ? null : Number(r.last_ms),
    unreadCount: Math.max(0, safeInt(r.unread)),
    archived: Number(r.archived) === 1,
    lastMessage: r.last_id == null ? null : last.get(safeInt(r.last_id)) ?? null,
  }));
  return { items: await attachMembers(db, items), total };
}

/**
 * Chats by id, or those whose stored name contains `name` or whose contact is
 * one of `jids`. Most recently active first.
 */
export async function findChats(
  db: string,
  by: { chatId: number } | { name: string; jids: string[] }
): Promise<ChatInfo[]> {
  let match: string;
  if ("chatId" in by) {
    match = `s.Z_PK = ${safeInt(by.chatId)}`;
  } else {
    const parts = [`s.ZPARTNERNAME LIKE '%${sqlLikeEscape(by.name)}%' ESCAPE '\\'`];
    if (by.jids.length > 0) parts.push(`(s.ZSESSIONTYPE = 0 AND s.ZCONTACTJID IN (${sqlList(by.jids)}))`);
    match = `(${parts.join(" OR ")})`;
  }
  const rows = await sqliteQuery(db,
    `SELECT ${CHAT_COLUMNS} FROM ZWACHATSESSION s WHERE ${CHATS} AND ${match}
      ORDER BY s.ZLASTMESSAGEDATE DESC, s.Z_PK DESC LIMIT 50;`);
  return attachMembers(db, rows.map(toChat));
}

// ─── Messages ────────────────────────────────────────────────────

/** One chat's messages, newest first. */
export function getChatMessages(
  db: string, chatId: number, limit: number, offset: number, sinceMs?: number
): Promise<Page<MessageRow>> {
  return messagePage(db, `m.ZCHATSESSION = ${safeInt(chatId)} AND ${VISIBLE}${sinceSql(sinceMs)}`, limit, offset);
}

/**
 * Messages whose text or caption contains `query`, newest first. `jids`
 * limits the search to messages sent by those people or in a one-to-one
 * chat with them.
 */
export function searchMessages(
  db: string,
  opts: { query: string; chatId?: number; jids?: string[]; sinceMs?: number; limit: number; offset: number }
): Promise<Page<MessageRow>> {
  const like = `LIKE '%${sqlLikeEscape(opts.query)}%' ESCAPE '\\'`;
  let where = `${CHATS} AND ${VISIBLE} AND (m.ZTEXT ${like} OR i.ZTITLE ${like})${sinceSql(opts.sinceMs)}`;
  if (opts.chatId != null) where += ` AND m.ZCHATSESSION = ${safeInt(opts.chatId)}`;
  if (opts.jids) {
    const list = sqlList(opts.jids);
    where += ` AND ((s.ZSESSIONTYPE = 0 AND s.ZCONTACTJID IN (${list}))
      OR (m.ZISFROMME = 0 AND (g.ZMEMBERJID IN (${list}) OR m.ZFROMJID IN (${list}))))`;
  }
  return messagePage(db, where, opts.limit, opts.offset);
}

/** The newest ZUNREADCOUNT incoming messages of every chat that has unread messages. */
export function getUnread(db: string, limit: number, offset: number): Promise<Page<MessageRow>> {
  const where = `m.Z_PK IN (
    SELECT pk FROM (
      SELECT m.Z_PK AS pk, s.ZUNREADCOUNT AS unread,
        ROW_NUMBER() OVER (PARTITION BY m.ZCHATSESSION ORDER BY ${NEWEST_FIRST}) AS rn
      FROM ZWAMESSAGE m JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION
      WHERE ${CHATS} AND s.ZUNREADCOUNT > 0 AND m.ZISFROMME = 0 AND ${VISIBLE}
    ) WHERE rn <= unread)`;
  return messagePage(db, where, limit, offset);
}

/** Time of the newest message in the database: how current the local history is. */
export async function latestMessageMs(db: string): Promise<number | null> {
  const rows = await sqliteQuery(db, `SELECT ${DATE_MS("MAX(ZMESSAGEDATE)")} AS ms FROM ZWAMESSAGE;`);
  return rows[0]?.ms == null ? null : Number(rows[0].ms);
}

// ─── Names ───────────────────────────────────────────────────────

export interface NameRows {
  /** WhatsApp's copy of the address book (ContactsV2.sqlite). */
  contacts: { phoneJid: string; lidJid: string; name: string }[];
  /** Names people chose for their own WhatsApp profile. */
  profiles: { jid: string; name: string }[];
}

/** Address book and profile names. A missing contacts database just yields no contacts. */
export async function loadNames(chatsDb: string, contactsDb: string): Promise<NameRows> {
  const [contacts, profiles] = await Promise.all([
    sqliteQuery(contactsDb,
      `SELECT ZWHATSAPPID AS phone_jid, ZLID AS lid_jid, ZFULLNAME AS name
         FROM ZWAADDRESSBOOKCONTACT WHERE ZFULLNAME IS NOT NULL AND ZFULLNAME != '';`).catch(() => []),
    sqliteQuery(chatsDb,
      "SELECT ZJID AS jid, ZPUSHNAME AS name FROM ZWAPROFILEPUSHNAME WHERE ZPUSHNAME IS NOT NULL AND ZPUSHNAME != '';"),
  ]);
  return {
    contacts: contacts.map((r) => ({
      phoneJid: String(r.phone_jid || ""),
      lidJid: String(r.lid_jid || ""),
      name: String(r.name),
    })),
    profiles: profiles.map((r) => ({ jid: String(r.jid || ""), name: String(r.name) })),
  };
}
