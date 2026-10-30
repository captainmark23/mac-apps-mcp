/**
 * Messages chat.db queries.
 *
 * Read-only through the system sqlite3; WAL reads are fine, so no copy is
 * needed. Every function takes the database path so tests can use a fixture.
 *
 * Schema facts relied on (checked on macOS 27):
 * - message.date is nanoseconds since 2001-01-01; very old rows are seconds.
 * - item_type != 0 rows are system events (joins, renames) and are skipped.
 * - associated_message_type 2000-2999 is a tapback, 3000-3999 its removal.
 *   They are folded into the target message, never listed as messages.
 * - chat.guid is "any;-;<handle>" (1:1) or "any;+;<group id>"; style 45 = 1:1, 43 = group.
 * - chat.is_filtered = 2 marks junk, which the Messages app keeps out of its
 *   list and unread badge, so it is excluded here too.
 */

import { sqliteQuery, sqlEscape, sqlLikeEscape, safeInt, SqliteRow } from "../shared/sqlite.js";
import { attributedBodyTextSql, messageText } from "./attributed-body.js";

// ─── SQL fragments ───────────────────────────────────────────────

/** Unix milliseconds from an Apple date column, by magnitude (ns since ~2017, seconds before). */
export function dateMsSql(col: string): string {
  return `(CASE WHEN ${col} IS NULL OR ${col} = 0 THEN NULL
    WHEN ${col} > 100000000000 THEN ${col} / 1000000 ELSE ${col} * 1000 END + 978307200000)`;
}

const VISIBLE = "m.item_type = 0 AND m.associated_message_type NOT BETWEEN 2000 AND 3999";
const NOT_JUNK = "COALESCE(c.is_filtered, 0) != 2";
const GROUP_STYLE = 43;
const ONE_TO_ONE_STYLE = 45;

/** Characters compared when matching a national-format contact number to a handle. */
const TAIL_DIGITS = 9;

function sqlList(values: string[]): string {
  return values.map((v) => `'${sqlEscape(v)}'`).join(", ");
}

function idList(ids: number[]): string {
  return ids.map((id) => safeInt(id)).join(", ");
}

// ─── Types ───────────────────────────────────────────────────────

export interface AttachmentInfo {
  name: string;
  mimeType: string;
  size: number;
}

export interface Reaction {
  reaction: string;
  fromMe: boolean;
  handle: string;
}

export interface MessageRow {
  id: number;
  guid: string;
  chatId: number;
  dateMs: number | null;
  isFromMe: boolean;
  isRead: boolean;
  /** Sender handle for incoming messages; empty for own messages. */
  handle: string;
  text: string;
  edited: boolean;
  attachments: AttachmentInfo[];
  reactions: Reaction[];
}

export interface ChatInfo {
  id: number;
  guid: string;
  chatIdentifier: string;
  displayName: string;
  service: string;
  isGroup: boolean;
  participants: string[];
  lastMs: number | null;
}

export interface ChatListRow extends ChatInfo {
  unreadCount: number;
  lastMessage: MessageRow | null;
}

export interface MessageWithChat extends MessageRow {
  chat: ChatInfo;
}

// ─── Column detection ────────────────────────────────────────────

const _columns = new Map<string, Set<string>>();

/** message table columns, cached per database (emoji tapbacks and edits are newer columns). */
async function messageColumns(db: string): Promise<Set<string>> {
  let cols = _columns.get(db);
  if (!cols) {
    const rows = await sqliteQuery(db, "PRAGMA table_info(message);");
    cols = new Set(rows.map((r) => String(r.name)));
    _columns.set(db, cols);
  }
  return cols;
}

async function messageSelect(db: string): Promise<string> {
  const cols = await messageColumns(db);
  const edited = cols.has("date_edited") ? "COALESCE(m.date_edited, 0) != 0" : "0";
  return `m.ROWID AS id, m.guid AS guid, cmj.chat_id AS chat_id, ${dateMsSql("m.date")} AS date_ms,
    m.is_from_me AS is_from_me, m.is_read AS is_read, COALESCE(h.id, '') AS handle,
    m.text AS text, CASE WHEN m.text IS NULL OR m.text = '' THEN hex(m.attributedBody) END AS ab,
    m.cache_has_attachments AS has_att, ${edited} AS edited`;
}

// ─── Row mapping ─────────────────────────────────────────────────

function toMessage(r: SqliteRow): MessageRow {
  const isFromMe = Number(r.is_from_me) === 1;
  return {
    id: safeInt(r.id),
    guid: String(r.guid || ""),
    chatId: safeInt(r.chat_id ?? 0),
    dateMs: r.date_ms == null ? null : Number(r.date_ms),
    isFromMe,
    isRead: isFromMe || Number(r.is_read) === 1,
    handle: isFromMe ? "" : String(r.handle || ""),
    text: messageText(r.text as string | null, r.ab as string | null),
    edited: Number(r.edited) === 1,
    attachments: [],
    reactions: [],
  };
}

function toChatInfo(r: SqliteRow): ChatInfo {
  const guid = String(r.chat_guid ?? r.guid ?? "");
  return {
    id: safeInt(r.chat_id ?? r.id),
    guid,
    chatIdentifier: String(r.chat_identifier || ""),
    displayName: String(r.display_name || ""),
    service: String(r.service || ""),
    isGroup: Number(r.style) === GROUP_STYLE || guid.includes(";+;"),
    participants: [],
    lastMs: r.last_ms == null ? null : Number(r.last_ms),
  };
}

const TAPBACK_NAMES = ["love", "like", "dislike", "laugh", "emphasize", "question"];

/** Name for a tapback type (2000-2999 or its 3xxx removal). */
export function tapbackName(type: number, emoji?: string | null): string {
  const kind = type % 1000;
  if (kind < TAPBACK_NAMES.length) return TAPBACK_NAMES[kind];
  if (kind === 6) return emoji || "emoji";
  if (kind === 7) return "sticker";
  return "reaction";
}

/** The target message guid from associated_message_guid ("p:0/GUID" or "bp:GUID"). */
export function tapbackTarget(associated: string): string {
  return associated.replace(/^(?:p:\d+\/|bp:)/, "");
}

/**
 * Current reactions per target message. Rows must be in send order. Each
 * person holds one tapback per message: a new one replaces it, a 3xxx removes it.
 */
export function foldReactions(
  rows: { type: number; target: string; emoji?: string | null; fromMe: boolean; handle: string }[]
): Map<string, Reaction[]> {
  const byTarget = new Map<string, Map<string, Reaction>>();
  for (const r of rows) {
    if (r.type < 2000 || r.type >= 4000) continue;
    const target = tapbackTarget(r.target);
    const sender = r.fromMe ? "me" : r.handle;
    let current = byTarget.get(target);
    if (!current) {
      current = new Map();
      byTarget.set(target, current);
    }
    if (r.type >= 3000) current.delete(sender);
    else current.set(sender, { reaction: tapbackName(r.type, r.emoji), fromMe: r.fromMe, handle: r.fromMe ? "" : r.handle });
  }
  const out = new Map<string, Reaction[]>();
  for (const [target, current] of byTarget) {
    if (current.size > 0) out.set(target, [...current.values()]);
  }
  return out;
}

// ─── Decoration (participants, attachments, reactions) ───────────

async function participantsFor(db: string, chatIds: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  if (chatIds.length === 0) return out;
  const rows = await sqliteQuery(db,
    `SELECT j.chat_id AS chat_id, h.id AS handle
       FROM chat_handle_join j JOIN handle h ON h.ROWID = j.handle_id
      WHERE j.chat_id IN (${idList(chatIds)});`);
  for (const r of rows) {
    const id = safeInt(r.chat_id);
    const list = out.get(id) ?? [];
    const handle = String(r.handle || "");
    if (handle && !list.includes(handle)) list.push(handle);
    out.set(id, list);
  }
  return out;
}

async function attachAttachments(db: string, messages: MessageRow[], rows: SqliteRow[]): Promise<void> {
  const ids = rows.filter((r) => Number(r.has_att) === 1).map((r) => safeInt(r.id));
  if (ids.length === 0) return;
  const atts = await sqliteQuery(db,
    `SELECT maj.message_id AS id, COALESCE(a.transfer_name, '') AS name,
            COALESCE(a.mime_type, '') AS mime, COALESCE(a.total_bytes, 0) AS size
       FROM message_attachment_join maj JOIN attachment a ON a.ROWID = maj.attachment_id
      WHERE maj.message_id IN (${idList(ids)});`);
  const byId = new Map(messages.map((m) => [m.id, m]));
  for (const a of atts) {
    byId.get(safeInt(a.id))?.attachments.push({
      name: String(a.name || ""),
      mimeType: String(a.mime || ""),
      size: Number(a.size) || 0,
    });
  }
}

async function attachReactions(db: string, chatIds: number[], messages: MessageRow[]): Promise<void> {
  const dated = messages.filter((m) => m.dateMs != null);
  if (dated.length === 0 || chatIds.length === 0) return;
  const oldest = Math.min(...dated.map((m) => m.dateMs as number));
  const cols = await messageColumns(db);
  const emoji = cols.has("associated_message_emoji") ? "m.associated_message_emoji" : "NULL";
  const rows = await sqliteQuery(db,
    `SELECT m.associated_message_type AS type, m.associated_message_guid AS target, ${emoji} AS emoji,
            m.is_from_me AS is_from_me, COALESCE(h.id, '') AS handle
       FROM chat_message_join cmj
       JOIN message m ON m.ROWID = cmj.message_id
       LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE cmj.chat_id IN (${idList(chatIds)})
        AND m.associated_message_type BETWEEN 2000 AND 3999
        AND m.associated_message_guid IS NOT NULL
        AND ${dateMsSql("m.date")} >= ${safeInt(oldest)}
      ORDER BY m.date, m.ROWID;`);
  const folded = foldReactions(rows.map((r) => ({
    type: safeInt(r.type),
    target: String(r.target || ""),
    emoji: r.emoji == null ? null : String(r.emoji),
    fromMe: Number(r.is_from_me) === 1,
    handle: String(r.handle || ""),
  })));
  for (const m of messages) {
    const reactions = folded.get(m.guid);
    if (reactions) m.reactions = reactions;
  }
}

// ─── Queries ─────────────────────────────────────────────────────

/** Chats with any message, most recent first, junk excluded. */
export async function listChats(
  db: string,
  limit: number,
  offset: number,
  sinceMs?: number
): Promise<{ total: number; chats: ChatListRow[] }> {
  const lastMs = dateMsSql("MAX(cmj.message_date)");
  const rows = await sqliteQuery(db,
    `SELECT c.ROWID AS id, c.guid AS guid, c.chat_identifier AS chat_identifier,
            COALESCE(c.display_name, '') AS display_name, COALESCE(c.service_name, '') AS service,
            c.style AS style, ${lastMs} AS last_ms, COUNT(*) OVER () AS total
       FROM chat c JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
      WHERE ${NOT_JUNK}
      GROUP BY c.ROWID
      ${sinceMs != null ? `HAVING ${lastMs} >= ${safeInt(sinceMs)}` : ""}
      ORDER BY MAX(cmj.message_date) DESC
      LIMIT ${safeInt(limit)} OFFSET ${safeInt(offset)};`);
  const total = rows.length > 0 ? safeInt(rows[0].total) : 0;
  const chats: ChatListRow[] = rows.map((r) => ({ ...toChatInfo(r), unreadCount: 0, lastMessage: null }));
  if (chats.length === 0) return { total, chats };

  const ids = chats.map((c) => c.id);
  const select = await messageSelect(db);
  const [participants, lastRows, unreadRows] = await Promise.all([
    participantsFor(db, ids),
    sqliteQuery(db,
      `SELECT * FROM (
         SELECT ${select}, ROW_NUMBER() OVER (PARTITION BY cmj.chat_id ORDER BY cmj.message_date DESC, m.ROWID DESC) AS rn
           FROM chat_message_join cmj
           JOIN message m ON m.ROWID = cmj.message_id
           LEFT JOIN handle h ON h.ROWID = m.handle_id
          WHERE cmj.chat_id IN (${idList(ids)}) AND ${VISIBLE}
       ) WHERE rn = 1;`),
    sqliteQuery(db,
      `SELECT cmj.chat_id AS chat_id, COUNT(*) AS n
         FROM chat_message_join cmj JOIN message m ON m.ROWID = cmj.message_id
        WHERE cmj.chat_id IN (${idList(ids)}) AND m.is_from_me = 0 AND m.is_read = 0 AND ${VISIBLE}
        GROUP BY cmj.chat_id;`),
  ]);

  const lastByChat = new Map(lastRows.map((r) => [safeInt(r.chat_id), toMessage(r)]));
  const unreadByChat = new Map(unreadRows.map((r) => [safeInt(r.chat_id), safeInt(r.n)]));
  for (const c of chats) {
    c.participants = participants.get(c.id) ?? [];
    c.lastMessage = lastByChat.get(c.id) ?? null;
    c.unreadCount = unreadByChat.get(c.id) ?? 0;
  }
  const lastMessages = chats.map((c) => c.lastMessage).filter((m): m is MessageRow => m != null);
  await attachAttachments(db, lastMessages, lastRows);
  return { total, chats };
}

/**
 * Chats matching a ROWID, or any of the given chat_identifier values.
 * `oneToOne` limits identifier matches to 1:1 chats. Most recent first.
 */
export async function findChats(
  db: string,
  ref: { chatId?: number; identifiers?: string[]; oneToOne?: boolean }
): Promise<ChatInfo[]> {
  let where: string;
  if (ref.chatId != null) {
    where = `c.ROWID = ${safeInt(ref.chatId)}`;
  } else if (ref.identifiers && ref.identifiers.length > 0) {
    where = `c.chat_identifier IN (${sqlList(ref.identifiers)})`;
    if (ref.oneToOne) where += ` AND c.style = ${ONE_TO_ONE_STYLE}`;
  } else {
    return [];
  }
  const rows = await sqliteQuery(db,
    `SELECT c.ROWID AS id, c.guid AS guid, c.chat_identifier AS chat_identifier,
            COALESCE(c.display_name, '') AS display_name, COALESCE(c.service_name, '') AS service,
            c.style AS style, ${dateMsSql("MAX(cmj.message_date)")} AS last_ms
       FROM chat c LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
      WHERE ${where}
      GROUP BY c.ROWID
      ORDER BY MAX(cmj.message_date) DESC;`);
  const chats = rows.map(toChatInfo);
  const participants = await participantsFor(db, chats.map((c) => c.id));
  for (const c of chats) c.participants = participants.get(c.id) ?? [];
  return chats;
}

/**
 * The newest `limit` visible messages in the given chats within (afterMs, beforeMs),
 * returned oldest first with attachments and folded tapbacks. `beforeId` pages
 * back from that message in the same (raw date, ROWID) order as the query, so
 * messages sharing a millisecond are not skipped.
 */
export async function getChatMessages(
  db: string,
  chatIds: number[],
  limit: number,
  beforeMs?: number,
  afterMs?: number,
  beforeId?: number
): Promise<{ messages: MessageRow[]; hasMore: boolean }> {
  if (chatIds.length === 0) return { messages: [], hasMore: false };
  const cursorDate = beforeId != null ? `(SELECT date FROM message WHERE ROWID = ${safeInt(beforeId)})` : "";
  const bounds = [
    beforeMs != null ? `AND ${dateMsSql("m.date")} < ${safeInt(beforeMs)}` : "",
    afterMs != null ? `AND ${dateMsSql("m.date")} > ${safeInt(afterMs)}` : "",
    beforeId != null ? `AND (m.date < ${cursorDate} OR (m.date = ${cursorDate} AND m.ROWID < ${safeInt(beforeId)}))` : "",
  ].join(" ");
  const rows = await sqliteQuery(db,
    `SELECT ${await messageSelect(db)}
       FROM chat_message_join cmj
       JOIN message m ON m.ROWID = cmj.message_id
       LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE cmj.chat_id IN (${idList(chatIds)}) AND ${VISIBLE} ${bounds}
      ORDER BY m.date DESC, m.ROWID DESC
      LIMIT ${safeInt(limit) + 1};`);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const messages = page.map(toMessage).reverse();
  await Promise.all([
    attachAttachments(db, messages, page),
    attachReactions(db, chatIds, messages),
  ]);
  return { messages, hasMore };
}

async function withChats(db: string, rows: SqliteRow[]): Promise<MessageWithChat[]> {
  const messages = rows.map((r) => ({ ...toMessage(r), chat: toChatInfo(r) }));
  const participants = await participantsFor(db, [...new Set(messages.map((m) => m.chat.id))]);
  for (const m of messages) m.chat.participants = participants.get(m.chat.id) ?? [];
  await attachAttachments(db, messages, rows);
  return messages;
}

const CHAT_COLUMNS = `c.guid AS chat_guid, c.chat_identifier AS chat_identifier,
  COALESCE(c.display_name, '') AS display_name, COALESCE(c.service_name, '') AS service, c.style AS style`;

/** Unread incoming messages across all non-junk chats, newest first. */
export async function getUnread(
  db: string,
  limit: number,
  offset: number
): Promise<{ total: number; items: MessageWithChat[] }> {
  const rows = await sqliteQuery(db,
    `SELECT ${await messageSelect(db)}, ${CHAT_COLUMNS}, COUNT(*) OVER () AS total
       FROM chat_message_join cmj
       JOIN chat c ON c.ROWID = cmj.chat_id
       JOIN message m ON m.ROWID = cmj.message_id
       LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.is_from_me = 0 AND m.is_read = 0 AND ${VISIBLE} AND ${NOT_JUNK}
      ORDER BY m.date DESC, m.ROWID DESC
      LIMIT ${safeInt(limit)} OFFSET ${safeInt(offset)};`);
  const total = rows.length > 0 ? safeInt(rows[0].total) : 0;
  return { total, items: await withChats(db, rows) };
}

export interface SearchOptions {
  query: string;
  /** Restrict to messages exchanged with these normalised handles. */
  handles?: string[];
  /** ...or with handles ending in these digits (national-format contact numbers). */
  tails?: string[];
  sinceMs?: number;
  limit: number;
  offset: number;
}

/**
 * LIKE search over message bodies, including bodies stored only in
 * attributedBody. Case-insensitive for ASCII only (SQLite LIKE).
 */
export async function searchMessages(
  db: string,
  opts: SearchOptions
): Promise<{ total: number; items: MessageWithChat[] }> {
  const filters: string[] = [VISIBLE, NOT_JUNK];
  if (opts.sinceMs != null) filters.push(`${dateMsSql("m.date")} >= ${safeInt(opts.sinceMs)}`);
  if (opts.handles || opts.tails) {
    const conds: string[] = [];
    if (opts.handles && opts.handles.length > 0) {
      const list = sqlList(opts.handles);
      conds.push(`(m.is_from_me = 0 AND h.id IN (${list}))`, `(c.style = ${ONE_TO_ONE_STYLE} AND c.chat_identifier IN (${list}))`);
    }
    if (opts.tails && opts.tails.length > 0) {
      const list = sqlList(opts.tails);
      conds.push(`(m.is_from_me = 0 AND substr(h.id, -${TAIL_DIGITS}) IN (${list}))`,
        `(c.style = ${ONE_TO_ONE_STYLE} AND substr(c.chat_identifier, -${TAIL_DIGITS}) IN (${list}))`);
    }
    // A person filter that resolved to nothing matches nothing, rather than everything.
    filters.push(conds.length > 0 ? `(${conds.join(" OR ")})` : "0");
  }
  const cols = await messageColumns(db);
  const edited = cols.has("date_edited") ? "COALESCE(m.date_edited, 0) != 0" : "0";
  const like = sqlLikeEscape(opts.query);

  const rows = await sqliteQuery(db,
    `WITH s AS (
       SELECT m.ROWID AS id, m.guid AS guid, cmj.chat_id AS chat_id, m.date AS raw_date,
              ${dateMsSql("m.date")} AS date_ms, m.is_from_me AS is_from_me, m.is_read AS is_read,
              COALESCE(h.id, '') AS handle, m.text AS text, m.attributedBody AS b,
              instr(m.attributedBody, CAST('NSString' AS BLOB)) AS p,
              m.cache_has_attachments AS has_att, ${edited} AS edited, ${CHAT_COLUMNS}
         FROM message m
         JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         JOIN chat c ON c.ROWID = cmj.chat_id
         LEFT JOIN handle h ON h.ROWID = m.handle_id
        WHERE ${filters.join(" AND ")}
     ), t AS (
       SELECT *, COALESCE(NULLIF(text, ''), ${attributedBodyTextSql("b", "p")}) AS body FROM s
     )
     SELECT id, guid, chat_id, date_ms, is_from_me, is_read, handle, body AS text, NULL AS ab,
            has_att, edited, chat_guid, chat_identifier, display_name, service, style,
            COUNT(*) OVER () AS total
       FROM t
      WHERE body LIKE '%${like}%' ESCAPE '\\'
      ORDER BY raw_date DESC, id DESC
      LIMIT ${safeInt(opts.limit)} OFFSET ${safeInt(opts.offset)};`, 30_000);
  const total = rows.length > 0 ? safeInt(rows[0].total) : 0;
  return { total, items: await withChats(db, rows) };
}

/** Highest message ROWID, taken before a send so the new row can be found after it. */
export async function maxMessageId(db: string): Promise<number> {
  const rows = await sqliteQuery(db, "SELECT COALESCE(MAX(ROWID), 0) AS id FROM message;");
  return safeInt(rows[0]?.id ?? 0);
}

export interface SentRow {
  id: number;
  text: string;
  service: string;
  isSent: boolean;
  isDelivered: boolean;
  error: number;
}

/** Own messages newer than `afterId` in chats with these identifiers, newest first. */
export async function findSentAfter(db: string, identifiers: string[], afterId: number): Promise<SentRow[]> {
  if (identifiers.length === 0) return [];
  const rows = await sqliteQuery(db,
    `SELECT m.ROWID AS id, m.text AS text, CASE WHEN m.text IS NULL OR m.text = '' THEN hex(m.attributedBody) END AS ab,
            COALESCE(m.service, '') AS service, m.is_sent AS is_sent, m.is_delivered AS is_delivered, m.error AS error
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       JOIN chat c ON c.ROWID = cmj.chat_id
      WHERE m.ROWID > ${safeInt(afterId)} AND m.is_from_me = 1 AND m.item_type = 0
        AND c.chat_identifier IN (${sqlList(identifiers)})
      ORDER BY m.ROWID DESC LIMIT 10;`);
  return rows.map((r) => ({
    id: safeInt(r.id),
    text: messageText(r.text as string | null, r.ab as string | null),
    service: String(r.service || ""),
    isSent: Number(r.is_sent) === 1,
    isDelivered: Number(r.is_delivered) === 1,
    error: Number(r.error) || 0,
  }));
}
