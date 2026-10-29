/**
 * The single connector password, stored only as a scrypt hash.
 *
 * Format: scrypt$N$r$p$<salt base64>$<hash base64>. The hash comes from
 * MACOS_MCP_OAUTH_PASSWORD_HASH, else ~/.macos-mcp/oauth-password (0600,
 * written by `npm run set-password`), so it never has to sit in a plist.
 */

import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const N = 1 << 15;
const R = 8;
const P = 1;
const KEY_LEN = 32;
/** scrypt needs 128 * N * r bytes; give it headroom over the 32 MB default. */
const MAX_MEM = 256 * N * R;

export const MIN_PASSWORD_LENGTH = 12;

export const PASSWORD_FILE = join(homedir(), ".macos-mcp", "oauth-password");

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LEN, { N, r: R, p: P, maxmem: MAX_MEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** Constant-time check; a malformed stored hash never verifies. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.trim().split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map((v) => parseInt(v, 10));
  if (![n, r, p].every((v) => Number.isInteger(v) && v > 0)) return false;
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = scryptSync(password, salt, expected.length, { N: n, r, p, maxmem: 256 * n * r });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** The stored hash, or null when none is configured (the HTTP transport then refuses to start). */
export function readPasswordHash(file = PASSWORD_FILE): string | null {
  const fromEnv = process.env.MACOS_MCP_OAUTH_PASSWORD_HASH?.trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(file)) return null;
  const fromFile = readFileSync(file, "utf8").trim();
  return fromFile || null;
}
