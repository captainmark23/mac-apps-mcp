/**
 * Apple Messages (iMessage, SMS, RCS) MCP tools.
 *
 * Reads query ~/Library/Messages/chat.db directly (needs Full Disk Access).
 * Sending goes through Messages.app via JXA on the shared write queue.
 * Participants are named from Contacts, matched on normalised handles.
 *
 * Provides: listChats, getChat, getUnread, searchMessages, sendMessage, unreadSummary
 */

import { getMessagesDbPath, getMessagesHandlesAllowlist, matchesAllowlist, isSanitizeBodies } from "../shared/config.js";
import { PaginatedResult, paginateRows, stripInjectionPatterns } from "../shared/types.js";
import { getHandleNameMap, normalizeHandle, HandleNameMap } from "../contacts/tools.js";
import * as db from "./db.js";
import { sendText, SendVia } from "./jxa.js";

/** Characters of the last message shown in the chat list. */
const MAX_PREVIEW_CHARS = 200;

/** How long to watch chat.db for the sent message before reporting the outcome as unknown. */
const SEND_CONFIRM_MS = 10_000;
const SEND_POLL_MS = 500;

// ─── Output types ────────────────────────────────────────────────

export interface Person {
  name: string;
  handle: string;
}

export interface MessageOut {
  id: number;
  date: string;
  direction: "incoming" | "outgoing";
  sender: Person;
  text: string;
  read: boolean;
  edited: boolean;
  attachments: db.AttachmentInfo[];
  reactions: { reaction: string; from: string }[];
}

export interface ChatRef {
  chatId: number;
  chatIdentifier: string;
  name: string;
  isGroup: boolean;
}

export interface ChatOut extends ChatRef {
  service: string;
  participants: Person[];
}

export interface ChatSummary extends ChatOut {
  lastMessageDate: string;
  unreadCount: number;
  lastMessage: { direction: "incoming" | "outgoing"; sender: string; text: string; attachmentCount: number } | null;
}

export interface MessageInChat extends MessageOut {
  chat: ChatRef;
}

// ─── Formatting ──────────────────────────────────────────────────

function iso(ms: number | null): string {
  return ms == null ? "" : new Date(ms).toISOString();
}

function body(text: string): string {
  return isSanitizeBodies() ? stripInjectionPatterns(text) : text;
}

function person(handle: string, names: HandleNameMap): Person {
  return { name: names.lookup(handle) ?? handle, handle };
}

function chatName(chat: db.ChatInfo, names: HandleNameMap): string {
  if (chat.displayName) return chat.displayName;
  const handles = chat.participants.length > 0 ? chat.participants : [chat.chatIdentifier];
  return handles.map((h) => names.lookup(h) ?? h).join(", ");
}

function chatRef(chat: db.ChatInfo, names: HandleNameMap): ChatRef {
  return { chatId: chat.id, chatIdentifier: chat.chatIdentifier, name: chatName(chat, names), isGroup: chat.isGroup };
}

function chatOut(chat: db.ChatInfo, names: HandleNameMap): ChatOut {
  return { ...chatRef(chat, names), service: chat.service, participants: chat.participants.map((h) => person(h, names)) };
}

function messageOut(m: db.MessageRow, names: HandleNameMap): MessageOut {
  return {
    id: m.id,
    date: iso(m.dateMs),
    direction: m.isFromMe ? "outgoing" : "incoming",
    sender: m.isFromMe ? { name: "Me", handle: "" } : person(m.handle, names),
    text: body(m.text),
    read: m.isRead,
    edited: m.edited,
    attachments: m.attachments,
    reactions: m.reactions.map((r) => ({ reaction: r.reaction, from: r.fromMe ? "Me" : names.lookup(r.handle) ?? r.handle })),
  };
}

/** The forms a chat_identifier or handle may be stored under. */
function identifierVariants(raw: string): string[] {
  const trimmed = raw.trim();
  return [...new Set([trimmed, normalizeHandle(trimmed)])];
}

function parseIsoMs(value: string | undefined, label: string): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  if (isNaN(ms)) throw new Error(`Invalid ${label} date: ${value}`);
  return ms;
}

// ─── Read tools ──────────────────────────────────────────────────

export async function listChats(limit = 20, offset = 0, since?: string): Promise<PaginatedResult<ChatSummary>> {
  const path = getMessagesDbPath();
  const [result, names] = await Promise.all([
    db.listChats(path, limit, offset, parseIsoMs(since, "since")),
    getHandleNameMap(),
  ]);
  const items = result.chats.map((c): ChatSummary => {
    const last = c.lastMessage;
    return {
      ...chatOut(c, names),
      lastMessageDate: iso(c.lastMs),
      unreadCount: c.unreadCount,
      lastMessage: last ? {
        direction: last.isFromMe ? "outgoing" : "incoming",
        sender: last.isFromMe ? "Me" : names.lookup(last.handle) ?? last.handle,
        text: body(last.text.slice(0, MAX_PREVIEW_CHARS)),
        attachmentCount: last.attachments.length,
      } : null,
    };
  });
  return paginateRows(items, result.total, offset);
}

export async function getChat(
  ref: { chatIdentifier?: string; chatId?: number },
  limit = 50,
  before?: string,
  after?: string,
  beforeId?: number
): Promise<{ chat: ChatOut; count: number; has_more: boolean; next_before_id?: number; messages: MessageOut[] }> {
  if ((ref.chatIdentifier == null) === (ref.chatId == null)) {
    throw new Error("Give exactly one of chat_identifier or chat_id.");
  }
  const path = getMessagesDbPath();
  const chats = await db.findChats(path, ref.chatId != null
    ? { chatId: ref.chatId }
    : { identifiers: identifierVariants(ref.chatIdentifier!) });
  if (chats.length === 0) throw new Error("Chat not found. Use messages_list_chats to find its chat_identifier.");

  const [page, names] = await Promise.all([
    db.getChatMessages(path, chats.map((c) => c.id), limit, parseIsoMs(before, "before"), parseIsoMs(after, "after"), beforeId),
    getHandleNameMap(),
  ]);
  const messages = page.messages.map((m) => messageOut(m, names));
  const chat = chatOut(chats[0], names);
  // Chats split across services share one identifier; report every participant.
  for (const c of chats.slice(1)) {
    for (const h of c.participants) {
      if (!chat.participants.some((p) => p.handle === h)) chat.participants.push(person(h, names));
    }
  }
  return {
    chat,
    count: messages.length,
    has_more: page.hasMore,
    ...(page.hasMore && messages.length > 0 ? { next_before_id: messages[0].id } : {}),
    messages,
  };
}

function inChat(m: db.MessageWithChat, names: HandleNameMap): MessageInChat {
  return { ...messageOut(m, names), chat: chatRef(m.chat, names) };
}

export async function getUnread(limit = 50, offset = 0): Promise<PaginatedResult<MessageInChat>> {
  const [result, names] = await Promise.all([
    db.getUnread(getMessagesDbPath(), limit, offset),
    getHandleNameMap(),
  ]);
  return paginateRows(result.items.map((m) => inChat(m, names)), result.total, offset);
}

export async function searchMessages(
  query: string,
  opts: { handle?: string; contact?: string; since?: string; limit?: number; offset?: number } = {}
): Promise<PaginatedResult<MessageInChat>> {
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  const names = await getHandleNameMap();

  let handles: string[] | undefined;
  let tails: string[] | undefined;
  if (opts.handle) {
    handles = identifierVariants(opts.handle);
  }
  if (opts.contact) {
    const found = names.handlesForName(opts.contact);
    handles = [...(handles ?? []), ...found.handles];
    tails = found.tails;
  }

  const result = await db.searchMessages(getMessagesDbPath(), {
    query,
    handles,
    tails,
    sinceMs: parseIsoMs(opts.since, "since"),
    limit,
    offset,
  });
  return paginateRows(result.items.map((m) => inChat(m, names)), result.total, offset);
}

/** Unread count and the newest few unread messages, for daily_briefing. */
export async function unreadSummary(top = 5): Promise<{ unreadCount: number; unread: MessageInChat[] }> {
  const result = await getUnread(top, 0);
  return { unreadCount: result.total, unread: result.items };
}

// ─── Send ────────────────────────────────────────────────────────

export interface SendResult {
  success: boolean;
  message: string;
  chatIdentifier: string;
  via: SendVia;
  service: string;
  /** sent / delivered / failed from chat.db; unknown if the row did not appear in time. */
  status: "sent" | "delivered" | "pending" | "failed" | "unknown";
}

function checkAllowlist(recipients: string[]): void {
  const allowed = getMessagesHandlesAllowlist();
  if (!allowed) return;
  const patterns = allowed.map((a) => (a.includes("*") ? a.toLowerCase() : normalizeHandle(a)));
  const blocked = recipients.find((r) => !matchesAllowlist(normalizeHandle(r), patterns));
  if (blocked) throw new Error(`Recipient ${blocked} is not in MACOS_MCP_MESSAGES_HANDLES_ALLOWLIST.`);
}

/**
 * Send a text to a handle or an existing chat. Refuses a handle with no chat
 * and no matching contact unless confirmed, and reports what chat.db shows
 * after the send rather than assuming success.
 */
export async function sendMessage(
  text: string,
  target: { to?: string; chatIdentifier?: string },
  confirm: boolean
): Promise<SendResult | { warning: string }> {
  if ((target.to == null) === (target.chatIdentifier == null)) {
    throw new Error("Give exactly one of to or chat_identifier.");
  }
  if (!text.trim()) throw new Error("Message text is empty.");
  const path = getMessagesDbPath();
  const names = await getHandleNameMap();

  let chats: db.ChatInfo[];
  let handle: string | undefined;
  if (target.chatIdentifier != null) {
    chats = await db.findChats(path, { identifiers: identifierVariants(target.chatIdentifier) });
    if (chats.length === 0) throw new Error("Chat not found. Use messages_list_chats to find its chat_identifier.");
    if (!chats[0].isGroup) handle = chats[0].participants[0] ?? chats[0].chatIdentifier;
  } else {
    handle = normalizeHandle(target.to!);
    chats = await db.findChats(path, { identifiers: identifierVariants(target.to!), oneToOne: true });
  }
  const chat = chats[0];

  const recipients = chat ? (chat.participants.length > 0 ? chat.participants : [chat.chatIdentifier]) : [handle!];
  checkAllowlist(recipients);

  if (!chat && !names.lookup(handle!) && !confirm) {
    return {
      warning: `No existing chat or contact for ${handle}. Check the number with the user, then call again with confirm: true.`,
    };
  }

  const identifiers = chat ? [...new Set(chats.map((c) => c.chatIdentifier))] : [handle!];
  const before = await db.maxMessageId(path);
  const via = await sendText({
    chatGuid: chat?.guid,
    handle,
    allowSms: chats.some((c) => c.service === "SMS"),
  }, text);

  const wanted = text.trim();
  const deadline = Date.now() + SEND_CONFIRM_MS;
  let row: db.SentRow | undefined;
  while (Date.now() < deadline) {
    // Only the row with our text counts: another send to the same chat may land first.
    row = (await db.findSentAfter(path, identifiers, before)).find((r) => r.text === wanted);
    if (row && (row.error !== 0 || row.isSent || row.isDelivered)) break;
    await new Promise((r) => setTimeout(r, SEND_POLL_MS));
  }

  const status: SendResult["status"] = !row ? "unknown"
    : row.error !== 0 ? "failed"
    : row.isDelivered ? "delivered"
    : row.isSent ? "sent"
    : "pending";
  const recipientName = chat ? chatName(chat, names) : names.lookup(handle!) ?? handle!;
  const outcome = {
    sent: "Sent",
    delivered: "Delivered",
    pending: "Queued in Messages, not yet sent",
    failed: `Messages reported an error (${row?.error})`,
    unknown: "Handed to Messages; not yet visible in chat.db, so the outcome is unknown",
  }[status];
  return {
    success: status !== "failed",
    message: `${outcome}: ${recipientName}.`,
    chatIdentifier: chat?.chatIdentifier ?? handle!,
    via,
    service: row?.service ?? "",
    status,
  };
}
