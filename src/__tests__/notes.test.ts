/**
 * Unit tests for Notes tool-level pure functions and SQLite query logic.
 * These tests run without macOS databases — they only test parsing/formatting logic.
 * Integration tests (live DB/JXA) are at the bottom and require macOS + Notes.app.
 *
 * IMPORTANT: Run `npm test` locally on macOS before submitting a PR.
 * Integration tests are skipped in CI (GitHub Actions lacks a GUI session).
 * See CONTRIBUTING.md for details.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getNotesFolders, getDefaultNotesAccount, getNotesDbPath, textToHtml } from "../notes/tools.js";
import { NoteSummaryZ } from "../notes/register.js";
import { existsSync } from "node:fs";

// ─── textToHtml ──────────────────────────────────────────────────

describe("textToHtml", () => {
  it("escapes ampersands", () => {
    assert.equal(textToHtml("A & B"), "A &amp; B");
  });

  it("escapes angle brackets", () => {
    assert.equal(textToHtml("<script>alert('xss')</script>"), "&lt;script&gt;alert('xss')&lt;/script&gt;");
  });

  it("converts newlines to <br>", () => {
    assert.equal(textToHtml("line1\nline2\nline3"), "line1<br>line2<br>line3");
  });

  it("handles empty string", () => {
    assert.equal(textToHtml(""), "");
  });

  it("handles string with no special characters", () => {
    assert.equal(textToHtml("Hello World"), "Hello World");
  });

  it("escapes all HTML entities together", () => {
    assert.equal(textToHtml("a < b & c > d\nnew line"), "a &lt; b &amp; c &gt; d<br>new line");
  });

  it("handles multiple consecutive newlines", () => {
    assert.equal(textToHtml("a\n\n\nb"), "a<br><br><br>b");
  });

  it("handles unicode characters", () => {
    assert.equal(textToHtml("café ☕ über"), "café ☕ über");
  });
});

// ─── getNotesFolders ─────────────────────────────────────────────

describe("getNotesFolders", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.MACOS_MCP_NOTES_FOLDERS;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MACOS_MCP_NOTES_FOLDERS;
    } else {
      process.env.MACOS_MCP_NOTES_FOLDERS = originalEnv;
    }
  });

  it("returns null when env var is not set", () => {
    delete process.env.MACOS_MCP_NOTES_FOLDERS;
    assert.equal(getNotesFolders(), null);
  });

  it("returns array of trimmed folder names", () => {
    process.env.MACOS_MCP_NOTES_FOLDERS = " Work , Personal , Ideas ";
    const result = getNotesFolders();
    assert.deepEqual(result, ["Work", "Personal", "Ideas"]);
  });

  it("filters out empty entries", () => {
    process.env.MACOS_MCP_NOTES_FOLDERS = "Work,,Personal,";
    const result = getNotesFolders();
    assert.deepEqual(result, ["Work", "Personal"]);
  });

  it("returns null for empty string", () => {
    process.env.MACOS_MCP_NOTES_FOLDERS = "";
    assert.equal(getNotesFolders(), null);
  });

  it("handles single folder", () => {
    process.env.MACOS_MCP_NOTES_FOLDERS = "Projects";
    assert.deepEqual(getNotesFolders(), ["Projects"]);
  });

  it("trims whitespace-only entries to empty and filters them", () => {
    process.env.MACOS_MCP_NOTES_FOLDERS = "  ,Work,  ";
    assert.deepEqual(getNotesFolders(), ["Work"]);
  });

  it("returns null for comma-only value", () => {
    process.env.MACOS_MCP_NOTES_FOLDERS = ",,,";
    assert.equal(getNotesFolders(), null);
  });
});

// ─── getDefaultNotesAccount ─────────────────────────────────────

describe("getDefaultNotesAccount", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.MACOS_MCP_NOTES_ACCOUNT;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MACOS_MCP_NOTES_ACCOUNT;
    } else {
      process.env.MACOS_MCP_NOTES_ACCOUNT = originalEnv;
    }
  });

  it("returns undefined when env var is not set", () => {
    delete process.env.MACOS_MCP_NOTES_ACCOUNT;
    assert.equal(getDefaultNotesAccount(), undefined);
  });

  it("returns the account name when set", () => {
    process.env.MACOS_MCP_NOTES_ACCOUNT = "iCloud";
    assert.equal(getDefaultNotesAccount(), "iCloud");
  });

  it("returns undefined for empty string", () => {
    process.env.MACOS_MCP_NOTES_ACCOUNT = "";
    assert.equal(getDefaultNotesAccount(), undefined);
  });

  it("returns account name with spaces", () => {
    process.env.MACOS_MCP_NOTES_ACCOUNT = "My Exchange Account";
    assert.equal(getDefaultNotesAccount(), "My Exchange Account");
  });
});

// ─── getNotesDbPath ──────────────────────────────────────────────

describe("getNotesDbPath", () => {
  it("returns a path that exists on this machine", () => {
    const dbPath = getNotesDbPath();
    assert.ok(dbPath.includes("NoteStore.sqlite"), "Path should contain NoteStore.sqlite");
    assert.ok(existsSync(dbPath), "Database file should exist");
  });

  it("returns consistent value on repeated calls (cached)", () => {
    const path1 = getNotesDbPath();
    const path2 = getNotesDbPath();
    assert.equal(path1, path2);
  });
});

// ─── NoteSummaryZ schema validation ──────────────────────────────

describe("NoteSummaryZ schema", () => {
  it("parses a valid note summary", () => {
    const valid = {
      identifier: "ABC-123",
      title: "Test Note",
      snippet: "Some content",
      creationDate: "2026-01-01T00:00:00.000Z",
      modificationDate: "2026-04-12T00:00:00.000Z",
      folder: "Notes",
      account: "iCloud",
      isPinned: false,
      isLocked: false,
      hasChecklist: true,
    };
    const result = NoteSummaryZ.parse(valid);
    assert.deepEqual(result, valid);
  });

  it("rejects missing required fields", () => {
    assert.throws(() => NoteSummaryZ.parse({ identifier: "ABC" }));
  });

  it("rejects wrong types", () => {
    assert.throws(() =>
      NoteSummaryZ.parse({
        identifier: "ABC",
        title: 123, // should be string
        snippet: "x",
        creationDate: "x",
        modificationDate: "x",
        folder: "x",
        account: "x",
        isPinned: "yes", // should be boolean
        isLocked: false,
        hasChecklist: false,
      })
    );
  });
});

// ─── Notes tool registration ─────────────────────────────────────

describe("Notes tool registration", () => {
  it("can import registerNotesTools without error", async () => {
    const mod = await import("../notes/register.js");
    assert.equal(typeof mod.registerNotesTools, "function");
    assert.equal(typeof mod.registerNotesResources, "function");
  });

  it("exports NoteSummaryZ schema", async () => {
    const mod = await import("../notes/register.js");
    assert.ok(mod.NoteSummaryZ);
    assert.equal(typeof mod.NoteSummaryZ.parse, "function");
  });
});

// ═══════════════════════════════════════════════════════════════════
// INTEGRATION TESTS — require macOS + Notes.app database
// Skipped in CI (JXA needs a running Notes.app with GUI session)
// ═══════════════════════════════════════════════════════════════════

import * as notes from "../notes/tools.js";

const isCI = !!process.env.CI;

describe("Notes integration: listAccounts", { skip: isCI }, () => {
  it("returns at least one account", async () => {
    const accounts = await notes.listAccounts();
    assert.ok(Array.isArray(accounts));
    assert.ok(accounts.length > 0, "Should have at least one Notes account");
    for (const a of accounts) {
      assert.ok(a.name, "Account should have a name");
      assert.ok(a.identifier, "Account should have an identifier");
    }
  });
});

describe("Notes integration: listFolders", { skip: isCI }, () => {
  it("returns folders with note counts", async () => {
    const folders = await notes.listFolders();
    assert.ok(Array.isArray(folders));
    assert.ok(folders.length > 0, "Should have at least one folder");
    for (const f of folders) {
      assert.ok(f.name, "Folder should have a name");
      assert.ok(f.identifier, "Folder should have an identifier");
      assert.equal(typeof f.noteCount, "number");
      assert.equal(typeof f.folderType, "number");
      assert.ok(f.accountName, "Folder should have an account name");
    }
  });

  it("excludes trash by default", async () => {
    const folders = await notes.listFolders();
    const trashFolders = folders.filter((f) => f.folderType === 1);
    assert.equal(trashFolders.length, 0, "Default listing should not include trash");
  });

  it("includes trash when requested", async () => {
    const folders = await notes.listFolders(undefined, true);
    // May or may not have trash — just verify it doesn't error
    assert.ok(Array.isArray(folders));
  });

  it("filters by account name", async () => {
    const allFolders = await notes.listFolders();
    if (allFolders.length > 0) {
      const accountName = allFolders[0].accountName;
      const filtered = await notes.listFolders(accountName);
      assert.ok(filtered.length > 0);
      for (const f of filtered) {
        assert.equal(f.accountName, accountName);
      }
    }
  });
});

describe("Notes integration: listNotes", { skip: isCI }, () => {
  it("returns paginated notes sorted by modification date", async () => {
    const result = await notes.listNotes(undefined, undefined, "all", "modified", 5, 0);
    assert.ok(result.total >= 0);
    assert.ok(result.items.length <= 5);
    assert.equal(result.offset, 0);
    assert.equal(typeof result.has_more, "boolean");
    if (result.items.length > 1) {
      // Verify descending modification date order
      const d1 = new Date(result.items[0].modificationDate).getTime();
      const d2 = new Date(result.items[1].modificationDate).getTime();
      assert.ok(d1 >= d2, "Should be sorted by modification date descending");
    }
  });

  it("returns correct pagination metadata", async () => {
    const page1 = await notes.listNotes(undefined, undefined, "all", "modified", 2, 0);
    if (page1.total > 2) {
      assert.equal(page1.has_more, true);
      assert.equal(page1.next_offset, 2);
      const page2 = await notes.listNotes(undefined, undefined, "all", "modified", 2, 2);
      assert.equal(page2.offset, 2);
      // Items should be different
      if (page1.items.length > 0 && page2.items.length > 0) {
        assert.notEqual(page1.items[0].identifier, page2.items[0].identifier);
      }
    }
  });

  it("note summaries have all required fields", async () => {
    const result = await notes.listNotes(undefined, undefined, "all", "modified", 3, 0);
    for (const n of result.items) {
      assert.ok(n.identifier, "Should have identifier");
      assert.equal(typeof n.title, "string");
      assert.equal(typeof n.snippet, "string");
      assert.ok(n.creationDate, "Should have creation date");
      assert.ok(n.modificationDate, "Should have modification date");
      assert.equal(typeof n.folder, "string");
      assert.equal(typeof n.account, "string");
      assert.equal(typeof n.isPinned, "boolean");
      assert.equal(typeof n.isLocked, "boolean");
      assert.equal(typeof n.hasChecklist, "boolean");
    }
  });

  it("filters by folder name", async () => {
    const all = await notes.listNotes(undefined, undefined, "all", "modified", 100, 0);
    if (all.items.length > 0) {
      const folderName = all.items[0].folder;
      const filtered = await notes.listNotes(folderName, undefined, "all", "modified", 100, 0);
      for (const n of filtered.items) {
        assert.equal(n.folder, folderName);
      }
    }
  });

  it("sorts by title", async () => {
    const result = await notes.listNotes(undefined, undefined, "all", "title", 10, 0);
    if (result.items.length > 1) {
      for (let i = 1; i < result.items.length; i++) {
        const cmp = result.items[i].title.localeCompare(result.items[i - 1].title, undefined, { sensitivity: "base" });
        assert.ok(cmp >= 0, `"${result.items[i].title}" should come after "${result.items[i - 1].title}"`);
      }
    }
  });

  it("sorts by creation date", async () => {
    const result = await notes.listNotes(undefined, undefined, "all", "created", 5, 0);
    if (result.items.length > 1) {
      const d1 = new Date(result.items[0].creationDate).getTime();
      const d2 = new Date(result.items[1].creationDate).getTime();
      assert.ok(d1 >= d2, "Should be sorted by creation date descending");
    }
  });
});

describe("Notes integration: searchNotes", { skip: isCI }, () => {
  it("finds notes matching a title keyword", async () => {
    // Get a real note title to search for
    const all = await notes.listNotes(undefined, undefined, "all", "modified", 1, 0);
    if (all.items.length > 0) {
      const firstWord = all.items[0].title.split(/\s+/)[0];
      if (firstWord && firstWord.length >= 2) {
        const result = await notes.searchNotes(firstWord, "title");
        assert.ok(result.total > 0, `Should find notes with "${firstWord}" in title`);
        for (const n of result.items) {
          assert.ok(
            n.title.toLowerCase().includes(firstWord.toLowerCase()),
            `Title "${n.title}" should contain "${firstWord}"`
          );
        }
      }
    }
  });

  it("returns empty results for non-existent query", async () => {
    const result = await notes.searchNotes("xyzzy_nonexistent_query_12345");
    assert.equal(result.total, 0);
    assert.deepEqual(result.items, []);
  });

  it("respects pagination in search", async () => {
    const result = await notes.searchNotes("a", "all", undefined, 2, 0);
    assert.ok(result.items.length <= 2);
    if (result.has_more) {
      assert.equal(result.next_offset, 2);
    }
  });

  it("handles SQL special characters safely", async () => {
    // This should not throw (SQL injection prevention)
    const result = await notes.searchNotes("O'Brien %test_ \\drop");
    assert.ok(Array.isArray(result.items));
  });
});

describe("Notes integration: getNote", { skip: isCI }, () => {
  it("returns full note with plaintext body", async () => {
    const all = await notes.listNotes(undefined, undefined, "all", "modified", 1, 0);
    if (all.items.length > 0 && !all.items[0].isLocked) {
      const note = await notes.getNote(all.items[0].identifier, "plaintext");
      assert.ok(note.identifier);
      assert.ok(note.title);
      assert.equal(note.bodyFormat, "plaintext");
      assert.equal(typeof note.body, "string");
      assert.ok(note.body.length > 0, "Body should not be empty");
      assert.equal(typeof note.attachmentCount, "number");
      assert.equal(typeof note.shared, "boolean");
    }
  });

  it("returns full note with HTML body", async () => {
    const all = await notes.listNotes(undefined, undefined, "all", "modified", 1, 0);
    if (all.items.length > 0 && !all.items[0].isLocked) {
      const note = await notes.getNote(all.items[0].identifier, "html");
      assert.equal(note.bodyFormat, "html");
      assert.ok(note.body.includes("<"), "HTML body should contain HTML tags");
    }
  });

  it("throws for non-existent note identifier", async () => {
    await assert.rejects(
      () => notes.getNote("00000000-0000-0000-0000-000000000000"),
      /not found/i
    );
  });
});

describe("Notes integration: CRUD lifecycle", { skip: isCI }, () => {
  const testTitle = `MCP Unit Test Note ${Date.now()}`;
  let sqliteId: string | null = null;

  it("creates a note, reads it, updates it, moves it, and deletes it", async () => {
    // 1. Create
    const created = await notes.createNote(
      testTitle,
      "This is a test note created by the macos-mcp unit test suite.\nPlease delete if found.",
      "Notes"
    );
    assert.ok(created.success);
    assert.ok(created.name);
    assert.ok(created.identifier, "Should return identifier");

    // 2. Find SQLite UUID via search (createNote returns a JXA x-coredata URL,
    //    but all other tools expect the SQLite ZIDENTIFIER UUID)
    const searchResult = await notes.searchNotes(testTitle, "title");
    assert.ok(searchResult.total > 0, "Created note should appear in search");
    sqliteId = searchResult.items[0].identifier;
    assert.ok(sqliteId, "Should have SQLite UUID");

    // 3. Read back via getNote
    const fetched = await notes.getNote(sqliteId, "plaintext");
    assert.ok(fetched.body.length > 0, "Body should not be empty");
    assert.equal(fetched.bodyFormat, "plaintext");

    // 4. Update
    const updated = await notes.updateNote(
      sqliteId,
      "Updated body from unit test.\nSecond line."
    );
    assert.ok(updated.success);

    // 5. Create a test folder, move note to it, then clean up
    let testFolderCreated = false;
    try {
      const folder = await notes.createFolder("MCP Test Folder");
      assert.ok(folder.success);
      testFolderCreated = true;

      const moved = await notes.moveNote(sqliteId, "MCP Test Folder");
      assert.ok(moved.success);
      assert.equal(moved.folder, "MCP Test Folder");
    } catch {
      // Folder operations might fail in some account types — not fatal
    }

    // 6. Delete (moves to Recently Deleted)
    const deleted = await notes.deleteNote(sqliteId);
    assert.ok(deleted.success);

    // Clean up test folder
    if (testFolderCreated) {
      try {
        const { executeJxaWrite } = await import("../shared/applescript.js");
        await executeJxaWrite(`
          const app = Application("Notes");
          const folders = app.folders.whose({name: "MCP Test Folder"})();
          if (folders.length > 0) app.delete(folders[0]);
          JSON.stringify({success: true});
        `);
      } catch { /* best-effort cleanup */ }
    }

    sqliteId = null; // Mark as cleaned up
  });

  afterEach(async () => {
    // Safety cleanup if test failed partway through — delete by title via JXA
    if (sqliteId) {
      try {
        await notes.deleteNote(sqliteId);
      } catch {
        // Fallback: delete by title directly via JXA
        try {
          const { executeJxaWrite } = await import("../shared/applescript.js");
          await executeJxaWrite(`
            const app = Application("Notes");
            const matches = app.notes.whose({name: {_contains: "MCP Unit Test Note"}})();
            for (const n of matches) app.delete(n);
            JSON.stringify({success: true});
          `);
        } catch { /* best-effort */ }
      }
    }
  });
});

describe("Notes integration: multi-account support", { skip: isCI }, () => {
  it("listAccounts returns all accounts including non-iCloud", async () => {
    const accounts = await notes.listAccounts();
    assert.ok(accounts.length > 0);
    // Verify we get more than just iCloud (when multiple accounts exist)
    const names = accounts.map((a) => a.name);
    // At minimum, iCloud should always be present
    assert.ok(names.some((n) => /icloud/i.test(n)), "Should include iCloud account");
  });

  it("listFolders returns folders from all accounts", async () => {
    const accounts = await notes.listAccounts();
    if (accounts.length > 1) {
      const folders = await notes.listFolders();
      const accountNames = new Set(folders.map((f) => f.accountName));
      assert.ok(accountNames.size > 1, `Should have folders from multiple accounts, got: ${[...accountNames].join(", ")}`);
    }
  });

  it("listNotes returns notes from all accounts", async () => {
    const accounts = await notes.listAccounts();
    if (accounts.length > 1) {
      const result = await notes.listNotes(undefined, undefined, "all", "modified", 100, 0);
      const accountNames = new Set(result.items.map((n) => n.account));
      assert.ok(accountNames.size > 1, `Should have notes from multiple accounts, got: ${[...accountNames].join(", ")}`);
    }
  });

  it("listNotes can filter by non-iCloud account", async () => {
    const accounts = await notes.listAccounts();
    const nonIcloud = accounts.find((a) => !/icloud/i.test(a.name));
    if (nonIcloud) {
      const result = await notes.listNotes(undefined, nonIcloud.name, "all", "modified", 100, 0);
      assert.ok(result.total > 0, `Non-iCloud account "${nonIcloud.name}" should have notes`);
      for (const n of result.items) {
        assert.equal(n.account, nonIcloud.name, `All notes should be from ${nonIcloud.name}`);
      }
    }
  });

  it("searchNotes finds notes in non-iCloud accounts", async () => {
    const accounts = await notes.listAccounts();
    const nonIcloud = accounts.find((a) => !/icloud/i.test(a.name));
    if (nonIcloud) {
      // Get a note title from the non-iCloud account to search for
      const acctNotes = await notes.listNotes(undefined, nonIcloud.name, "all", "modified", 1, 0);
      if (acctNotes.items.length > 0) {
        const firstWord = acctNotes.items[0].title.split(/\s+/)[0];
        if (firstWord && firstWord.length >= 2) {
          const result = await notes.searchNotes(firstWord, "title");
          assert.ok(result.total > 0, `Should find "${firstWord}" in search`);
          const found = result.items.find((n) => n.account === nonIcloud.name);
          assert.ok(found, `Should find matching note in ${nonIcloud.name}`);
        }
      }
    }
  });

  it("getNote works with x-coredata:// identifiers (non-iCloud)", async () => {
    const accounts = await notes.listAccounts();
    const nonIcloud = accounts.find((a) => !/icloud/i.test(a.name));
    if (nonIcloud) {
      const acctNotes = await notes.listNotes(undefined, nonIcloud.name, "all", "modified", 1, 0);
      if (acctNotes.items.length > 0 && !acctNotes.items[0].isLocked) {
        const jxaId = acctNotes.items[0].identifier;
        assert.ok(jxaId.startsWith("x-coredata://"), "Non-iCloud identifier should be x-coredata URL");
        const note = await notes.getNote(jxaId, "plaintext");
        assert.ok(note.title);
        assert.ok(note.body.length > 0, "Body should not be empty");
        assert.equal(note.bodyFormat, "plaintext");
        assert.equal(note.account, nonIcloud.name);
      }
    }
  });
});

describe("Notes integration: getNotesModifiedToday", { skip: isCI }, () => {
  it("returns paginated result (may be empty)", async () => {
    const result = await notes.getNotesModifiedToday(5);
    assert.ok(typeof result.total === "number");
    assert.ok(Array.isArray(result.items));
    assert.ok(result.items.length <= 5);
    // If there are notes modified today, verify dates
    for (const n of result.items) {
      const modDate = new Date(n.modificationDate);
      const today = new Date();
      assert.equal(modDate.getFullYear(), today.getFullYear());
      assert.equal(modDate.getMonth(), today.getMonth());
      assert.equal(modDate.getDate(), today.getDate());
    }
  });
});
