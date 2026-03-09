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
