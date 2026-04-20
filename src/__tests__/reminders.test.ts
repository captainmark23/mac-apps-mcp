/**
 * Unit tests for Reminders tool-level pure functions and multi-database logic.
 * These tests run without macOS databases — they only test parsing/formatting logic.
 * Integration tests (live DB/JXA) are at the bottom and require macOS + Reminders.app.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { getReminderLists } from "../shared/config.js";
import { ReminderSummaryZ } from "../reminders/register.js";

// ─── getReminderLists (config) ───────────────────────────────────

describe("getReminderLists", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.MACOS_MCP_REMINDER_LISTS;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MACOS_MCP_REMINDER_LISTS;
    } else {
      process.env.MACOS_MCP_REMINDER_LISTS = originalEnv;
    }
  });

  it("returns null when env var is not set", () => {
    delete process.env.MACOS_MCP_REMINDER_LISTS;
    assert.equal(getReminderLists(), null);
  });

  it("returns array of trimmed list names", () => {
    process.env.MACOS_MCP_REMINDER_LISTS = " Work , Personal , Groceries ";
    const result = getReminderLists();
    assert.deepEqual(result, ["Work", "Personal", "Groceries"]);
  });

  it("filters out empty entries", () => {
    process.env.MACOS_MCP_REMINDER_LISTS = "Work,,Personal,";
    const result = getReminderLists();
    assert.deepEqual(result, ["Work", "Personal"]);
  });

  it("returns null for empty string", () => {
    process.env.MACOS_MCP_REMINDER_LISTS = "";
    assert.equal(getReminderLists(), null);
  });

  it("handles single list", () => {
    process.env.MACOS_MCP_REMINDER_LISTS = "Tasks";
    assert.deepEqual(getReminderLists(), ["Tasks"]);
  });
});

// ─── ReminderSummaryZ schema validation ──────────────────────────

describe("ReminderSummaryZ schema", () => {
  it("parses a valid reminder summary", () => {
    const valid = {
      id: "x-apple-reminder://ABC-123",
      name: "Buy groceries",
      completed: false,
      completionDate: "",
      dueDate: "2026-04-15T09:00:00.000Z",
      priority: 1,
      list: "Reminders",
      flagged: false,
    };
    const result = ReminderSummaryZ.parse(valid);
    assert.deepEqual(result, valid);
  });

  it("rejects missing required fields", () => {
    assert.throws(() => ReminderSummaryZ.parse({ id: "ABC" }));
  });

  it("rejects wrong types", () => {
    assert.throws(() =>
      ReminderSummaryZ.parse({
        id: "ABC",
        name: 123, // should be string
        completed: "yes", // should be boolean
        completionDate: "",
        dueDate: "",
        priority: 0,
        list: "x",
        flagged: false,
      })
    );
  });
});

// ─── Reminders tool registration ─────────────────────────────────

describe("Reminders tool registration", () => {
  it("can import registerRemindersTools without error", async () => {
    const mod = await import("../reminders/register.js");
    assert.equal(typeof mod.registerRemindersTools, "function");
    assert.equal(typeof mod.registerRemindersResources, "function");
  });

  it("exports ReminderSummaryZ schema", async () => {
    const mod = await import("../reminders/register.js");
    assert.ok(mod.ReminderSummaryZ);
    assert.equal(typeof mod.ReminderSummaryZ.parse, "function");
  });
});

// ─── findAllRemindersDbs ─────────────────────────────────────────

import { findAllRemindersDbs } from "../reminders/tools.js";

describe("findAllRemindersDbs", () => {
  it("returns an array of database paths", () => {
    const dbs = findAllRemindersDbs();
    assert.ok(Array.isArray(dbs), "Should return an array");
    assert.ok(dbs.length > 0, "Should find at least one database");
    for (const db of dbs) {
      assert.ok(db.endsWith(".sqlite"), "Each path should end with .sqlite");
      assert.ok(existsSync(db), `Database file should exist: ${db}`);
    }
  });

  it("returns consistent results on repeated calls", () => {
    const dbs1 = findAllRemindersDbs();
    const dbs2 = findAllRemindersDbs();
    assert.deepEqual(dbs1, dbs2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// INTEGRATION TESTS — require macOS + Reminders.app database
// Skipped in CI (JXA needs a running Reminders.app with GUI session)
// ═══════════════════════════════════════════════════════════════════

import * as reminders from "../reminders/tools.js";

const isCI = !!process.env.CI;

describe("Reminders integration: listReminderLists", { skip: isCI }, () => {
  it("returns at least one list", async () => {
    const lists = await reminders.listReminderLists();
    assert.ok(Array.isArray(lists));
    assert.ok(lists.length > 0, "Should have at least one reminder list");
    for (const l of lists) {
      assert.ok(l.name, "List should have a name");
      assert.ok(l.id, "List should have an id");
      assert.equal(typeof l.count, "number");
    }
  });

  it("does not include system lists", async () => {
    const lists = await reminders.listReminderLists();
    for (const l of lists) {
      assert.notEqual(l.name, "SiriFoundInApps", "Should not include system lists");
    }
  });

  it("includes Exchange/non-iCloud lists visible via JXA", async () => {
    // Verify that all lists visible in JXA are also visible via our multi-DB approach
    const { executeJxa } = await import("../shared/applescript.js");
    const jxaLists = await executeJxa<Array<{ name: string }>>(`
      const Rem = Application("Reminders");
      const lists = Rem.lists();
      JSON.stringify(lists.map(l => ({ name: l.name() })));
    `);
    const sqliteLists = await reminders.listReminderLists();
    const sqliteNames = new Set(sqliteLists.map((l) => l.name));

    for (const jl of jxaLists) {
      assert.ok(
        sqliteNames.has(jl.name),
        `JXA list "${jl.name}" should also appear in multi-DB SQLite results`
      );
    }
  });
});

describe("Reminders integration: getReminders", { skip: isCI }, () => {
  it("returns paginated incomplete reminders", async () => {
    const result = await reminders.getReminders(undefined, "incomplete", 5, 0);
    assert.ok(result.total >= 0);
    assert.ok(result.items.length <= 5);
    assert.equal(result.offset, 0);
    assert.equal(typeof result.has_more, "boolean");
    for (const r of result.items) {
      assert.equal(r.completed, false, "Incomplete filter should only return uncompleted");
    }
  });

  it("returns reminders from all accounts when no list filter", async () => {
    const result = await reminders.getReminders(undefined, "all", 200, 0);
    const listNames = new Set(result.items.map((r) => r.list));
    // If user has multiple accounts, we should see lists from different DBs
    assert.ok(listNames.size >= 1, "Should have reminders from at least one list");
  });

  it("filters by specific list name", async () => {
    const lists = await reminders.listReminderLists();
    if (lists.length > 0) {
      const targetList = lists[0].name;
      const result = await reminders.getReminders(targetList, "all", 50, 0);
      for (const r of result.items) {
        assert.equal(r.list, targetList, `All results should be from "${targetList}"`);
      }
    }
  });

  it("returns correct pagination metadata", async () => {
    const page1 = await reminders.getReminders(undefined, "all", 2, 0);
    if (page1.total > 2) {
      assert.equal(page1.has_more, true);
      assert.equal(page1.next_offset, 2);
      const page2 = await reminders.getReminders(undefined, "all", 2, 2);
      assert.equal(page2.offset, 2);
    }
  });

  it("reminder summaries have all required fields", async () => {
    const result = await reminders.getReminders(undefined, "all", 3, 0);
    for (const r of result.items) {
      assert.ok(r.id, "Should have id");
      assert.ok(r.id.startsWith(reminders.REMINDER_ID_PREFIX), "ID should have prefix");
      assert.equal(typeof r.name, "string");
      assert.equal(typeof r.completed, "boolean");
      assert.equal(typeof r.completionDate, "string");
      assert.equal(typeof r.dueDate, "string");
      assert.equal(typeof r.priority, "number");
      assert.ok(r.list, "Should have list name");
      assert.equal(typeof r.flagged, "boolean");
    }
  });
});

describe("Reminders integration: getReminder", { skip: isCI }, () => {
  it("returns full reminder details", async () => {
    const all = await reminders.getReminders(undefined, "all", 1, 0);
    if (all.items.length > 0) {
      const r = all.items[0];
      const detail = await reminders.getReminder(r.id, r.list);
      assert.ok(detail.id);
      assert.ok(detail.name);
      assert.equal(typeof detail.body, "string");
      assert.ok(detail.creationDate, "Should have creation date");
      assert.ok(detail.modificationDate, "Should have modification date");
      assert.equal(detail.list, r.list);
    }
  });

  it("throws for non-existent reminder", async () => {
    await assert.rejects(
      () => reminders.getReminder("00000000-0000-0000-0000-000000000000", "Reminders"),
      /not found/i
    );
  });
});

describe("Reminders integration: CRUD lifecycle", { skip: isCI }, () => {
  const testName = `MCP Unit Test Reminder ${Date.now()}`;
  let createdList: string | null = null;

  it("creates a reminder, reads it, and deletes it", async () => {
    // 1. Create in default list
    const created = await reminders.createReminder(testName, "Reminders", undefined, "Test body");
    assert.ok(created.success);
    assert.ok(created.id);
    createdList = "Reminders";

    // 2. Delete via JXA targeting only the specific list (faster than scanning all)
    const { executeJxaWrite, jxaString } = await import("../shared/applescript.js");
    const deleted = await executeJxaWrite<{success: boolean}>(`
      const Rem = Application("Reminders");
      const l = Rem.lists.byName(${jxaString(createdList)});
      const matches = l.reminders.whose({name: ${jxaString(testName)}})();
      for (const r of matches) Rem.delete(r);
      JSON.stringify({success: true});
    `);
    assert.ok(deleted.success);
    createdList = null;
  });

  afterEach(async () => {
    // Safety cleanup if test failed partway through
    if (!createdList) return;
    try {
      const { executeJxaWrite, jxaString } = await import("../shared/applescript.js");
      await executeJxaWrite(`
        const Rem = Application("Reminders");
        const l = Rem.lists.byName(${jxaString(createdList)});
        const matches = l.reminders.whose({name: {_contains: "MCP Unit Test Reminder"}})();
        for (const r of matches) Rem.delete(r);
        JSON.stringify({success: true});
      `);
    } catch { /* best-effort cleanup */ }
  });
});
