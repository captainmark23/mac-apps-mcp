/**
 * Unit tests for shared utility functions.
 * Run with: npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sqlEscape, sqlLikeEscape } from "../shared/sqlite.js";
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
