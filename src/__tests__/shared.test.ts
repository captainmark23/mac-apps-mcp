/**
 * Unit tests for shared utility functions.
 * Run with: npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sqlEscape, sqlLikeEscape, safeInt } from "../shared/sqlite.js";
import { paginateArray, paginateRows } from "../shared/types.js";

// ─── sqlEscape ──────────────────────────────────────────────────

describe("sqlEscape", () => {
  it("escapes single quotes", () => {
    assert.equal(sqlEscape("O'Brien"), "O''Brien");
  });

  it("handles multiple single quotes", () => {
    assert.equal(sqlEscape("it's a 'test'"), "it''s a ''test''");
  });

  it("returns unchanged string with no quotes", () => {
    assert.equal(sqlEscape("hello world"), "hello world");
  });

  it("handles empty string", () => {
    assert.equal(sqlEscape(""), "");
  });

  it("handles string that is just a quote", () => {
    assert.equal(sqlEscape("'"), "''");
  });
});

// ─── sqlLikeEscape ──────────────────────────────────────────────

describe("sqlLikeEscape", () => {
  it("escapes single quotes", () => {
    assert.equal(sqlLikeEscape("O'Brien"), "O''Brien");
  });

  it("escapes percent wildcard", () => {
    assert.equal(sqlLikeEscape("100%"), "100\\%");
  });

  it("escapes underscore wildcard", () => {
    assert.equal(sqlLikeEscape("user_name"), "user\\_name");
  });

  it("escapes backslash", () => {
    assert.equal(sqlLikeEscape("path\\to"), "path\\\\to");
  });

  it("escapes all special characters together", () => {
    const input = "it's 100% a_test\\path";
    const result = sqlLikeEscape(input);
    assert.equal(result, "it''s 100\\% a\\_test\\\\path");
  });

  it("handles empty string", () => {
    assert.equal(sqlLikeEscape(""), "");
  });
});

// ─── safeInt ─────────────────────────────────────────────────────

describe("safeInt", () => {
  it("returns integer unchanged", () => {
    assert.equal(safeInt(42), 42);
  });

  it("truncates floating point numbers", () => {
    assert.equal(safeInt(42.9), 42);
  });

  it("parses numeric strings", () => {
    assert.equal(safeInt("123"), 123);
  });

  it("parses leading-numeric strings (parseInt behavior)", () => {
    assert.equal(safeInt("123abc"), 123);
  });

  it("handles negative numbers", () => {
    assert.equal(safeInt(-7), -7);
  });

  it("handles zero", () => {
    assert.equal(safeInt(0), 0);
  });

  it("throws on NaN", () => {
    assert.throws(() => safeInt(NaN), /Invalid integer value/);
  });

  it("throws on Infinity", () => {
    assert.throws(() => safeInt(Infinity), /Invalid integer value/);
  });

  it("throws on non-numeric string", () => {
    assert.throws(() => safeInt("abc"), /Invalid integer value/);
  });

  it("throws on undefined", () => {
    assert.throws(() => safeInt(undefined), /Invalid integer value/);
  });

  it("throws on null", () => {
    assert.throws(() => safeInt(null), /Invalid integer value/);
  });
});

// ─── paginateArray ──────────────────────────────────────────────

describe("paginateArray", () => {
  const items = ["a", "b", "c", "d", "e"];

  it("returns first page", () => {
    const result = paginateArray(items, 0, 3);
    assert.deepEqual(result, {
      total: 5,
      count: 3,
      offset: 0,
      items: ["a", "b", "c"],
      has_more: true,
      next_offset: 3,
    });
  });

  it("returns second page", () => {
    const result = paginateArray(items, 3, 3);
    assert.deepEqual(result, {
      total: 5,
      count: 2,
      offset: 3,
      items: ["d", "e"],
      has_more: false,
    });
  });

  it("returns all items when limit exceeds total", () => {
    const result = paginateArray(items, 0, 100);
    assert.deepEqual(result, {
      total: 5,
      count: 5,
      offset: 0,
      items: ["a", "b", "c", "d", "e"],
      has_more: false,
    });
  });

  it("returns empty when offset exceeds total", () => {
    const result = paginateArray(items, 10, 3);
    assert.deepEqual(result, {
      total: 5,
      count: 0,
      offset: 10,
      items: [],
      has_more: false,
    });
  });

  it("handles empty array", () => {
    const result = paginateArray([], 0, 10);
    assert.deepEqual(result, {
      total: 0,
      count: 0,
      offset: 0,
      items: [],
      has_more: false,
    });
  });

  it("returns single item page", () => {
    const result = paginateArray(items, 0, 1);
    assert.deepEqual(result, {
      total: 5,
      count: 1,
      offset: 0,
      items: ["a"],
      has_more: true,
      next_offset: 1,
    });
  });
});

// ─── paginateRows ───────────────────────────────────────────────

describe("paginateRows", () => {
  it("builds paginated result from pre-sliced rows", () => {
    const result = paginateRows(["a", "b", "c"], 10, 0);
    assert.deepEqual(result, {
      total: 10,
      count: 3,
      offset: 0,
      items: ["a", "b", "c"],
      has_more: true,
      next_offset: 3,
    });
  });

  it("reports no more when at end", () => {
    const result = paginateRows(["d", "e"], 5, 3);
    assert.deepEqual(result, {
      total: 5,
      count: 2,
      offset: 3,
      items: ["d", "e"],
      has_more: false,
    });
  });

  it("handles empty rows with total", () => {
    const result = paginateRows([], 5, 5);
    assert.deepEqual(result, {
      total: 5,
      count: 0,
      offset: 5,
      items: [],
      has_more: false,
    });
  });

  it("handles zero total", () => {
    const result = paginateRows([], 0, 0);
    assert.deepEqual(result, {
      total: 0,
      count: 0,
      offset: 0,
      items: [],
      has_more: false,
    });
  });

  it("calculates next_offset correctly with offset", () => {
    const result = paginateRows(["x", "y"], 100, 20);
    assert.deepEqual(result, {
      total: 100,
      count: 2,
      offset: 20,
      items: ["x", "y"],
      has_more: true,
      next_offset: 22,
    });
  });
});
