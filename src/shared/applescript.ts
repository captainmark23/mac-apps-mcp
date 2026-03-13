/**
 * AppleScript/JXA executor for macOS automation.
 *
 * All scripts are executed via osascript. JXA (JavaScript for Automation)
 * is preferred over AppleScript for structured data (JSON output).
 *
 * Security: All user-provided strings are passed via JSON.stringify()
 * to prevent injection attacks.
 */

import { execFile } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface ExecOptions {
  /** Timeout in milliseconds (default: 30s) */
  timeout?: number;
}

/**
 * Execute a JXA (JavaScript for Automation) script via osascript.
 * Returns parsed JSON output.
 */
export async function executeJxa<T = unknown>(
  script: string,
  opts?: ExecOptions
): Promise<T> {
  const timeout = opts?.timeout ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script],
      { timeout, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const msg = stderr?.trim() || error.message;
          if (error.killed || error.code === "ETIMEDOUT") {
            reject(new Error(`Script timed out after ${timeout}ms`));
          } else if (msg.includes("-1728")) {
            reject(new Error("Item not found. It may have been deleted or moved."));
          } else if (msg.includes("-1743") || msg.includes("not allowed")) {
            reject(
              new Error(
                "Permission denied. Grant Automation access in:\n" +
                  "System Settings → Privacy & Security → Automation"
              )
            );
          } else {
            reject(new Error(`AppleScript error: ${msg}`));
          }
          return;
        }

        const raw = stdout.trim();
        if (!raw) {
          resolve(undefined as T);
          return;
        }

        try {
          resolve(JSON.parse(raw) as T);
        } catch {
          // Some scripts return plain text
          resolve(raw as T);
        }
      }
    );
  });
}

/**
 * Safely encode a string for embedding in JXA scripts.
 * Uses JSON.stringify which handles all escaping.
 */
export function jxaString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Safely encode an array of strings for JXA.
 */
export function jxaStringArray(values: string[]): string {
  return JSON.stringify(values);
}

// ─── JXA Write Queue ─────────────────────────────────────────────

/**
 * Serial queue for JXA write operations.
 * Prevents overwhelming macOS apps (Mail, Calendar, Reminders)
 * when an agent fires multiple write calls rapidly.
 * Read operations bypass the queue since they use SQLite.
 */
let _writeQueueTail: Promise<unknown> = Promise.resolve();

export async function executeJxaWrite<T = unknown>(
  script: string,
  opts?: ExecOptions
): Promise<T> {
  const task = _writeQueueTail.then(
    () => executeJxa<T>(script, opts),
    () => executeJxa<T>(script, opts) // proceed even if prior write failed
  );
  _writeQueueTail = task.catch(() => {}); // swallow to keep chain alive
  return task;
}
