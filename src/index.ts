#!/usr/bin/env node

/**
 * macOS MCP Server
 *
 * Unified MCP server for Apple Mail, Calendar, Reminders, and Contacts.
 * Read operations use SQLite for instant results; writes use JXA.
 *
 * Tool registrations are organized per-domain in each module's register.ts
 * and assembled in server.ts. MACOS_MCP_TRANSPORT picks stdio (default) or
 * the HTTP connector in transport/http.ts.
 */

import { createWriteStream, existsSync, mkdirSync, statSync, renameSync, WriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { sanitizeErrorMessage } from "./shared/types.js";
import { isReadOnly, getTransport } from "./shared/config.js";
import { createServer } from "./server.js";
import { startHttp } from "./transport/http.js";

import * as mailFts from "./mail/fts.js";

// ─── Persistent file logging ────────────────────────────────────
// Writes to ~/.macos-mcp/macos-mcp.log with simple size-based rotation.
// stderr is still used (stdout is reserved for MCP stdio transport).

const LOG_DIR = join(homedir(), ".macos-mcp");
const LOG_PATH = join(LOG_DIR, "macos-mcp.log");
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5MB
const LOG_BACKUPS = 3;

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

function rotateLogIfNeeded(): void {
  try {
    if (!existsSync(LOG_PATH)) return;
    const size = statSync(LOG_PATH).size;
    if (size < LOG_MAX_BYTES) return;
    // Shift backups: .3 → deleted, .2 → .3, .1 → .2, current → .1
    for (let i = LOG_BACKUPS; i >= 1; i--) {
      const src = i === 1 ? LOG_PATH : `${LOG_PATH}.${i - 1}`;
      const dst = `${LOG_PATH}.${i}`;
      if (existsSync(src)) renameSync(src, dst);
    }
  } catch { /* best-effort rotation */ }
}

rotateLogIfNeeded();
let _logStream: WriteStream | null = null;
try {
  _logStream = createWriteStream(LOG_PATH, { flags: "a" });
} catch { /* file logging unavailable — stderr still works */ }

/** Log to both stderr and the persistent log file. Sanitizes paths from messages. */
function log(message: string): void {
  const sanitized = sanitizeErrorMessage(message);
  const line = `${new Date().toISOString()} [macos-mcp] ${sanitized}\n`;
  process.stderr.write(line);
  _logStream?.write(line);
}

// ─── Server Setup ───────────────────────────────────────────────

/** Default message limit for FTS auto-index on first run. */
const FTS_AUTO_INDEX_BATCH = 5_000;

/** Default message limit for FTS incremental index on startup. */
const FTS_AUTO_INDEX_INCREMENTAL = 50_000;

// ═══════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════

/**
 * Auto-build the FTS index on startup.
 * Runs in the background so it doesn't block tool calls.
 * First run indexes the entire mailbox; subsequent runs catch up incrementally.
 */
async function autoIndexOnStartup() {
  try {
    const stats = await mailFts.getIndexStats();
    const isFirstRun = stats.indexedCount === 0;

    if (isFirstRun) {
      log(`First run — building FTS index for ${stats.totalMessages} messages in background...`);
      const result = await mailFts.rebuildIndex(FTS_AUTO_INDEX_BATCH);
      log(`FTS index built: ${result.indexed} messages indexed, ${result.skipped} skipped`);
    } else {
      const result = await mailFts.indexNewMessages(FTS_AUTO_INDEX_INCREMENTAL);
      if (result.indexed > 0) {
        log(`FTS index updated: ${result.indexed} new messages indexed`);
      }
    }
  } catch (e) {
    // Non-fatal — FTS is optional, other tools still work
    log(`FTS auto-index skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main() {
  if (isReadOnly()) {
    log("Read-only mode enabled (MACOS_MCP_READONLY). Write tools will not be registered.");
  }

  if (getTransport() === "http") {
    await startHttp(log);
  } else {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }

  // Kick off FTS indexing in background after server is ready
  autoIndexOnStartup().catch((e) => {
    log(`FTS auto-index unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  });
}

main().catch((error) => {
  log(`Server failed to start: ${error}`);
  console.error("Server failed to start:", sanitizeErrorMessage(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
