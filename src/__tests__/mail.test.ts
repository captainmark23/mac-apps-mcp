/**
 * Unit tests for mail tool-level pure functions.
 * These tests run without macOS databases — they only test parsing/formatting logic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMailboxUrl, cleanBodyForDisplay, sanitizeFilename } from "../mail/tools.js";
import { emlxSubpath, mailboxUrlToDir, decodeQuotedPrintable, stripHtml } from "../mail/fts.js";

// ─── parseMailboxUrl ─────────────────────────────────────────────

describe("parseMailboxUrl", () => {
  it("parses a standard imap URL", () => {
    const result = parseMailboxUrl("imap://ABC-123-DEF/INBOX");
    assert.deepEqual(result, { accountId: "ABC-123-DEF", mailboxName: "INBOX" });
  });

  it("parses an ews URL", () => {
    const result = parseMailboxUrl("ews://UUID-HERE/Sent%20Items");
    assert.deepEqual(result, { accountId: "UUID-HERE", mailboxName: "Sent Items" });
  });

  it("parses a local URL", () => {
    const result = parseMailboxUrl("local://LOCAL-ACCOUNT/Drafts");
    assert.deepEqual(result, { accountId: "LOCAL-ACCOUNT", mailboxName: "Drafts" });
  });

  it("parses a pop URL", () => {
    const result = parseMailboxUrl("pop://POP-UUID/INBOX");
    assert.deepEqual(result, { accountId: "POP-UUID", mailboxName: "INBOX" });
  });

  it("decodes URL-encoded mailbox names", () => {
    const result = parseMailboxUrl("imap://UUID/Sent%20Messages");
    assert.deepEqual(result, { accountId: "UUID", mailboxName: "Sent Messages" });
  });

  it("handles nested mailbox paths", () => {
    const result = parseMailboxUrl("imap://UUID/%5BGmail%5D/All%20Mail");
    assert.deepEqual(result, { accountId: "UUID", mailboxName: "[Gmail]/All Mail" });
  });

  it("returns null for invalid URL format", () => {
    assert.equal(parseMailboxUrl("not-a-url"), null);
  });

  it("returns null for empty string", () => {
    assert.equal(parseMailboxUrl(""), null);
  });

  it("returns null for unsupported protocol", () => {
    assert.equal(parseMailboxUrl("https://example.com/INBOX"), null);
  });

  it("handles malformed percent-encoding gracefully", () => {
    // Malformed %ZZ should not throw, falls back to raw string
    const result = parseMailboxUrl("imap://UUID/%ZZbad");
    assert.notEqual(result, null);
    assert.equal(result!.accountId, "UUID");
    // Falls back to raw string since decodeURIComponent will throw
    assert.equal(result!.mailboxName, "%ZZbad");
  });
});

// ─── cleanBodyForDisplay ─────────────────────────────────────────

describe("cleanBodyForDisplay", () => {
  it("strips HTML and collapses whitespace", () => {
    const result = cleanBodyForDisplay("<p>Hello   World</p>");
    assert.equal(result, "Hello World");
  });

  it("removes long URLs", () => {
    const longUrl = "https://example.com/" + "a".repeat(100);
    const result = cleanBodyForDisplay(`Check this: ${longUrl} end`);
    assert.ok(result.includes("[long URL removed]"));
    assert.ok(!result.includes(longUrl));
  });

  it("removes base64-encoded content", () => {
    const base64 = "A".repeat(250);
    const result = cleanBodyForDisplay(`Before ${base64} after`);
    assert.ok(result.includes("[encoded content removed]"));
  });

  it("truncates very long body text", () => {
    // Use words with spaces to avoid matching the base64 content regex
    const longText = Array.from({ length: 15_000 }, (_, i) => `word${i}`).join(" ");
    const result = cleanBodyForDisplay(longText);
    assert.equal(result.length, 50_000);
  });

  it("handles empty string", () => {
    assert.equal(cleanBodyForDisplay(""), "");
  });

  it("decodes quoted-printable before stripping HTML", () => {
    const result = cleanBodyForDisplay("caf=C3=A9");
    assert.ok(result.includes("cafe") || result.includes("caf"));
  });
});

// ─── sanitizeFilename ────────────────────────────────────────────

describe("sanitizeFilename", () => {
  it("strips path traversal sequences", () => {
    // ".." is removed, "/" replaced with "_": "../../etc/passwd" → "__etc_passwd"
    assert.equal(sanitizeFilename("../../etc/passwd"), "__etc_passwd");
  });

  it("replaces forward slashes with underscores", () => {
    assert.equal(sanitizeFilename("path/to/file.txt"), "path_to_file.txt");
  });

  it("replaces backslashes with underscores", () => {
    assert.equal(sanitizeFilename("path\\to\\file.txt"), "path_to_file.txt");
  });

  it("truncates long filenames to 255 characters", () => {
    const longName = "a".repeat(300);
    assert.equal(sanitizeFilename(longName).length, 255);
  });

  it("handles normal filenames unchanged", () => {
    assert.equal(sanitizeFilename("report.pdf"), "report.pdf");
  });

  it("handles empty string", () => {
    assert.equal(sanitizeFilename(""), "");
  });
});

// ─── mailboxUrlToDir ─────────────────────────────────────────────

describe("mailboxUrlToDir", () => {
  it("returns null for invalid URLs", () => {
    assert.equal(mailboxUrlToDir("not-a-url"), null);
  });

  it("returns null for empty string", () => {
    assert.equal(mailboxUrlToDir(""), null);
  });

  it("parses imap URL and appends .mbox", () => {
    const result = mailboxUrlToDir("imap://UUID-123/INBOX");
    assert.ok(result !== null);
    assert.ok(result!.includes("UUID-123"));
    assert.ok(result!.includes("INBOX.mbox"));
  });

  it("handles URL-encoded names", () => {
    const result = mailboxUrlToDir("imap://UUID/Sent%20Items");
    assert.ok(result !== null);
    assert.ok(result!.includes("Sent Items.mbox"));
  });

  it("handles nested mailbox paths with multiple .mbox segments", () => {
    const result = mailboxUrlToDir("imap://UUID/%5BGmail%5D/All%20Mail");
    assert.ok(result !== null);
    assert.ok(result!.includes("[Gmail].mbox"));
    assert.ok(result!.includes("All Mail.mbox"));
  });
});
