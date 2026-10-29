#!/usr/bin/env node

/**
 * `npm run set-password`: prompt for the connector password (twice, hidden)
 * and write its scrypt hash to ~/.macos-mcp/oauth-password with mode 0600.
 * Piped input is read as a single line, for scripted setups.
 */

import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { hashPassword, MIN_PASSWORD_LENGTH, PASSWORD_FILE } from "./password.js";

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function readPiped(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.split(/\r?\n/)[0];
}

async function main() {
  let password: string;
  if (process.stdin.isTTY) {
    password = await readHidden("New connector password: ");
    if ((await readHidden("Repeat it: ")) !== password) {
      console.error("Passwords do not match. Nothing changed.");
      process.exit(1);
    }
  } else {
    password = await readPiped();
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`Use at least ${MIN_PASSWORD_LENGTH} characters. Nothing changed.`);
    process.exit(1);
  }
  mkdirSync(dirname(PASSWORD_FILE), { recursive: true });
  writeFileSync(PASSWORD_FILE, `${hashPassword(password)}\n`, { mode: 0o600 });
  chmodSync(PASSWORD_FILE, 0o600);
  console.log(`Saved the password hash to ${PASSWORD_FILE}. Restart the connector to use it.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
