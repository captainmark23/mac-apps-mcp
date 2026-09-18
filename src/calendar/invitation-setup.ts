#!/usr/bin/env node
/** Owner-run interactive setup/check only. Never sends an event. */
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { davClient, discover, preflight } from "./invitation-caldav.js";
import { invitationConnection, invitationDirectory, privateDirectory, saveCredentials, saveSettings } from "./invitation-settings.js";

export async function configure() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Run setup in the owner's terminal.");
  await privateDirectory(invitationDirectory);
  try {
    await lstat(join(invitationDirectory, "calendar.json"));
    throw new Error("A calendar is already configured. Resolve outstanding operations before an explicit account reconfiguration.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } });
  const prompt = createInterface({ input: process.stdin, output, terminal: true });
  const choose = async (label: string, values: string[]) => {
    console.log(label);
    values.forEach((value, index) => console.log(`${index + 1}. ${value.replace(/[\x00-\x1f\x7f-\x9f]/g, "")}`));
    const answer = await prompt.question("Number: ");
    const index = Number(answer) - 1;
    if (!/^\d+$/.test(answer) || !Number.isInteger(index) || index < 0 || index >= values.length) throw new Error("No valid selection.");
    return index;
  };
  try {
    const username = (await prompt.question("Apple account email: ")).trim();
    process.stdout.write("App-specific password (hidden): ");
    muted = true;
    const password = await prompt.question("");
    muted = false;
    process.stdout.write("\n");
    if (!username || username.includes(":") || !password) throw new Error("Account and app-specific password are required.");
    const request = davClient(username, password);
    const found = await discover(request);
    const calendar = found.calendars[await choose("Select your PERSONAL calendar (exact collection):", found.calendars.map(c => `${c.calendar} (${c.calendarUrl})`))];
    const organizer = found.organizers[await choose("Select organizer:", found.organizers)];
    const settings = { ...calendar, organizer, credentialId: randomUUID() };
    await preflight(request, settings);
    console.log("Ownership, event creation and scheduling privileges verified. No event was sent.");
    if (await prompt.question("Type SAVE to store this selection and credentials in your login Keychain: ") !== "SAVE") return;
    await saveCredentials(settings.credentialId, username, password);
    await saveSettings(settings);
    console.log("Configured. No invitation was sent. Run --check before using the MCP invitation tool.");
  } finally { muted = false; prompt.close(); }
}
export async function main() {
  const arg = process.argv[2];
  if (process.argv.length !== 3 || !["--configure", "--check"].includes(arg)) throw new Error("Usage: calendar-invitations --configure | --check");
  if (arg === "--configure") return configure();
  const { settings, request } = await invitationConnection();
  await preflight(request, settings);
  console.log("Calendar ownership, organizer and scheduling privileges verified. No writes performed.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Do not print network/parser/Keychain errors: they can carry account data or credentials.
    console.error("Invitation setup/check failed. No invitation was sent. Check local account access and the setup documentation.");
    process.exitCode = 1;
  });
}
