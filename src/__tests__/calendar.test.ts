/**
 * Unit tests for calendar tool-level pure functions.
 * These tests run without macOS databases — they only test parsing/formatting logic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toCoreDataTimestamp, statusLabel, participantStatusLabel, rowToEventSummary, normalizeDateRangeMs } from "../calendar/tools.js";
import { CORE_DATA_EPOCH_OFFSET } from "../shared/types.js";

// ─── toCoreDataTimestamp ─────────────────────────────────────────

describe("toCoreDataTimestamp", () => {
  it("converts a known ISO date to Core Data timestamp", () => {
    // 2024-01-01T00:00:00Z = Unix 1704067200 = Core Data 725760000
    const result = toCoreDataTimestamp("2024-01-01T00:00:00Z");
    assert.equal(result, 1704067200 - CORE_DATA_EPOCH_OFFSET);
    assert.equal(result, 725760000);
  });

  it("converts Core Data epoch itself (2001-01-01)", () => {
    const result = toCoreDataTimestamp("2001-01-01T00:00:00Z");
    assert.equal(result, 0);
  });

  it("handles date-only string", () => {
    // Date-only strings are interpreted as UTC midnight
    const result = toCoreDataTimestamp("2024-06-15");
    assert.ok(typeof result === "number");
    assert.ok(Number.isFinite(result));
  });

  it("handles datetime with timezone offset", () => {
    const result = toCoreDataTimestamp("2024-01-01T12:00:00+05:00");
    // 2024-01-01T07:00:00Z = 1704092400 Unix
    const expected = Math.floor(new Date("2024-01-01T12:00:00+05:00").getTime() / 1000) - CORE_DATA_EPOCH_OFFSET;
    assert.equal(result, expected);
  });

  it("throws for invalid date string", () => {
    assert.throws(
      () => toCoreDataTimestamp("not-a-date"),
      { message: /Invalid date string/ }
    );
  });
});

// ─── statusLabel ─────────────────────────────────────────────────

describe("statusLabel", () => {
  it("returns 'none' for status 0", () => {
    assert.equal(statusLabel("0"), "none");
  });

  it("returns 'confirmed' for status 1", () => {
    assert.equal(statusLabel("1"), "confirmed");
  });

  it("returns 'tentative' for status 2", () => {
    assert.equal(statusLabel("2"), "tentative");
  });

  it("returns 'cancelled' for status 3", () => {
    assert.equal(statusLabel("3"), "cancelled");
  });

  it("returns 'none' for null", () => {
    assert.equal(statusLabel(null), "none");
  });

  it("returns 'none' for unknown value", () => {
    assert.equal(statusLabel("99"), "none");
  });

  it("returns 'none' for empty string", () => {
    assert.equal(statusLabel(""), "none");
  });
});

// ─── participantStatusLabel ──────────────────────────────────────

describe("participantStatusLabel", () => {
  it("returns 'unknown' for status 0", () => {
    assert.equal(participantStatusLabel("0"), "unknown");
  });

  it("returns 'pending' for status 1", () => {
    assert.equal(participantStatusLabel("1"), "pending");
  });

  it("returns 'accepted' for status 2", () => {
    assert.equal(participantStatusLabel("2"), "accepted");
  });

  it("returns 'declined' for status 3", () => {
    assert.equal(participantStatusLabel("3"), "declined");
  });

  it("returns 'tentative' for status 4", () => {
    assert.equal(participantStatusLabel("4"), "tentative");
  });

  it("returns 'unknown' for null", () => {
    assert.equal(participantStatusLabel(null), "unknown");
  });

  it("returns 'unknown' for unrecognized value", () => {
    assert.equal(participantStatusLabel("10"), "unknown");
  });
});

// ─── rowToEventSummary ───────────────────────────────────────────

describe("rowToEventSummary", () => {
  it("maps a complete row to EventSummary", () => {
    const row = {
      UUID: "abc-123",
      summary: "Team Meeting",
      computed_start: 725760000, // 2024-01-01T00:00:00Z in Core Data
      occurrence_end_date: 725763600, // 2024-01-01T01:00:00Z
      location: "Room 42",
      all_day: 0,
      calendar_name: "Work",
      status: "1",
    };
    const result = rowToEventSummary(row);
    assert.equal(result.id, "abc-123");
    assert.equal(result.summary, "Team Meeting");
    assert.equal(result.location, "Room 42");
    assert.equal(result.allDay, false);
    assert.equal(result.calendar, "Work");
    assert.equal(result.status, "confirmed");
    assert.ok(result.startDate.includes("2024"));
    assert.ok(result.endDate.includes("2024"));
  });

  it("handles all-day event", () => {
    const row = {
      UUID: "def-456",
      summary: "Holiday",
      computed_start: 725760000,
      occurrence_end_date: 725846400,
      location: "",
      all_day: 1,
      calendar_name: "Personal",
      status: "0",
    };
    const result = rowToEventSummary(row);
    assert.equal(result.allDay, true);
  });

  it("handles string all_day value (from sqlite3 CLI)", () => {
    const row = {
      UUID: "ghi-789",
      summary: "Test",
      computed_start: 725760000,
      occurrence_end_date: 725763600,
      location: null,
      all_day: "1",
      calendar_name: "Cal",
      status: null,
    };
    const result = rowToEventSummary(row);
    assert.equal(result.allDay, true);
    assert.equal(result.location, "");
    assert.equal(result.status, "none");
  });

  it("handles null/missing fields gracefully", () => {
    const row = {
      UUID: null,
      summary: null,
      computed_start: null,
      occurrence_end_date: null,
      location: null,
      all_day: 0,
      calendar_name: null,
      status: null,
    };
    const result = rowToEventSummary(row);
    assert.equal(result.id, "");
    assert.equal(result.summary, "");
    assert.equal(result.location, "");
    assert.equal(result.calendar, "");
    assert.equal(result.startDate, "");
    assert.equal(result.endDate, "");
  });
});

// ─── normalizeDateRangeMs (#50) ──────────────────────────────────

const MS_PER_DAY = 86_400_000;

describe("normalizeDateRangeMs", () => {
  it("returns same values when end is after start", () => {
    const [s, e] = normalizeDateRangeMs("2026-04-17", "2026-04-18");
    assert.equal(s, new Date("2026-04-17").getTime());
    assert.equal(e, new Date("2026-04-18").getTime());
  });

  it("extends end by one day when startDate equals endDate", () => {
    const [s, e] = normalizeDateRangeMs("2026-04-17", "2026-04-17");
    assert.equal(s, new Date("2026-04-17").getTime());
    assert.equal(e, new Date("2026-04-17").getTime() + MS_PER_DAY);
  });

  it("extends end by one day when startDate equals endDate with datetimes", () => {
    const [s, e] = normalizeDateRangeMs("2026-04-17T00:00:00Z", "2026-04-17T00:00:00Z");
    assert.equal(s, new Date("2026-04-17T00:00:00Z").getTime());
    assert.equal(e, s + MS_PER_DAY);
  });

  it("corrects inverted range (end before start)", () => {
    const [s, e] = normalizeDateRangeMs("2026-04-18", "2026-04-17");
    assert.equal(s, new Date("2026-04-18").getTime());
    assert.equal(e, s + MS_PER_DAY);
  });

  it("event at noon is included in same-day range", () => {
    const [sMs, eMs] = normalizeDateRangeMs("2026-04-17", "2026-04-17");
    const eventStart = new Date("2026-04-17T12:00:00Z").getTime();
    assert.ok(eventStart >= sMs && eventStart < eMs, "noon event should be in range");
  });

  it("event at 23:59 is included in same-day range", () => {
    const [sMs, eMs] = normalizeDateRangeMs("2026-04-17", "2026-04-17");
    const eventStart = new Date("2026-04-17T23:59:59Z").getTime();
    assert.ok(eventStart >= sMs && eventStart < eMs, "late event should be in range");
  });

  it("event on next day is excluded from same-day range", () => {
    const [sMs, eMs] = normalizeDateRangeMs("2026-04-17", "2026-04-17");
    const eventStart = new Date("2026-04-18T00:00:00Z").getTime();
    assert.ok(!(eventStart >= sMs && eventStart < eMs), "next day event should not be in range");
  });

  it("multi-day range is unchanged", () => {
    const [s, e] = normalizeDateRangeMs("2026-04-17", "2026-04-20");
    assert.equal(e - s, 3 * MS_PER_DAY);
  });
});
