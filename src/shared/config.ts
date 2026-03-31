/**
 * Configuration via environment variables.
 *
 * MACOS_MCP_CALENDARS: Comma-separated list of calendar names to include.
 *   If not set, all calendars are queried (can be slow with many calendars).
 *   Example: "My Calendar,Shared Calendar,Team Calendar"
 *
 * MACOS_MCP_MAIL_ACCOUNT: Default mail account name.
 * MACOS_MCP_REMINDER_LISTS: Comma-separated list of reminder lists to include.
 * MACOS_MCP_ALLOWED_RECIPIENTS: Comma-separated list of allowed recipient patterns for mail_send.
 *   Supports wildcard (*) matching. If set, any recipient not matching causes an error.
 *   Example: "*@yourcompany.com,trusted@example.com"
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, existsSync } from "node:fs";
import { sqlLikeEscape } from "./sqlite.js";

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

// ─── Recipient Allowlist ─────────────────────────────────────────

/**
 * Returns the list of allowed recipient patterns from MACOS_MCP_ALLOWED_RECIPIENTS,
 * or null if the env var is not set (meaning all recipients are allowed).
 */
export function getAllowedRecipients(): string[] | null {
  const val = process.env.MACOS_MCP_ALLOWED_RECIPIENTS;
  if (!val) return null;
  return val.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Returns true if the given email address matches at least one pattern in the allowlist.
 * Patterns support a single leading wildcard: `*@domain.com`.
 * Matching is case-insensitive.
 */
export function matchesAllowlist(address: string, patterns: string[]): boolean {
  const addr = address.trim().toLowerCase();
  return patterns.some((pattern) => {
    if (pattern.includes("*")) {
      // Escape all regex metacharacters except *, then replace * with .*
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      return new RegExp(`^${escaped}$`).test(addr);
    }
    return addr === pattern;
  });
}

/**
 * Validates a list of recipient addresses against the allowlist.
 * Returns the first rejected address, or null if all pass (or no allowlist is set).
 */
export function findBlockedRecipient(addresses: string[]): string | null {
  const patterns = getAllowedRecipients();
  if (!patterns) return null;
  return addresses.find((addr) => !matchesAllowlist(addr, patterns)) ?? null;
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
 * Get a cached Map of account ID → account name.
 * Used by mail tools to resolve account names from mailbox URLs.
 */
let _mailAccountMap: Map<string, string> | null = null;
let _mailAccountMapExpiry = 0;

export async function getMailAccountMap(
  executeJxa: <T>(script: string) => Promise<T>
): Promise<Map<string, string>> {
  if (_mailAccountMap && Date.now() < _mailAccountMapExpiry) {
    return _mailAccountMap;
  }
  try {
    const accounts = await executeJxa<{ name: string; id: string }[]>(`
      const Mail = Application("Mail");
      JSON.stringify(Mail.accounts().map(a => ({ name: a.name(), id: a.id() })));
    `);
    const map = new Map<string, string>();
    for (const a of accounts) {
      map.set(a.id, a.name);
    }
    _mailAccountMap = map;
    _mailAccountMapExpiry = Date.now() + DEFAULT_CACHE_TTL_MS;
    return map;
  } catch (e) {
    process.stderr.write(`[config] Failed to refresh mail account map: ${e instanceof Error ? e.message : String(e)}\n`);
    return _mailAccountMap ?? new Map();
  }
}

let _mailAccountRefreshPromise: Promise<void> | null = null;

export async function resolveMailAccountUuid(
  accountName: string,
  executeJxa: <T>(script: string) => Promise<T>
): Promise<string | null> {
  if (!_mailAccountPopulated || Date.now() > _mailAccountExpiry) {
    // Use a single in-flight promise to prevent concurrent JXA calls
    if (!_mailAccountRefreshPromise) {
      _mailAccountRefreshPromise = (async () => {
        try {
          const accounts = await executeJxa<{ name: string; id: string }[]>(`
            const Mail = Application("Mail");
            JSON.stringify(Mail.accounts().map(a => ({ name: a.name(), id: a.id() })));
          `);
          for (const a of accounts) {
            _mailAccountCache.set(a.name.toLowerCase(), a.id);
          }
        } catch (e) {
          // Populate flag still set to prevent retries on failure
          process.stderr.write(`[config] Failed to refresh mail account UUIDs: ${e instanceof Error ? e.message : String(e)}\n`);
        }
        _mailAccountPopulated = true;
        _mailAccountExpiry = Date.now() + DEFAULT_CACHE_TTL_MS;
        _mailAccountRefreshPromise = null;
      })();
    }
    await _mailAccountRefreshPromise;
  }
  return _mailAccountCache.get(accountName.toLowerCase()) ?? null;
}

/**
 * Build SQL filter for account-specific mailbox URL matching.
 * Used by mail tools and FTS search to filter queries by mailbox/account.
 */
export async function mailboxUrlFilter(
  mailbox: string,
  account: string | undefined,
  executeJxa: <T>(script: string) => Promise<T>
): Promise<string> {
  const effectiveAccount = account || getDefaultMailAccount();
  const encodedMailbox = sqlLikeEscape(encodeURIComponent(mailbox));

  if (effectiveAccount) {
    const uuid = await resolveMailAccountUuid(effectiveAccount, executeJxa);
    if (uuid) {
      return `mb.url LIKE '%${sqlLikeEscape(uuid)}/${encodedMailbox}' ESCAPE '\\'`;
    }
  }
  return `mb.url LIKE '%/${encodedMailbox}' ESCAPE '\\'`;
}
