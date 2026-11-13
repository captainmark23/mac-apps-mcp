/**
 * WhatsApp MCP tools. Read-only: nothing here sends or changes anything.
 *
 * Reads the WhatsApp desktop app's ChatStorage.sqlite (needs Full Disk
 * Access). The history is only as current as the app on this Mac, so
 * WhatsApp must stay installed, signed in and running.
 *
 * People are named from WhatsApp's copy of the address book, then the name
 * they chose for their own profile (shown as "~Name", as WhatsApp does),
 * then their phone number.
 *
 * Provides: listChats, getChat, searchMessages, getUnread. Each takes the
 * database paths last so tests can point it at a fixture.
 */

import { basename } from "node:path";
import { getWhatsAppDbPaths, isSanitizeBodies, TtlCache } from "../shared/config.js";
import { PaginatedResult, paginateRows, stripInjectionPatterns } from "../shared/types.js";
import * as db from "./db.js";

/** Characters of the last message shown in the chat list. */
const MAX_PREVIEW_CHARS = 200;

/** Most contacts a name filter may match before it is refused as too broad. */
const MAX_NAME_MATCHES = 500;

/** Members shown in the name of a group that has no subject. */
const MAX_MEMBERS_IN_NAME = 3;

/** Chats listed when a name matches more than one. */
const MAX_CANDIDATES = 8;

// ─── Output types ────────────────────────────────────────────────

export interface Person {
  /** Saved contact name, "~profile name", phone number, or "Unknown". */
  name: string;
  /** E.164 number, or "" when WhatsApp only holds a privacy id for this person. */
  phone: string;
}

export interface Media {
  type: string;
  fileName: string;
}

export interface ChatRef {
  chatId: number;
  name: string;
  isGroup: boolean;
}

export interface ChatSummary extends ChatRef {
  /** The other person's number in a one-to-one chat; "" for groups. */
  phone: string;
  lastMessageDate: string;
  unreadCount: number;
  archived: boolean;
  lastMessage: { direction: "incoming" | "outgoing"; sender: string; text: string; mediaType: string } | null;
}

export interface MessageOut {
  id: number;
  date: string;
  direction: "incoming" | "outgoing";
  sender: Person;
  text: string;
  media: Media | null;
}

export interface MessageInChat extends MessageOut {
  chat: ChatRef;
}

/** Paginated result plus the time of the newest message WhatsApp has stored on this Mac. */
export type WithHistoryDate<T> = PaginatedResult<T> & { history_current_to: string };

// ─── Names ───────────────────────────────────────────────────────

const PHONE_JID = /^(\d+)@s\.whatsapp\.net$/;

/** Resolves WhatsApp ids to names and phone numbers. */
export class NameDirectory {
  private contactName = new Map<string, string>();
  private profileName = new Map<string, string>();
  private phoneJidOfLid = new Map<string, string>();

  constructor(rows: db.NameRows) {
    for (const c of rows.contacts) {
      if (c.phoneJid) this.contactName.set(c.phoneJid, c.name);
      if (c.lidJid) this.contactName.set(c.lidJid, c.name);
      if (c.phoneJid && c.lidJid) this.phoneJidOfLid.set(c.lidJid, c.phoneJid);
    }
    for (const p of rows.profiles) this.profileName.set(p.jid, p.name);
  }

  phone(jid: string): string {
    const digits = PHONE_JID.exec(this.phoneJidOfLid.get(jid) ?? jid)?.[1];
    return digits ? `+${digits}` : "";
  }

  /** Saved contact name, else "~profile name", else undefined. */
  name(jid: string): string | undefined {
    const contact = this.contactName.get(jid);
    if (contact) return contact;
    const profile = this.profileName.get(jid);
    return profile ? `~${profile}` : undefined;
  }

  person(jid: string): Person {
    const phone = this.phone(jid);
    return { name: this.name(jid) ?? (phone || "Unknown"), phone };
  }

  /** Every id whose contact or profile name contains `text` (case-insensitive). */
  jidsForName(text: string): string[] {
    const needle = text.trim().toLowerCase();
    const out = new Set<string>();
    if (!needle) return [];
    for (const names of [this.contactName, this.profileName]) {
      for (const [jid, name] of names) {
        if (name.toLowerCase().includes(needle)) out.add(jid);
      }
    }
    return [...out];
  }
}

const _directories = new TtlCache<string, NameDirectory>();

async function getDirectory(paths: { chats: string; contacts: string }): Promise<NameDirectory> {
  let dir = _directories.get(paths.chats);
  if (!dir) {
    dir = new NameDirectory(await db.loadNames(paths.chats, paths.contacts));
    _directories.set(paths.chats, dir);
  }
  return dir;
}

// ─── Formatting ──────────────────────────────────────────────────

/** ISO 8601 in this Mac's time zone with its UTC offset, e.g. 2026-11-09T22:33:41-08:00. */
export function isoLocal(ms: number | null): string {
  if (ms == null) return "";
  const offsetMin = -new Date(ms).getTimezoneOffset();
  const abs = Math.abs(offsetMin);
  const two = (n: number) => String(n).padStart(2, "0");
  const local = new Date(ms + offsetMin * 60_000).toISOString().slice(0, 19);
  return `${local}${offsetMin < 0 ? "-" : "+"}${two(Math.trunc(abs / 60))}:${two(abs % 60)}`;
}

function body(text: string): string {
  return isSanitizeBodies() ? stripInjectionPatterns(text) : text;
}

/** ZMESSAGETYPE values whose meaning was confirmed from stored files and fields. */
const MEDIA_TYPES: Record<number, string> = {
  1: "image", 2: "video", 3: "audio", 4: "contact", 5: "location",
  8: "document", 11: "gif", 15: "sticker", 23: "video", 43: "video",
};

const TEXT_TYPES = new Set([0, 7]); // plain text, text with a link preview

const FILE_NAME = /\.[A-Za-z0-9]{2,5}$/;

/** A message's text and media. Media is reported by type and file name only, never content. */
export function textAndMedia(m: Pick<db.MessageRow, "type" | "text" | "title" | "localPath">): { text: string; media: Media | null } {
  if (TEXT_TYPES.has(m.type)) return { text: m.text, media: null };
  const type = MEDIA_TYPES[m.type] ?? `other (type ${m.type})`;
  const stored = m.localPath ? basename(m.localPath) : "";
  if (type === "document") {
    // The file name is in the title or the text, whichever looks like one.
    const fileName = [m.title, m.text].find((v) => FILE_NAME.test(v)) ?? stored;
    const text = [m.text, m.title].find((v) => v && v !== fileName) ?? "";
    return { text, media: { type, fileName } };
  }
  return { text: m.text || m.title, media: { type, fileName: stored } };
}

function chatName(chat: db.ChatInfo, names: NameDirectory): string {
  if (chat.isGroup) {
    if (chat.name) return chat.name;
    // No subject: name it by its members, as WhatsApp does.
    const members = (chat.memberJids ?? []).map((jid) => names.person(jid).name).filter((n) => n !== "Unknown");
    if (members.length === 0) return "Unnamed group";
    const extra = (chat.memberJids?.length ?? 0) - Math.min(members.length, MAX_MEMBERS_IN_NAME);
    return members.slice(0, MAX_MEMBERS_IN_NAME).join(", ") + (extra > 0 ? ` +${extra}` : "");
  }
  return names.name(chat.jid) ?? (chat.name || names.phone(chat.jid) || "Unknown");
}

function chatRef(chat: db.ChatInfo, names: NameDirectory): ChatRef {
  return { chatId: chat.id, name: chatName(chat, names), isGroup: chat.isGroup };
}

function sender(m: db.MessageRow, names: NameDirectory): Person {
  if (m.isFromMe) return { name: "Me", phone: "" };
  return m.senderJid ? names.person(m.senderJid) : { name: "Unknown", phone: "" };
}

function messageOut(m: db.MessageRow, names: NameDirectory): MessageOut {
  const { text, media } = textAndMedia(m);
  return {
    id: m.id,
    date: isoLocal(m.dateMs),
    direction: m.isFromMe ? "outgoing" : "incoming",
    sender: sender(m, names),
    text: body(text),
    media,
  };
}

function inChat(m: db.MessageRow, names: NameDirectory): MessageInChat {
  return { ...messageOut(m, names), chat: chatRef(m.chat, names) };
}

function parseIsoMs(value: string | undefined, label: string): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  if (isNaN(ms)) throw new Error(`Invalid ${label} date: ${value}`);
  return ms;
}

function jidsForContact(names: NameDirectory, contact: string): string[] {
  const jids = names.jidsForName(contact);
  if (jids.length === 0) throw new Error(`No WhatsApp contact matches "${contact}".`);
  if (jids.length > MAX_NAME_MATCHES) throw new Error(`"${contact}" matches too many contacts. Use a longer name.`);
  return jids;
}

/** The one chat a chat_id or chat_name refers to; a name must match exactly one chat, or one exactly. */
async function resolveChat(
  path: string, names: NameDirectory, ref: { chatId?: number; chatName?: string }
): Promise<db.ChatInfo> {
  if ((ref.chatId == null) === (ref.chatName == null)) {
    throw new Error("Give exactly one of chat_id or chat_name.");
  }
  if (ref.chatId != null) {
    const [chat] = await db.findChats(path, { chatId: ref.chatId });
    if (!chat) throw new Error("Chat not found. Use whatsapp_list_chats to find its chat_id.");
    return chat;
  }
  // Compare without the "~" that marks profile names, so a displayed name can be passed back.
  const strip = (name: string) => name.replace(/~/g, "").trim().toLowerCase();
  const wanted = strip(ref.chatName!);
  if (!wanted) throw new Error("chat_name is empty.");
  const plain = (c: db.ChatInfo) => strip(chatName(c, names));
  const candidates = await db.findChats(path, {
    name: wanted,
    jids: names.jidsForName(wanted).slice(0, MAX_NAME_MATCHES),
  });
  // Groups with no subject are all candidates; keep those whose member-based name matches.
  const found = candidates.filter((c) => !(c.isGroup && !c.name) || plain(c).includes(wanted));
  const exact = found.filter((c) => plain(c) === wanted);
  const matches = exact.length > 0 ? exact : found;
  if (matches.length === 0) throw new Error(`No WhatsApp chat matches "${ref.chatName}". Use whatsapp_list_chats to find it.`);
  if (matches.length > 1) {
    const shown = matches.slice(0, MAX_CANDIDATES).map((c) => `${chatName(c, names)} (chat_id ${c.id})`).join("; ");
    throw new Error(`${matches.length} chats match "${ref.chatName}": ${shown}. Call again with chat_id.`);
  }
  return matches[0];
}

// ─── Tools ───────────────────────────────────────────────────────

export async function listChats(limit = 20, offset = 0, paths = getWhatsAppDbPaths()): Promise<WithHistoryDate<ChatSummary>> {
  const [page, latest, names] = await Promise.all([
    db.listChats(paths.chats, limit, offset),
    db.latestMessageMs(paths.chats),
    getDirectory(paths),
  ]);
  const items = page.items.map((c): ChatSummary => {
    const last = c.lastMessage;
    const shown = last ? textAndMedia(last) : null;
    return {
      ...chatRef(c, names),
      phone: c.isGroup ? "" : names.phone(c.jid),
      lastMessageDate: isoLocal(c.lastMs),
      unreadCount: c.unreadCount,
      archived: c.archived,
      lastMessage: last && shown ? {
        direction: last.isFromMe ? "outgoing" : "incoming",
        sender: sender(last, names).name,
        text: body(shown.text.slice(0, MAX_PREVIEW_CHARS)),
        mediaType: shown.media?.type ?? "",
      } : null,
    };
  });
  return { ...paginateRows(items, page.total, offset), history_current_to: isoLocal(latest) };
}

export async function getChat(
  ref: { chatId?: number; chatName?: string },
  limit = 50,
  offset = 0,
  since?: string,
  paths = getWhatsAppDbPaths()
): Promise<PaginatedResult<MessageOut> & { chat: ChatRef }> {
  const names = await getDirectory(paths);
  const chat = await resolveChat(paths.chats, names, ref);
  const page = await db.getChatMessages(paths.chats, chat.id, limit, offset, parseIsoMs(since, "since"));
  return {
    chat: chatRef(chat, names),
    ...paginateRows(page.items.map((m) => messageOut(m, names)), page.total, offset),
  };
}

export async function searchMessages(
  query: string,
  opts: { chatId?: number; chatName?: string; contact?: string; since?: string; limit?: number; offset?: number } = {},
  paths = getWhatsAppDbPaths()
): Promise<PaginatedResult<MessageInChat>> {
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  const names = await getDirectory(paths);
  const chat = opts.chatId != null || opts.chatName != null
    ? await resolveChat(paths.chats, names, { chatId: opts.chatId, chatName: opts.chatName })
    : undefined;
  const page = await db.searchMessages(paths.chats, {
    query,
    chatId: chat?.id,
    jids: opts.contact ? jidsForContact(names, opts.contact) : undefined,
    sinceMs: parseIsoMs(opts.since, "since"),
    limit,
    offset,
  });
  return paginateRows(page.items.map((m) => inChat(m, names)), page.total, offset);
}

export async function getUnread(limit = 50, offset = 0, paths = getWhatsAppDbPaths()): Promise<WithHistoryDate<MessageInChat>> {
  const [page, latest, names] = await Promise.all([
    db.getUnread(paths.chats, limit, offset),
    db.latestMessageMs(paths.chats),
    getDirectory(paths),
  ]);
  return {
    ...paginateRows(page.items.map((m) => inChat(m, names)), page.total, offset),
    history_current_to: isoLocal(latest),
  };
}
