/**
 * Tests for the WhatsApp module.
 *
 * Query and tool tests run against fixture databases built here with the
 * system sqlite3. The fixtures mirror the columns the module reads from
 * ChatStorage.sqlite and ContactsV2.sqlite; every name, number and message
 * is made up (555 numbers), so CI never needs a real WhatsApp database.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../whatsapp/db.js";
import * as whatsapp from "../whatsapp/tools.js";
import { NameDirectory, isoLocal, textAndMedia } from "../whatsapp/tools.js";
import { isWhatsAppEnabled } from "../shared/config.js";

const APPLE_EPOCH = 978307200;
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0) / 1000; // 2026-10-20T12:00:00Z

/** Core Data seconds for a Unix time. */
const cd = (unixSec: number) => unixSec - APPLE_EPOCH;

const ALICE = "14155550101@s.whatsapp.net";
const BOB_LID = "111000111@lid";
const BOB_PHONE = "14155550102@s.whatsapp.net";
const CAROL_LID = "222000222@lid";
const DAVE_LID = "333000333@lid";
const ERIN = "447700900123@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";

const CHATS_SQL = `
CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, ZARCHIVED INTEGER, ZHIDDEN INTEGER, ZREMOVED INTEGER,
  ZSESSIONTYPE INTEGER, ZUNREADCOUNT INTEGER, ZLASTMESSAGE INTEGER, ZLASTMESSAGEDATE TIMESTAMP,
  ZCONTACTJID VARCHAR, ZPARTNERNAME VARCHAR);
CREATE TABLE ZWAMESSAGE (Z_PK INTEGER PRIMARY KEY, ZISFROMME INTEGER, ZMESSAGETYPE INTEGER, ZCHATSESSION INTEGER,
  ZGROUPMEMBER INTEGER, ZMEDIAITEM INTEGER, ZMESSAGEDATE TIMESTAMP, ZFROMJID VARCHAR, ZPUSHNAME VARCHAR, ZTEXT VARCHAR);
CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY, ZCHATSESSION INTEGER, ZCONTACTNAME VARCHAR, ZMEMBERJID VARCHAR);
CREATE TABLE ZWAMEDIAITEM (Z_PK INTEGER PRIMARY KEY, ZMESSAGE INTEGER, ZMEDIALOCALPATH VARCHAR, ZTITLE VARCHAR);
CREATE TABLE ZWAPROFILEPUSHNAME (Z_PK INTEGER PRIMARY KEY, ZJID VARCHAR, ZPUSHNAME VARCHAR);

INSERT INTO ZWACHATSESSION (Z_PK, ZARCHIVED, ZHIDDEN, ZREMOVED, ZSESSIONTYPE, ZUNREADCOUNT, ZLASTMESSAGE, ZLASTMESSAGEDATE, ZCONTACTJID, ZPARTNERNAME) VALUES
  (1, 0, 0, 0, 0, 0, 3, ${cd(T0 + 120)}, '${ALICE}', 'Alice Example'),
  (2, 0, 0, 0, 1, 2, 9, ${cd(T0 + 300)}, '${GROUP}', 'Test Group'),
  (3, 1, 0, 0, 0, 0, 10, ${cd(T0 - 3600)}, '${BOB_LID}', 'Bob Sample'),
  (4, 0, 0, 0, 5, 40, 11, ${cd(T0 + 900)}, '120363000000000009@newsletter', 'Some Channel'),
  (5, 0, 0, 1, 0, 0, 12, ${cd(T0 + 950)}, '14155550177@s.whatsapp.net', 'Removed Chat'),
  (6, 0, 0, 0, 0, 0, 13, ${cd(T0 - 7200)}, '${ERIN}', '+44 7700 900123'),
  (7, 0, 0, 0, 1, 0, 14, ${cd(T0 - 9000)}, '120363000000000002@g.us', 'Alice Example fans'),
  (8, 0, 0, 0, 1, 0, 15, ${cd(T0 - 9500)}, '120363000000000003@g.us', '');

INSERT INTO ZWAGROUPMEMBER VALUES (1, 2, '', '${ALICE}'), (2, 2, '', '${CAROL_LID}'), (3, 2, '', '${DAVE_LID}'),
  (4, 8, '', '${ALICE}'), (5, 8, '', '${DAVE_LID}'), (6, 8, '', '${CAROL_LID}'), (7, 8, '', '${BOB_LID}'), (8, 8, '', '${ERIN}');

INSERT INTO ZWAMESSAGE (Z_PK, ZISFROMME, ZMESSAGETYPE, ZCHATSESSION, ZGROUPMEMBER, ZMEDIAITEM, ZMESSAGEDATE, ZFROMJID, ZPUSHNAME, ZTEXT) VALUES
  (1, 0, 0, 1, NULL, 1, ${cd(T0)}, '${ALICE}', 'Q0FB', 'Hello there'),
  (2, 1, 0, 1, NULL, 2, ${cd(T0 + 60)}.25, NULL, 'Q0FB', 'Budget is 100% agreed'),
  (3, 0, 8, 1, NULL, 3, ${cd(T0 + 120)}, '${ALICE}', 'Q0FB', 'Here is the plan'),
  (4, 0, 0, 2, 1, 4, ${cd(T0 + 200)}, '${GROUP}', 'Q0FB', 'Group hello from Alice'),
  (5, 0, 6, 2, NULL, NULL, ${cd(T0 + 210)}, '${GROUP}', 'Q0FB', 'Carol joined'),
  (6, 0, 1, 2, 2, 5, ${cd(T0 + 220)}, '${GROUP}', 'Q0FB', NULL),
  (7, 1, 0, 2, NULL, 6, ${cd(T0 + 230)}, NULL, 'Q0FB', 'Thanks both'),
  (8, 0, 0, 2, 3, 7, ${cd(T0 + 290)}, '${DAVE_LID}', 'Q0FB', 'Budget looks high'),
  (9, 0, 59, 2, 2, 8, ${cd(T0 + 300)}, '${GROUP}', 'Q0FB', NULL),
  (10, 0, 0, 3, NULL, 9, ${cd(T0 - 3600)}, '${BOB_LID}', 'Q0FB', 'Budget call tomorrow?'),
  (11, 0, 0, 4, NULL, 10, ${cd(T0 + 900)}, NULL, 'Q0FB', 'Channel budget news'),
  (12, 0, 0, 5, NULL, 11, ${cd(T0 + 950)}, NULL, 'Q0FB', 'Removed budget chat'),
  (13, 0, 0, 6, NULL, 12, ${cd(T0 - 7200)}, '${ERIN}', 'Q0FB', 'Hello from London'),
  (14, 1, 0, 7, NULL, 13, ${cd(T0 - 9000)}, NULL, 'Q0FB', 'Welcome all'),
  (15, 0, 0, 8, 6, 14, ${cd(T0 - 9500)}, '120363000000000003@g.us', 'Q0FB', 'No subject here');

INSERT INTO ZWAMEDIAITEM (Z_PK, ZMESSAGE, ZMEDIALOCALPATH, ZTITLE) VALUES
  (1, 1, NULL, NULL), (2, 2, NULL, NULL),
  (3, 3, NULL, 'plan-q4.pdf'),
  (4, 4, NULL, NULL),
  (5, 6, 'Media/120363000000000001@g.us/a/b/abc123.jpg', 'Budget chart'),
  (6, 7, NULL, NULL), (7, 8, NULL, NULL), (8, 9, NULL, NULL), (9, 10, NULL, NULL),
  (10, 11, NULL, NULL), (11, 12, NULL, NULL), (12, 13, NULL, NULL), (13, 14, NULL, NULL), (14, 15, NULL, NULL);

INSERT INTO ZWAPROFILEPUSHNAME VALUES (1, '${CAROL_LID}', 'Carol'), (2, '${ALICE}', 'Ali'), (3, '${ERIN}', 'Erin');
`;

const CONTACTS_SQL = `
CREATE TABLE ZWAADDRESSBOOKCONTACT (Z_PK INTEGER PRIMARY KEY, ZFULLNAME VARCHAR, ZLID VARCHAR, ZWHATSAPPID VARCHAR);
INSERT INTO ZWAADDRESSBOOKCONTACT VALUES
  (1, 'Alice Example', '444000444@lid', '${ALICE}'),
  (2, 'Bob Sample', '${BOB_LID}', '${BOB_PHONE}'),
  (3, '', '555000555@lid', '14155550188@s.whatsapp.net');
`;

// ─── Pure helpers ────────────────────────────────────────────────

describe("isoLocal", () => {
  it("gives local time with a UTC offset that parses back to the same instant", () => {
    const ms = T0 * 1000;
    const text = isoLocal(ms);
    assert.match(text, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    assert.equal(new Date(text).getTime(), ms);
  });

  it("is empty for a missing date", () => {
    assert.equal(isoLocal(null), "");
  });
});

describe("textAndMedia", () => {
  const row = { type: 0, text: "", title: "", localPath: "" };

  it("treats text and link messages as text, whatever their media row holds", () => {
    assert.deepEqual(textAndMedia({ ...row, text: "hi", title: "ignored" }), { text: "hi", media: null });
    assert.deepEqual(textAndMedia({ ...row, type: 7, text: "see https://example.com", title: "Example" }),
      { text: "see https://example.com", media: null });
  });

  it("uses the caption as text and reports only the stored file name", () => {
    assert.deepEqual(textAndMedia({ ...row, type: 1, title: "A caption", localPath: "Media/x/abc.jpg" }),
      { text: "A caption", media: { type: "image", fileName: "abc.jpg" } });
    assert.deepEqual(textAndMedia({ ...row, type: 3 }), { text: "", media: { type: "audio", fileName: "" } });
  });

  it("finds a document's file name in the title or the text", () => {
    assert.deepEqual(textAndMedia({ ...row, type: 8, text: "Please sign", title: "contract.pdf" }),
      { text: "Please sign", media: { type: "document", fileName: "contract.pdf" } });
    assert.deepEqual(textAndMedia({ ...row, type: 8, text: "notes.docx" }),
      { text: "", media: { type: "document", fileName: "notes.docx" } });
  });

  it("labels unconfirmed types by number", () => {
    assert.deepEqual(textAndMedia({ ...row, type: 59 }), { text: "", media: { type: "other (type 59)", fileName: "" } });
  });
});

describe("NameDirectory", () => {
  const names = new NameDirectory({
    contacts: [
      { phoneJid: ALICE, lidJid: "444000444@lid", name: "Alice Example" },
      { phoneJid: BOB_PHONE, lidJid: BOB_LID, name: "Bob Sample" },
    ],
    profiles: [{ jid: CAROL_LID, name: "Carol" }, { jid: ALICE, name: "Ali" }],
  });

  it("prefers the saved contact name and gives the phone number", () => {
    assert.deepEqual(names.person(ALICE), { name: "Alice Example", phone: "+14155550101" });
  });

  it("names a privacy id from the address book and recovers its phone number", () => {
    assert.deepEqual(names.person(BOB_LID), { name: "Bob Sample", phone: "+14155550102" });
  });

  it("marks a profile name with ~ and gives no number for a bare privacy id", () => {
    assert.deepEqual(names.person(CAROL_LID), { name: "~Carol", phone: "" });
  });

  it("falls back to the phone number, then Unknown", () => {
    assert.deepEqual(names.person(ERIN), { name: "+447700900123", phone: "+447700900123" });
    assert.deepEqual(names.person(DAVE_LID), { name: "Unknown", phone: "" });
  });

  it("finds every id for a name, case-insensitively", () => {
    assert.deepEqual(names.jidsForName("bob").sort(), [BOB_LID, BOB_PHONE].sort());
    assert.deepEqual(names.jidsForName("zzz"), []);
    assert.deepEqual(names.jidsForName("  "), []);
  });
});

describe("whatsapp config", () => {
  it("is on unless switched off", () => {
    const saved = process.env.MACOS_MCP_WHATSAPP;
    try {
      delete process.env.MACOS_MCP_WHATSAPP;
      assert.equal(isWhatsAppEnabled(), true);
      for (const off of ["off", "OFF", "false", "0"]) {
        process.env.MACOS_MCP_WHATSAPP = off;
        assert.equal(isWhatsAppEnabled(), false);
      }
    } finally {
      if (saved === undefined) delete process.env.MACOS_MCP_WHATSAPP;
      else process.env.MACOS_MCP_WHATSAPP = saved;
    }
  });
});

// ─── Fixture databases ───────────────────────────────────────────

describe("WhatsApp tools (fixture databases)", () => {
  let dir: string;
  let paths: { chats: string; contacts: string };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "macos-mcp-whatsapp-"));
    paths = { chats: join(dir, "ChatStorage.sqlite"), contacts: join(dir, "ContactsV2.sqlite") };
    execFileSync("/usr/bin/sqlite3", [paths.chats], { input: CHATS_SQL });
    execFileSync("/usr/bin/sqlite3", [paths.contacts], { input: CONTACTS_SQL });
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists one-to-one chats and groups newest first, without channels or removed chats", async () => {
    const result = await whatsapp.listChats(20, 0, paths);
    assert.deepEqual(result.items.map((c) => c.name),
      ["Test Group", "Alice Example", "Bob Sample", "~Erin", "Alice Example fans", "Alice Example, ~Carol, Bob Sample +2"]);
    assert.equal(result.total, 6);
    assert.equal(result.has_more, false);
    // Newest message overall is in the removed chat: the history date covers the whole database.
    assert.equal(new Date(result.history_current_to).getTime(), (T0 + 950) * 1000);
  });

  it("summarises each chat", async () => {
    const { items } = await whatsapp.listChats(20, 0, paths);
    const [group, alice, bob] = items;
    assert.deepEqual(
      { isGroup: group.isGroup, unread: group.unreadCount, phone: group.phone, last: group.lastMessage },
      { isGroup: true, unread: 2, phone: "", last: { direction: "incoming", sender: "~Carol", text: "", mediaType: "other (type 59)" } });
    assert.equal(alice.phone, "+14155550101");
    assert.deepEqual(alice.lastMessage,
      { direction: "incoming", sender: "Alice Example", text: "Here is the plan", mediaType: "document" });
    assert.equal(new Date(alice.lastMessageDate).getTime(), (T0 + 120) * 1000);
    assert.deepEqual({ archived: bob.archived, phone: bob.phone }, { archived: true, phone: "+14155550102" });
  });

  it("paginates the chat list", async () => {
    const page = await whatsapp.listChats(2, 1, paths);
    assert.deepEqual(page.items.map((c) => c.name), ["Alice Example", "Bob Sample"]);
    assert.deepEqual({ total: page.total, has_more: page.has_more, next: page.next_offset }, { total: 6, has_more: true, next: 3 });
  });

  it("reads a group newest first with individual senders and no system events", async () => {
    const result = await whatsapp.getChat({ chatId: 2 }, 50, 0, undefined, paths);
    assert.deepEqual(result.chat, { chatId: 2, name: "Test Group", isGroup: true });
    assert.deepEqual(result.items.map((m) => [m.id, m.direction, m.sender.name]), [
      [9, "incoming", "~Carol"],
      [8, "incoming", "Unknown"],
      [7, "outgoing", "Me"],
      [6, "incoming", "~Carol"],
      [4, "incoming", "Alice Example"],
    ]);
    const image = result.items[3];
    assert.deepEqual({ text: image.text, media: image.media },
      { text: "Budget chart", media: { type: "image", fileName: "abc123.jpg" } });
    assert.equal(result.items[4].sender.phone, "+14155550101");
  });

  it("reads a chat by name, with since and pagination", async () => {
    const result = await whatsapp.getChat({ chatName: "alice example" }, 1, 0, new Date((T0 + 30) * 1000).toISOString(), paths);
    assert.equal(result.chat.chatId, 1);
    assert.deepEqual({ ids: result.items.map((m) => m.id), total: result.total, next: result.next_offset },
      { ids: [3], total: 2, next: 1 });
    assert.deepEqual(result.items[0].media, { type: "document", fileName: "plan-q4.pdf" });
    // Stored dates are fractional; output is to the second.
    const next = await whatsapp.getChat({ chatId: 1 }, 1, 1, undefined, paths);
    assert.equal(new Date(next.items[0].date).getTime(), (T0 + 60) * 1000);
  });

  it("finds a one-to-one chat by a contact name WhatsApp does not store on the chat", async () => {
    const result = await whatsapp.getChat({ chatName: "erin" }, 50, 0, undefined, paths);
    assert.deepEqual(result.chat, { chatId: 6, name: "~Erin", isGroup: false });
  });

  it("names a group that has no subject by its members, wherever it appears", async () => {
    const chat = await whatsapp.getChat({ chatId: 8 }, 50, 0, undefined, paths);
    assert.equal(chat.chat.name, "Alice Example, ~Carol, Bob Sample +2");
    const found = await whatsapp.searchMessages("No subject", {}, paths);
    assert.deepEqual(found.items.map((m) => [m.chat.name, m.sender.name]), [["Alice Example, ~Carol, Bob Sample +2", "~Carol"]]);
  });

  it("refuses an ambiguous or unknown chat reference", async () => {
    await assert.rejects(whatsapp.getChat({ chatName: "alice" }, 50, 0, undefined, paths),
      /2 chats match "alice": Alice Example \(chat_id 1\); Alice Example fans \(chat_id 7\)/);
    await assert.rejects(whatsapp.getChat({ chatName: "nobody" }, 50, 0, undefined, paths), /No WhatsApp chat matches/);
    await assert.rejects(whatsapp.getChat({ chatId: 99 }, 50, 0, undefined, paths), /Chat not found/);
    await assert.rejects(whatsapp.getChat({ chatId: 4 }, 50, 0, undefined, paths), /Chat not found/);
    await assert.rejects(whatsapp.getChat({}, 50, 0, undefined, paths), /exactly one of chat_id or chat_name/);
    await assert.rejects(whatsapp.getChat({ chatId: 1, chatName: "x" }, 50, 0, undefined, paths), /exactly one/);
  });

  it("searches text and captions across chats, newest first, skipping channels and removed chats", async () => {
    const result = await whatsapp.searchMessages("budget", {}, paths);
    assert.deepEqual(result.items.map((m) => [m.id, m.chat.name]), [
      [8, "Test Group"],
      [6, "Test Group"],
      [2, "Alice Example"],
      [10, "Bob Sample"],
    ]);
    assert.equal(result.total, 4);
  });

  it("treats LIKE wildcards and quotes in the query literally", async () => {
    assert.deepEqual((await whatsapp.searchMessages("100%", {}, paths)).items.map((m) => m.id), [2]);
    assert.equal((await whatsapp.searchMessages("1_0", {}, paths)).total, 0);
    assert.equal((await whatsapp.searchMessages("it's", {}, paths)).total, 0);
  });

  it("filters a search by chat, contact and date", async () => {
    const inGroup = await whatsapp.searchMessages("budget", { chatName: "Test Group" }, paths);
    assert.deepEqual(inGroup.items.map((m) => m.id), [8, 6]);

    // Alice: nothing she sent matches, but my message in the chat with her does.
    const alice = await whatsapp.searchMessages("budget", { contact: "alice" }, paths);
    assert.deepEqual(alice.items.map((m) => m.id), [2]);

    // Carol is known only by her profile name; this finds her group message.
    const carol = await whatsapp.searchMessages("budget", { contact: "carol" }, paths);
    assert.deepEqual(carol.items.map((m) => m.id), [6]);

    const recent = await whatsapp.searchMessages("budget", { since: new Date((T0 + 250) * 1000).toISOString() }, paths);
    assert.deepEqual(recent.items.map((m) => m.id), [8]);

    const paged = await whatsapp.searchMessages("budget", { limit: 1, offset: 1 }, paths);
    assert.deepEqual({ ids: paged.items.map((m) => m.id), next: paged.next_offset }, { ids: [6], next: 2 });

    await assert.rejects(whatsapp.searchMessages("budget", { contact: "nobody" }, paths), /No WhatsApp contact matches/);
  });

  it("returns each chat's newest unread incoming messages, without channels", async () => {
    const result = await whatsapp.getUnread(50, 0, paths);
    assert.deepEqual(result.items.map((m) => [m.id, m.chat.name, m.sender.name]), [
      [9, "Test Group", "~Carol"],
      [8, "Test Group", "Unknown"],
    ]);
    assert.equal(result.total, 2);
    assert.ok(result.history_current_to);
  });

  it("still loads profile names when the contacts database is missing", async () => {
    const rows = await db.loadNames(paths.chats, join(dir, "missing.sqlite"));
    assert.deepEqual(rows.contacts, []);
    assert.equal(rows.profiles.length, 3);
  });
});
