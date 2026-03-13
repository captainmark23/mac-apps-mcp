/**
 * Configuration via environment variables.
 *
 * MACOS_MCP_CALENDARS: Comma-separated list of calendar names to include.
 *   If not set, all calendars are queried (can be slow with many calendars).
 *   Example: "Mark Work,Mark Personal,Family"
 *
 * MACOS_MCP_MAIL_ACCOUNT: Default mail account name.
 * MACOS_MCP_REMINDER_LISTS: Comma-separated list of reminder lists to include.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, existsSync } from "node:fs";

export function getCalendarNames(): string[] | null {
  const val = process.env.MACOS_MCP_CALENDARS;
  if (!val) return null;
  return val.split(",").map((s) => s.trim()).filter(Boolean);
}

export function getDefaultMailAccount(): string | undefined {
  return process.env.MACOS_MCP_MAIL_ACCOUNT || undefined;
}

export function getReminderLists(): string[] | null {
  const val = process.env.MACOS_MCP_REMINDER_LISTS;
  if (!val) return null;
  return val.split(",").map((s) => s.trim()).filter(Boolean);
}

// ─── Mail DB Auto-Detection ──────────────────────────────────────

let _mailDbPath: string | null = null;
let _mailDir: string | null = null;

/**
 * Auto-detect the Mail database path by finding the latest V* directory.
 * Handles future macOS versions that may bump from V10 to V11+.
 */
export function getMailDbPath(): string {
  if (_mailDbPath) return _mailDbPath;
  const mailBase = join(homedir(), "Library/Mail");
  if (!existsSync(mailBase)) {
    throw new Error(`Mail directory not found: ${mailBase}`);
  }
  const versions = readdirSync(mailBase)
    .filter((e) => /^V\d+$/.test(e))
    .sort((a, b) => parseInt(b.slice(1), 10) - parseInt(a.slice(1), 10));
  if (versions.length === 0) {
    throw new Error("No Mail version directory (V10, V11, ...) found");
  }
  _mailDir = join(mailBase, versions[0]);
  _mailDbPath = join(_mailDir, "MailData/Envelope Index");
  return _mailDbPath;
}

/** Get the Mail base directory (e.g. ~/Library/Mail/V10). */
export function getMailDir(): string {
  if (!_mailDir) getMailDbPath();
  return _mailDir!;
}

// ─── Cache with TTL ──────────────────────────────────────────────

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Simple in-memory cache with TTL expiration.
 * Prevents stale data when accounts/lists change during a session.
 */
export class TtlCache<K, V> {
  private cache = new Map<K, { value: V; expiresAt: number }>();
  private ttlMs: number;

  constructor(ttlMs = DEFAULT_CACHE_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): void {
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.cache.clear();
  }
}

// ─── Shared Mail Account Resolution ─────────────────────────────

const _mailAccountCache = new TtlCache<string, string>();
let _mailAccountPopulated = false;
let _mailAccountExpiry = 0;

/**
 * Resolve a Mail account name to its UUID.
 * Uses a shared TTL cache so multiple modules don't each maintain their own.
 * Requires the caller to pass in executeJxa to avoid circular imports.
 */
export async function resolveMailAccountUuid(
  accountName: string,
  executeJxa: <T>(script: string) => Promise<T>
): Promise<string | null> {
  if (!_mailAccountPopulated || Date.now() > _mailAccountExpiry) {
    try {
      const accounts = await executeJxa<{ name: string; id: string }[]>(`
        const Mail = Application("Mail");
        JSON.stringify(Mail.accounts().map(a => ({ name: a.name(), id: a.id() })));
      `);
      for (const a of accounts) {
        _mailAccountCache.set(a.name.toLowerCase(), a.id);
      }
    } catch {
      // Populate flag still set to prevent retries on failure
    }
    _mailAccountPopulated = true;
    _mailAccountExpiry = Date.now() + DEFAULT_CACHE_TTL_MS;
  }
  return _mailAccountCache.get(accountName.toLowerCase()) ?? null;
}
