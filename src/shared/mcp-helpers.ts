/**
 * Shared MCP server helpers used by all domain registration modules.
 *
 * Provides: ok(), err(), toMarkdown(), isoDateString, paginatedOutput()
 */

import { z } from "zod";
import { sanitizeErrorMessage } from "./types.js";

/** Maximum characters for a JSON-stringified response before truncation kicks in. */
const MAX_RESPONSE_CHARS = 25_000;

/** Fraction of items to keep each truncation iteration (80% = remove ~20% per pass). */
const TRUNCATION_KEEP_RATIO = 0.8;

/** Wrap handler with standard error handling. Sanitizes paths from messages. */
export function err(error: unknown): { isError: true; content: [{ type: "text"; text: string }] } {
  const raw = error instanceof Error ? error.message : String(error);
  const msg = sanitizeErrorMessage(raw);
  return { isError: true, content: [{ type: "text", text: `Error: ${msg}` }] };
}

/** Convert structured data to human-readable markdown. */
export function toMarkdown(data: unknown, indent = 0): string {
  if (indent > 20) return "[nested]";
  const prefix = "  ".repeat(indent);
  if (data === null || data === undefined) return `${prefix}_none_`;
  if (typeof data === "string") return `${prefix}${data}`;
  if (typeof data === "number" || typeof data === "boolean") return `${prefix}${String(data)}`;
  if (Array.isArray(data)) {
    if (data.length === 0) return `${prefix}_empty list_`;
    return data.map((item, i) => {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const lines = toMarkdown(item, indent + 1);
        return `${prefix}- **Item ${i + 1}**\n${lines}`;
      }
      return `${prefix}- ${typeof item === "object" ? JSON.stringify(item) : String(item)}`;
    }).join("\n");
  }
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return `${prefix}_empty_`;
    return keys.map((key) => {
      const val = obj[key];
      if (typeof val === "object" && val !== null) {
        return `${prefix}**${key}:**\n${toMarkdown(val, indent + 1)}`;
      }
      return `${prefix}**${key}:** ${val === null || val === undefined ? "_none_" : String(val)}`;
    }).join("\n");
  }
  return `${prefix}${String(data)}`;
}

/** Format a successful tool response with structured content. */
export function ok(data: object, pretty = true, format?: "json" | "markdown") {
  // Markdown format: return plain text without structuredContent
  if (format === "markdown") {
    return {
      content: [{ type: "text" as const, text: toMarkdown(data) }],
    };
  }

  // JSON format (default): check for truncation
  const result = data as Record<string, unknown>;
  let json = JSON.stringify(result, null, pretty ? 2 : undefined);

  if (json.length > MAX_RESPONSE_CHARS && Array.isArray(result.items)) {
    const totalItems = result.items.length;
    let items = [...result.items];

    // Binary search for the right number of items that fits
    while (items.length > 0) {
      const candidate = {
        ...result,
        items,
        truncation_message: `Response truncated. Use pagination (offset/limit) or filters to narrow results. Showing ${items.length} of ${totalItems} items.`,
      };
      const candidateJson = JSON.stringify(candidate, null, pretty ? 2 : undefined);
      if (candidateJson.length <= MAX_RESPONSE_CHARS) {
        return {
          content: [{ type: "text" as const, text: candidateJson }],
          structuredContent: candidate,
        };
      }
      // Remove ~20% of remaining items each iteration
      items = items.slice(0, Math.max(Math.floor(items.length * TRUNCATION_KEEP_RATIO), items.length - 1));
    }

    // Fallback: no items fit
    const fallback = {
      ...result,
      items: [],
      truncation_message: `Response truncated. Use pagination (offset/limit) or filters to narrow results. Showing 0 of ${totalItems} items.`,
    };
    const fallbackJson = JSON.stringify(fallback, null, pretty ? 2 : undefined);
    return {
      content: [{ type: "text" as const, text: fallbackJson }],
      structuredContent: fallback,
    };
  }

  return {
    content: [{ type: "text" as const, text: json }],
    structuredContent: result,
  };
}

/** Reusable Zod schema for ISO 8601 date string parameters. */
export const isoDateString = z.string().refine((s) => !isNaN(new Date(s).getTime()), {
  message: "Invalid date format. Use ISO 8601 (e.g., '2024-01-15' or '2024-01-15T10:00:00Z')",
});

/** Build a paginated output shape for a given item schema. */
export function paginatedOutput<T extends z.ZodTypeAny>(itemSchema: T) {
  return {
    total: z.number(),
    count: z.number(),
    offset: z.number(),
    items: z.array(itemSchema),
    has_more: z.boolean(),
    next_offset: z.number().optional(),
  };
}

/** Common output schemas for simple responses. */
export const SuccessZ = { success: z.boolean() };
export const SuccessMessageZ = { success: z.boolean(), message: z.string() };
export const SuccessIdZ = { success: z.boolean(), id: z.string() };

/** Wrap a resource handler with error handling. */
export function resource(uri: string, fn: () => Promise<unknown>) {
  return async () => {
    try {
      return {
        contents: [{
          uri,
          mimeType: "application/json",
          text: JSON.stringify(await fn(), null, 2),
        }],
      };
    } catch (e) {
      return {
        contents: [{
          uri,
          mimeType: "text/plain",
          text: `Error: ${sanitizeErrorMessage(e instanceof Error ? e.message : String(e))}`,
        }],
      };
    }
  };
}
