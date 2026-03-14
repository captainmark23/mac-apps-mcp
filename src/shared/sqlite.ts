/**
 * SQLite helper — reads macOS SQLite databases using the system sqlite3 binary.
 * Zero native dependencies; sqlite3 ships with macOS.
 */

import { execFile } from "node:child_process";

const SQLITE3 = "/usr/bin/sqlite3";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface SqliteRow {
  [key: string]: string | number | null;
}

/**
 * Run a read-only SQL query against a SQLite database.
 * Returns an array of objects keyed by column name.
 */
export async function sqliteQuery<T extends SqliteRow = SqliteRow>(
  dbPath: string,
  sql: string,
  timeout = DEFAULT_TIMEOUT_MS
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    execFile(
      SQLITE3,
      ["-json", "-readonly", dbPath, sql],
      { timeout, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const msg = stderr?.trim() || error.message;
          if (error.killed || error.code === "ETIMEDOUT") {
            reject(new Error(`SQLite query timed out after ${timeout}ms`));
          } else {
            reject(new Error(`SQLite error: ${msg}`));
          }
          return;
        }

        const raw = stdout.trim();
        if (!raw) {
          resolve([]);
          return;
        }

        try {
          resolve(JSON.parse(raw) as T[]);
        } catch {
          reject(new Error(`Failed to parse SQLite JSON output: ${raw.slice(0, 200)}`));
        }
      }
    );
  });
}

/**
 * Escape a string for use in SQL queries.
 * Uses single-quote escaping (SQL standard).
 */
export function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Escape a string for use inside a SQL LIKE pattern.
 * Escapes single quotes, and escapes LIKE wildcards with backslash.
 * Must be used with ESCAPE '\' in the LIKE clause.
 */
export function sqlLikeEscape(value: string): string {
  return value.replace(/'/g, "''").replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Coerce a value to a safe integer for SQL interpolation.
 * Defense-in-depth: even though Zod validates at the MCP boundary,
 * this guards internal functions against misuse or future refactors.
 * Throws on NaN, Infinity, or non-numeric strings.
 */
export function safeInt(value: unknown): number {
  const n = typeof value === "number" ? Math.trunc(value) : parseInt(String(value), 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid integer value: ${String(value)}`);
  return n;
}
