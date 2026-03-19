/**
 * Unit tests for contacts tool-level pure functions.
 * These tests run without macOS databases — they only test parsing/formatting logic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLabel } from "../contacts/tools.js";

// ─── parseLabel ──────────────────────────────────────────────────

describe("parseLabel", () => {
  it("extracts 'Home' from Apple format", () => {
    assert.equal(parseLabel("_$!<Home>!$_"), "Home");
  });

  it("extracts 'Work' from Apple format", () => {
    assert.equal(parseLabel("_$!<Work>!$_"), "Work");
  });

  it("extracts 'Mobile' from Apple format", () => {
    assert.equal(parseLabel("_$!<Mobile>!$_"), "Mobile");
  });

  it("extracts 'Other' from Apple format", () => {
    assert.equal(parseLabel("_$!<Other>!$_"), "Other");
  });

  it("returns raw string if not in Apple format", () => {
    assert.equal(parseLabel("CustomLabel"), "CustomLabel");
  });

  it("returns empty string for null", () => {
    assert.equal(parseLabel(null), "");
  });

  it("returns empty string for empty string", () => {
    assert.equal(parseLabel(""), "");
  });

  it("handles label with spaces", () => {
    assert.equal(parseLabel("_$!<Home Fax>!$_"), "Home Fax");
  });
});
