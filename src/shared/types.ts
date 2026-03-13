/**
 * Shared types used across mail, calendar, and reminders modules.
 */

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
