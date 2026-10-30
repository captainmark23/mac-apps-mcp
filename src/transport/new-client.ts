#!/usr/bin/env node

/**
 * `npm run new-client`: create the OAuth client Claude signs in with and
 * print its ID and secret once. Replacing an existing client signs every
 * connection out, which is also how to rotate the secret.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CLIENT_FILE, newClient } from "./client.js";

const replaced = existsSync(CLIENT_FILE);
const { secret, record } = newClient();
mkdirSync(dirname(CLIENT_FILE), { recursive: true });
writeFileSync(CLIENT_FILE, `${JSON.stringify(record)}\n`, { mode: 0o600 });
chmodSync(CLIENT_FILE, 0o600);

console.log(`Client ID:     ${record.clientId}
Client secret: ${secret}

The secret is shown only now. Enter both when you add the connector:
  claude.ai:   Add custom connector > Advanced settings (use your own OAuth client)
  Claude Code: claude mcp add --transport http --client-id ${record.clientId} --client-secret <name> <url>
Then restart the connector.`);
if (replaced) {
  console.log("\nThis replaced the previous client, so every existing connection is signed out. Remove and re-add the connector in claude.ai and Claude Code.");
}
