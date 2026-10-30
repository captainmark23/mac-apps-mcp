/**
 * The connector's one OAuth client. Claude signs in with this client ID and
 * secret instead of registering itself, so the server has no public
 * registration endpoint and a sign-in code is useless without the secret.
 *
 * Only a SHA-256 of the secret is stored, in ~/.macos-mcp/oauth-client (0600,
 * written by `npm run new-client`). The secret is 32 random bytes, so a fast
 * hash is enough; the password needs scrypt because a person chose it.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CLIENT_FILE = join(homedir(), ".macos-mcp", "oauth-client");

export interface ClientCredentials {
  clientId: string;
  secretSha256: string;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function newClient(): { secret: string; record: ClientCredentials } {
  const secret = randomBytes(32).toString("base64url");
  return {
    secret,
    record: { clientId: `mac-apps-mcp-${randomBytes(8).toString("hex")}`, secretSha256: sha256(secret).toString("hex") },
  };
}

export function verifyClientSecret(secret: string, record: ClientCredentials): boolean {
  const expected = Buffer.from(record.secretSha256, "hex");
  const actual = sha256(secret);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** The stored client, or null if `npm run new-client` has not been run. */
export function readClient(): ClientCredentials | null {
  if (!existsSync(CLIENT_FILE)) return null;
  const saved = JSON.parse(readFileSync(CLIENT_FILE, "utf8")) as Partial<ClientCredentials>;
  if (typeof saved.clientId !== "string" || !/^[0-9a-f]{64}$/.test(saved.secretSha256 ?? "")) {
    throw new Error(`${CLIENT_FILE} is malformed. Run \`npm run new-client\` to replace it.`);
  }
  return { clientId: saved.clientId, secretSha256: saved.secretSha256! };
}
