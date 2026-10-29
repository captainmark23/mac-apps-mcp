/**
 * Tests for the Messages module.
 *
 * Parsing tests use attributedBody blobs captured from real messages (test
 * texts sent to the maintainer's own number; they hold no other data). Query
 * tests run against a fixture chat.db built here with the system sqlite3, so
 * CI never needs a real Messages database.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractAttributedBodyText, extractAttributedBodyHex, messageText } from "../messages/attributed-body.js";
import * as db from "../messages/db.js";
import { normalizeHandle, nationalTail } from "../contacts/tools.js";
import { isMessagesEnabled, getMessagesHandlesAllowlist } from "../shared/config.js";

/** Captured: "mac-apps-mcp test 1" (one-byte length). */
const BLOB_SHORT =
  "040B73747265616D747970656481E803840140848484124E5341747472696275746564537472696E67008484084E534F626A656374008592848484084E53537472696E67019484012B136D61632D617070732D6D63702074657374203186840269490113928484840C4E5344696374696F6E617279009484016901928496961D5F5F6B494D4D657373616765506172744174747269627574654E616D658692848484084E534E756D626572008484074E5356616C7565009484012A84999900868686";

/** Captured: a 148-byte message with accents, CJK and an arrow (0x81 two-byte length). */
const BLOB_LONG =
  "040B73747265616D747970656481E803840140848484124E5341747472696275746564537472696E67008484084E534F626A656374008592848484084E53537472696E67019484012B8194006D61632D617070732D6D6370207465737420323A2061206C6F6E676572206D65737361676520746F20636865636B207468652074776F2D62797465206C656E6774682070617468207768656E2072656164696E672061747472696275746564426F64792E20436166C3A92C206E61C3AF76652C20E697A5E69CACE8AA9E2C20616E6420616E206172726F7720E2869220656E642E868402694901818A00928484840C4E5344696374696F6E617279009484016901928496961D5F5F6B494D4D657373616765506172744174747269627574654E616D658692848484084E534E756D626572008484074E5356616C7565009484012A84999900868686";

const LONG_TEXT =
  "mac-apps-mcp test 2: a longer message to check the two-byte length path when reading attributedBody. Café, naïve, 日本語, and an arrow → end.";

// ─── attributedBody extraction ───────────────────────────────────

describe("extractAttributedBodyText", () => {
  it("reads a one-byte length payload", () => {
    assert.equal(extractAttributedBodyHex(BLOB_SHORT), "mac-apps-mcp test 1");
  });

  it("reads a 0x81 two-byte length payload with multi-byte UTF-8", () => {
    assert.equal(extractAttributedBodyHex(BLOB_LONG), LONG_TEXT);
  });

  it("reads a 0x82 four-byte length payload", () => {
    const blob = Buffer.from(BLOB_SHORT, "hex");
    const tag = blob.indexOf(Buffer.from("NSString")) + 12;
    const text = Buffer.from("x".repeat(70_000));
    const len = Buffer.alloc(5);
    len[0] = 0x82;
    len.writeUInt32LE(text.length, 1);
    const rebuilt = Buffer.concat([blob.subarray(0, tag + 1), len, text, blob.subarray(tag + 2 + 19)]);
    assert.equal(extractAttributedBodyText(rebuilt), text.toString());
  });

  it("returns null for empty, missing or non-archive input", () => {
    assert.equal(extractAttributedBodyText(null), null);
    assert.equal(extractAttributedBodyText(Buffer.alloc(0)), null);
    assert.equal(extractAttributedBodyText(Buffer.from("no marker here")), null);
    assert.equal(extractAttributedBodyHex(""), null);
    assert.equal(extractAttributedBodyHex("abc"), null);
  });

  it("returns null when the length runs past the end", () => {
    const blob = Buffer.from(BLOB_SHORT, "hex");
    const truncated = blob.subarray(0, blob.indexOf(Buffer.from("NSString")) + 20);
    assert.equal(extractAttributedBodyText(truncated), null);
  });
});

describe("messageText", () => {
  it("prefers the text column", () => {
    assert.equal(messageText("plain", BLOB_SHORT), "plain");
  });

  it("falls back to attributedBody", () => {
    assert.equal(messageText(null, BLOB_SHORT), "mac-apps-mcp test 1");
  });

  it("drops attachment placeholders", () => {
    assert.equal(messageText("￼Look at this", null), "Look at this");
    assert.equal(messageText("￼", null), "");
  });
});

// ─── Handles ─────────────────────────────────────────────────────

describe("normalizeHandle", () => {
  it("keeps E.164 and strips formatting", () => {
    assert.equal(normalizeHandle("+1 (415) 555-0101"), "+14155550101");
    assert.equal(normalizeHandle("+44 7700 900123"), "+447700900123");
  });

  it("treats ten-digit numbers as North American", () => {
    assert.equal(normalizeHandle("(415) 555-0101"), "+14155550101");
    assert.equal(normalizeHandle("1-415-555-0101"), "+14155550101");
  });

  it("converts a 00 international prefix", () => {
    assert.equal(normalizeHandle("0044 7700 900123"), "+447700900123");
  });

  it("leaves national numbers and short codes as digits", () => {
    assert.equal(normalizeHandle("07700 900123"), "07700900123");
    assert.equal(normalizeHandle("72975"), "72975");
  });

  it("lowercases email handles", () => {
    assert.equal(normalizeHandle(" Someone@Example.COM "), "someone@example.com");
  });

  it("gives the same tail for national and international forms", () => {
    assert.equal(nationalTail("07700900123"), nationalTail("+447700900123"));
    assert.equal(nationalTail("123"), null);
  });
});

// ─── Tapbacks ────────────────────────────────────────────────────

describe("tapbacks", () => {
  it("names tapback types", () => {
    assert.equal(db.tapbackName(2000), "love");
    assert.equal(db.tapbackName(2003), "laugh");
    assert.equal(db.tapbackName(3005), "question");
    assert.equal(db.tapbackName(2006, "\u{1F389}"), "\u{1F389}");
    assert.equal(db.tapbackName(2006, null), "emoji");
    assert.equal(db.tapbackName(2007), "sticker");
  });

  it("strips part prefixes from the target guid", () => {
    assert.equal(db.tapbackTarget("p:0/ABC-123"), "ABC-123");
    assert.equal(db.tapbackTarget("p:12/ABC-123"), "ABC-123");
    assert.equal(db.tapbackTarget("bp:ABC-123"), "ABC-123");
    assert.equal(db.tapbackTarget("ABC-123"), "ABC-123");
  });

  it("keeps one current tapback per person, applying replacements and removals", () => {
    const folded = db.foldReactions([
      { type: 2000, target: "p:0/A", fromMe: false, handle: "+1" },
      { type: 2001, target: "p:0/A", fromMe: true, handle: "" },
      { type: 2003, target: "p:0/A", fromMe: false, handle: "+1" },
      { type: 3001, target: "p:0/A", fromMe: true, handle: "" },
      { type: 2004, target: "bp:B", fromMe: true, handle: "" },
      { type: 1000, target: "p:0/C", fromMe: true, handle: "" },
    ]);
    assert.deepEqual(folded.get("A"), [{ reaction: "laugh", fromMe: false, handle: "+1" }]);
    assert.deepEqual(folded.get("B"), [{ reaction: "emphasize", fromMe: true, handle: "" }]);
    assert.equal(folded.has("C"), false);
  });
});

// ─── Config ──────────────────────────────────────────────────────

describe("messages config", () => {
  it("is on unless switched off", () => {
    const saved = process.env.MACOS_MCP_MESSAGES;
    try {
      delete process.env.MACOS_MCP_MESSAGES;
      assert.equal(isMessagesEnabled(), true);
      for (const off of ["off", "OFF", "false", "0"]) {
        process.env.MACOS_MCP_MESSAGES = off;
        assert.equal(isMessagesEnabled(), false);
      }
      process.env.MACOS_MCP_MESSAGES = "on";
      assert.equal(isMessagesEnabled(), true);
    } finally {
      if (saved === undefined) delete process.env.MACOS_MCP_MESSAGES;
      else process.env.MACOS_MCP_MESSAGES = saved;
    }
  });

  it("parses the handles allowlist", () => {
    const saved = process.env.MACOS_MCP_MESSAGES_HANDLES_ALLOWLIST;
    try {
      delete process.env.MACOS_MCP_MESSAGES_HANDLES_ALLOWLIST;
      assert.equal(getMessagesHandlesAllowlist(), null);
      process.env.MACOS_MCP_MESSAGES_HANDLES_ALLOWLIST = " +14155550101, a@example.com ,";
      assert.deepEqual(getMessagesHandlesAllowlist(), ["+14155550101", "a@example.com"]);
    } finally {
      if (saved === undefined) delete process.env.MACOS_MCP_MESSAGES_HANDLES_ALLOWLIST;
      else process.env.MACOS_MCP_MESSAGES_HANDLES_ALLOWLIST = saved;
    }
  });
});

// ─── Fixture chat.db ─────────────────────────────────────────────

const APPLE_EPOCH = 978307200;

/** Nanoseconds since 2001 for a Unix time, as an exact SQL literal. */
function ns(unixSec: number): string {
  return (BigInt(unixSec - APPLE_EPOCH) * 1_000_000_000n).toString();
}

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0) / 1000; // 2026-10-20T12:00:00Z

/** Schema subset of chat.db plus a few rows covering each case the module handles. */
const FIXTURE_SQL = `
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT NOT NULL, service TEXT);
CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT UNIQUE NOT NULL, style INTEGER, chat_identifier TEXT,
  service_name TEXT, display_name TEXT, is_filtered INTEGER DEFAULT 0);
CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT UNIQUE NOT NULL, text TEXT, attributedBody BLOB,
  handle_id INTEGER DEFAULT 0, service TEXT, date INTEGER, is_from_me INTEGER DEFAULT 0, is_read INTEGER DEFAULT 0,
  is_sent INTEGER DEFAULT 0, is_delivered INTEGER DEFAULT 0, error INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0,
  associated_message_type INTEGER DEFAULT 0, associated_message_guid TEXT, associated_message_emoji TEXT,
  cache_has_attachments INTEGER DEFAULT 0, date_edited INTEGER DEFAULT 0);
CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER, UNIQUE(chat_id, handle_id));
CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, transfer_name TEXT, mime_type TEXT, total_bytes INTEGER DEFAULT 0);
CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);

INSERT INTO handle VALUES (1, '+14155550101', 'iMessage'), (2, 'friend@example.com', 'iMessage'),
  (3, '+14155550199', 'SMS'), (4, '+447700900123', 'iMessage');

INSERT INTO chat VALUES
  (1, 'any;-;+14155550101', 45, '+14155550101', 'iMessage', NULL, 0),
  (2, 'any;+;chat100', 43, 'chat100', 'iMessage', 'Test Group', 0),
  (3, 'any;-;+14155550199', 45, '+14155550199', 'SMS', NULL, 2),
  (4, 'any;-;+447700900123', 45, '+447700900123', 'iMessage', NULL, 0);

INSERT INTO chat_handle_join VALUES (1, 1), (2, 1), (2, 2), (3, 3), (4, 4);

INSERT INTO message (ROWID, guid, text, attributedBody, handle_id, service, date, is_from_me, is_read, is_sent, is_delivered,
  item_type, associated_message_type, associated_message_guid, associated_message_emoji, cache_has_attachments, date_edited) VALUES
  (1, 'G1', 'Hello there', NULL, 1, 'iMessage', ${ns(T0)}, 0, 1, 0, 0, 0, 0, NULL, NULL, 0, 0),
  (2, 'G2', NULL, X'${BLOB_SHORT}', 1, 'iMessage', ${ns(T0 + 60)}, 1, 0, 1, 1, 0, 0, NULL, NULL, 0, ${ns(T0 + 90)}),
  (3, 'G3', NULL, X'${BLOB_LONG}', 1, 'iMessage', ${ns(T0 + 120)}, 0, 0, 0, 0, 0, 0, NULL, NULL, 0, 0),
  (4, 'G4', 'Group hello', NULL, 2, 'iMessage', ${ns(T0 + 30)}, 0, 1, 0, 0, 0, 0, NULL, NULL, 0, 0),
  (5, 'G5', NULL, NULL, 1, 'iMessage', ${ns(T0 + 40)}, 0, 1, 0, 0, 0, 2000, 'p:0/G4', NULL, 0, 0),
  (6, 'G6', NULL, NULL, 0, 'iMessage', ${ns(T0 + 41)}, 1, 0, 1, 0, 0, 2001, 'p:0/G4', NULL, 0, 0),
  (7, 'G7', NULL, NULL, 0, 'iMessage', ${ns(T0 + 42)}, 1, 0, 1, 0, 0, 3001, 'p:0/G4', NULL, 0, 0),
  (8, 'G8', NULL, NULL, 2, 'iMessage', ${ns(T0 + 43)}, 0, 1, 0, 0, 1, 0, NULL, NULL, 0, 0),
  (9, 'G9', 'You won a prize', NULL, 3, 'SMS', ${ns(T0 + 200)}, 0, 0, 0, 0, 0, 0, NULL, NULL, 0, 0),
  (10, 'G10', 'Old message', NULL, 1, 'iMessage', 600000000, 0, 1, 0, 0, 0, 0, NULL, NULL, 0, 0),
  (11, 'G11', char(65532), NULL, 2, 'iMessage', ${ns(T0 + 50)}, 0, 1, 0, 0, 0, 0, NULL, NULL, 1, 0),
  (12, 'G12', 'Hello from London', NULL, 4, 'iMessage', ${ns(T0 - 3600)}, 0, 1, 0, 0, 0, 0, NULL, NULL, 0, 0),
  (13, 'G13', NULL, NULL, 2, 'iMessage', ${ns(T0 + 55)}, 0, 1, 0, 0, 0, 2006, 'p:0/G11', char(127881), 0, 0);

INSERT INTO chat_message_join (chat_id, message_id, message_date)
  SELECT CASE WHEN ROWID IN (1, 2, 3, 10) THEN 1 WHEN ROWID = 9 THEN 3 WHEN ROWID = 12 THEN 4 ELSE 2 END, ROWID, date FROM message;

INSERT INTO attachment VALUES (1, 'photo.jpg', 'image/jpeg', 1234);
INSERT INTO message_attachment_join VALUES (11, 1);
`;

describe("Messages queries (fixture chat.db)", () => {
  let dir: string;
  let path: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "macos-mcp-messages-"));
    path = join(dir, "chat.db");
    execFileSync("/usr/bin/sqlite3", [path], { input: FIXTURE_SQL });
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists chats newest first, without junk, with participants, unread and last message", async () => {
    const { total, chats } = await db.listChats(path, 10, 0);
    assert.equal(total, 3);
    assert.deepEqual(chats.map((c) => c.chatIdentifier), ["+14155550101", "chat100", "+447700900123"]);

    const [oneToOne, group] = chats;
    assert.equal(oneToOne.isGroup, false);
    assert.equal(oneToOne.unreadCount, 1);
    assert.deepEqual(oneToOne.participants, ["+14155550101"]);
    assert.equal(oneToOne.lastMessage?.text, LONG_TEXT);
    assert.equal(oneToOne.lastMs, (T0 + 120) * 1000);

    assert.equal(group.isGroup, true);
    assert.equal(group.displayName, "Test Group");
    assert.deepEqual([...group.participants].sort(), ["+14155550101", "friend@example.com"]);
    // The last visible message, not the later tapback or system row.
    assert.equal(group.lastMessage?.id, 11);
    assert.equal(group.lastMessage?.text, "");
    assert.deepEqual(group.lastMessage?.attachments, [{ name: "photo.jpg", mimeType: "image/jpeg", size: 1234 }]);
  });

  it("filters chats by last activity and paginates", async () => {
    const recent = await db.listChats(path, 10, 0, (T0 + 100) * 1000);
    assert.deepEqual(recent.chats.map((c) => c.chatIdentifier), ["+14155550101"]);
    const page2 = await db.listChats(path, 1, 1);
    assert.equal(page2.total, 3);
    assert.deepEqual(page2.chats.map((c) => c.chatIdentifier), ["chat100"]);
  });

  it("reads a group chat oldest first with tapbacks folded, not listed", async () => {
    const { messages, hasMore } = await db.getChatMessages(path, [2], 50);
    assert.equal(hasMore, false);
    assert.deepEqual(messages.map((m) => m.id), [4, 11]);
    assert.deepEqual(messages[0].reactions, [{ reaction: "love", fromMe: false, handle: "+14155550101" }]);
    assert.deepEqual(messages[1].reactions, [{ reaction: "\u{1F389}", fromMe: false, handle: "friend@example.com" }]);
    assert.equal(messages[0].handle, "friend@example.com");
  });

  it("decodes attributedBody, own messages, edits and both date encodings", async () => {
    const { messages } = await db.getChatMessages(path, [1], 50);
    assert.deepEqual(messages.map((m) => m.id), [10, 1, 2, 3]);
    const [old, , mine, long] = messages;
    assert.equal(old.dateMs, (600000000 + APPLE_EPOCH) * 1000);
    assert.equal(mine.isFromMe, true);
    assert.equal(mine.handle, "");
    assert.equal(mine.text, "mac-apps-mcp test 1");
    assert.equal(mine.edited, true);
    assert.equal(long.text, LONG_TEXT);
    assert.equal(long.isRead, false);
  });

  it("pages back with limit and before/after bounds", async () => {
    const first = await db.getChatMessages(path, [1], 2);
    assert.equal(first.hasMore, true);
    assert.deepEqual(first.messages.map((m) => m.id), [2, 3]);
    const older = await db.getChatMessages(path, [1], 2, first.messages[0].dateMs!);
    assert.equal(older.hasMore, false);
    assert.deepEqual(older.messages.map((m) => m.id), [10, 1]);
    const window = await db.getChatMessages(path, [1], 10, undefined, T0 * 1000);
    assert.deepEqual(window.messages.map((m) => m.id), [2, 3]);
  });

  it("lists unread incoming messages, excluding junk", async () => {
    const { total, items } = await db.getUnread(path, 10, 0);
    assert.equal(total, 1);
    assert.equal(items[0].id, 3);
    assert.equal(items[0].text, LONG_TEXT);
    assert.equal(items[0].chat.chatIdentifier, "+14155550101");
    assert.deepEqual(items[0].chat.participants, ["+14155550101"]);
  });

  it("searches bodies held only in attributedBody, case-insensitively", async () => {
    const long = await db.searchMessages(path, { query: "TWO-BYTE length", limit: 10, offset: 0 });
    assert.deepEqual(long.items.map((m) => m.id), [3]);
    assert.equal(long.items[0].text, LONG_TEXT);
    const short = await db.searchMessages(path, { query: "mcp test", limit: 10, offset: 0 });
    assert.deepEqual(short.items.map((m) => m.id), [3, 2]);
    assert.equal(short.total, 2);
  });

  it("does not search tapbacks, system rows or junk", async () => {
    const res = await db.searchMessages(path, { query: "prize", limit: 10, offset: 0 });
    assert.equal(res.total, 0);
  });

  it("restricts search to one person by handle or national tail", async () => {
    const all = await db.searchMessages(path, { query: "hello", limit: 10, offset: 0 });
    assert.deepEqual(all.items.map((m) => m.id), [4, 1, 12]);
    const friend = await db.searchMessages(path, { query: "hello", handles: ["friend@example.com"], limit: 10, offset: 0 });
    assert.deepEqual(friend.items.map((m) => m.id), [4]);
    const london = await db.searchMessages(path, { query: "hello", tails: [nationalTail("07700900123")!], limit: 10, offset: 0 });
    assert.deepEqual(london.items.map((m) => m.id), [12]);
    const nobody = await db.searchMessages(path, { query: "hello", handles: [], tails: [], limit: 10, offset: 0 });
    assert.equal(nobody.total, 0);
    const since = await db.searchMessages(path, { query: "hello", sinceMs: T0 * 1000, limit: 10, offset: 0 });
    assert.deepEqual(since.items.map((m) => m.id), [4, 1]);
  });

  it("finds chats by identifier and 1:1 only", async () => {
    assert.deepEqual((await db.findChats(path, { identifiers: ["chat100"] })).map((c) => c.id), [2]);
    assert.deepEqual(await db.findChats(path, { identifiers: ["chat100"], oneToOne: true }), []);
    const [chat] = await db.findChats(path, { identifiers: ["+14155550101"], oneToOne: true });
    assert.equal(chat.guid, "any;-;+14155550101");
    assert.deepEqual(chat.participants, ["+14155550101"]);
    assert.deepEqual((await db.findChats(path, { chatId: 4 })).map((c) => c.chatIdentifier), ["+447700900123"]);
  });

  it("finds own messages sent after a given row", async () => {
    assert.equal(await db.maxMessageId(path), 13);
    const sent = await db.findSentAfter(path, ["+14155550101"], 1);
    assert.deepEqual(sent.map((r) => [r.id, r.text, r.isSent, r.isDelivered]), [[2, "mac-apps-mcp test 1", true, true]]);
    assert.deepEqual(await db.findSentAfter(path, ["+14155550101"], 2), []);
  });
});
