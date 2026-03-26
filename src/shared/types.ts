/**
 * Shared types and utilities used across mail, calendar, and reminders modules.
 */

/**
 * Core Data epoch offset (seconds between Unix epoch 1970-01-01 and Core Data epoch 2001-01-01).
 * Used by Calendar, Reminders, and Contacts databases.
 */
export const CORE_DATA_EPOCH_OFFSET = 978307200;

/** Seconds in one day. Used for date-range queries and day boundary calculations. */
export const SECONDS_PER_DAY = 86400;

/** Maximum .emlx file size to read (50 MB). Larger files are skipped to prevent OOM. */
export const MAX_EMLX_SIZE = 50 * 1024 * 1024;

/**
 * Convert a Core Data timestamp to ISO 8601 string.
 * Handles null, empty, NaN, and both number/string inputs.
 */
export function fromCoreDataTimestamp(ts: number | string | null | undefined): string {
  if (ts == null || ts === "") return "";
  const n = typeof ts === "string" ? parseFloat(ts) : ts;
  if (isNaN(n)) return "";
  return new Date((n + CORE_DATA_EPOCH_OFFSET) * 1000).toISOString();
}

/**
 * Sanitize error messages to strip filesystem paths before returning to MCP clients.
 * Replaces common macOS filesystem paths with `[path]` to prevent leaking system info.
 */
export function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/\/Users\/[^\s:'"]+/g, "[path]")
    .replace(/\/private\/[^\s:'"]+/g, "[path]")
    .replace(/\/Library\/[^\s:'"]+/g, "[path]")
    .replace(/\/System\/[^\s:'"]+/g, "[path]")
    .replace(/\/Applications\/[^\s:'"]+/g, "[path]")
    .replace(/\/var\/[^\s:'"]+/g, "[path]")
    .replace(/\/tmp\/[^\s:'"]+/g, "[path]");
}

/** Standard paginated response envelope for list/search tools. */
export interface PaginatedResult<T> {
  total: number;
  count: number;
  offset: number;
  items: T[];
  has_more: boolean;
  next_offset?: number;
}

/** Build a PaginatedResult from a full array (in-memory pagination). */
export function paginateArray<T>(
  allItems: T[],
  offset: number,
  limit: number
): PaginatedResult<T> {
  const total = allItems.length;
  const items = allItems.slice(offset, offset + limit);
  return {
    total,
    count: items.length,
    offset,
    items,
    has_more: total > offset + items.length,
    ...(total > offset + items.length
      ? { next_offset: offset + items.length }
      : {}),
  };
}

/** Build a PaginatedResult from pre-sliced rows + a total count (SQL-level pagination). */
export function paginateRows<T>(
  items: T[],
  total: number,
  offset: number
): PaginatedResult<T> {
  return {
    total,
    count: items.length,
    offset,
    items,
    has_more: total > offset + items.length,
    ...(total > offset + items.length
      ? { next_offset: offset + items.length }
      : {}),
  };
}
