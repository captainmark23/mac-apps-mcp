/** Credentials are accessed only at runtime, never returned by MCP tools. */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, mkdir, lstat, link, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { davClient, icloudUrl, InvitationRefused, mailAddress } from "./invitation-caldav.js";
import { OperationStore } from "./invitations.js";

export const invitationDirectory = join(homedir(), "Library", "Application Support", "mac-apps-mcp", "invitations");
export const settingsSchema = z.object({
  calendar: z.string().min(1).max(200), calendarUrl: z.string().max(2000), organizer: z.string().max(254), credentialId: z.string().uuid(),
}).strict();
export type Settings = z.infer<typeof settingsSchema>;
const SERVICE = "mac-apps-mcp.calendar-invitations";

export async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new InvitationRefused("Invitation configuration directory must be private and owner-controlled.");
}
export async function readSettings(directory = invitationDirectory): Promise<Settings> {
  try {
    const dir = await lstat(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o077)) throw new Error();
    const file = await open(join(directory, "calendar.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 8192) throw new Error();
      const data = settingsSchema.parse(JSON.parse(await file.readFile("utf8")));
      if (icloudUrl(data.calendarUrl) !== data.calendarUrl || !data.calendarUrl.endsWith("/")) throw new Error();
      if (mailAddress(`mailto:${data.organizer}`) !== data.organizer) throw new Error();
      return data;
    } finally { await file.close(); }
  } catch { throw new InvitationRefused("Personal invitations are not configured correctly. The owner must run calendar-invitations --configure locally."); }
}

// Never include child-process errors, argv, stderr or stdout in surfaced exceptions.
function security(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("/usr/bin/security", args, { timeout: 15_000, maxBuffer: 8192 }, (error, stdout) => {
      if (error) reject(new InvitationRefused("Invitation Keychain access failed."));
      else resolve(stdout.replace(/\n$/, ""));
    });
    child.stdin?.on("error", () => { /* execFile callback reports failure without secrets. */ });
    child.stdin?.end(input);
  });
}
export async function saveCredentials(credentialId: string, username: string, password: string): Promise<void> {
  z.string().uuid().parse(credentialId);
  // Feed security's command interpreter via stdin, keeping secrets out of process argv.
  const quote = (value: string) => '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  await security(["-i"], `add-generic-password -s ${SERVICE} -a ${credentialId} -w ${quote(JSON.stringify({ username, password }))}\n`);
  // security -i may exit successfully after a failed command: verify privately before activation.
  const stored = await security(["find-generic-password", "-s", SERVICE, "-a", credentialId, "-w"]);
  if (stored !== JSON.stringify({ username, password })) throw new InvitationRefused("Keychain verification failed; setup was not activated.");
}
export async function saveSettings(data: Settings, directory = invitationDirectory): Promise<void> {
  const settings = settingsSchema.parse(data);
  await privateDirectory(directory);
  // No silent replacement of an account mapping while operations may be outstanding.
  const temporary = join(directory, `.setup-${randomUUID()}`);
  const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    try { await file.writeFile(JSON.stringify(settings) + "\n"); await file.sync(); } finally { await file.close(); }
    await link(temporary, join(directory, "calendar.json"));
    const dir = await open(directory, constants.O_RDONLY);
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await unlink(temporary); }
}
export async function invitationConnection() {
  const settings = await readSettings();
  try {
    const raw = await security(["find-generic-password", "-s", SERVICE, "-a", settings.credentialId, "-w"]);
    const { username, password } = z.object({ username: z.string().min(1), password: z.string().min(1) }).strict().parse(JSON.parse(raw));
    return { settings, request: davClient(username, password), store: new OperationStore(join(invitationDirectory, "operations")) };
  } catch { throw new InvitationRefused("Invitation authentication is unavailable. The owner must check the local Keychain setup."); }
}
