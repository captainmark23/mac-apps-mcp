import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, mkdir, lstat, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import ICAL from "ical.js";
import { z } from "zod";
import { findBlockedRecipient, getCalendarNames, isReadOnly } from "../shared/config.js";
import { icloudUrl, mailAddress, preflight, InvitationRefused, type CalendarSelection, type DavRequest } from "./invitation-caldav.js";

const address = z.string().max(254).refine(v => {
  try { return mailAddress(`mailto:${v}`) === v.toLowerCase(); } catch { return false; }
}, "Use a bare email address");
const text = (max: number, multiline = false) => z.string().max(max).refine(v =>
  !(multiline ? /[\x00-\x08\x0b-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(v), "Unsupported control character");
const time = z.string().datetime({ offset: true }).refine(v =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v)),
"Use an offset-aware timestamp with whole seconds");
export const InvitationSchema = z.object({
  operationId: z.string().uuid().describe("Caller-stable UUID persisted with the exact approved proposal. Never replace it to retry."),
  calendar: text(200).refine(v => !!v.trim(), "Calendar required"),
  calendarUrl: z.string().max(2000).describe("Exact collection URL returned by calendar_invitation_check; no name fallback."),
  organizer: address,
  attendees: z.array(address).min(1).max(20),
  title: text(1000).refine(v => !!v.trim(), "Title required"),
  start: time,
  end: time,
  location: text(1000),
  description: text(4000, true),
}).strict();
export type Invitation = z.infer<typeof InvitationSchema>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function identity(item: Invitation) { return `mac-apps-mcp-${hash(item.operationId.toLowerCase())}`; }

export function validateInvitation(raw: unknown, selection: CalendarSelection): Invitation {
  const item = InvitationSchema.parse(raw);
  if (!item.title.trim() || Date.parse(item.end) <= Date.parse(item.start)) throw new InvitationRefused("A title and an end after start are required.");
  if (new Set(item.attendees.map(v => v.toLowerCase())).size !== item.attendees.length ||
      item.attendees.some(v => v.toLowerCase() === item.organizer.toLowerCase())) throw new InvitationRefused("Attendees must be distinct from each other and the organizer.");
  if (item.calendar !== selection.calendar || item.calendarUrl !== selection.calendarUrl || item.organizer !== selection.organizer) throw new InvitationRefused("The exact calendar or organizer differs from owner setup.");
  icloudUrl(item.calendarUrl);
  const calendars = getCalendarNames();
  if (calendars && !calendars.includes(item.calendar)) throw new InvitationRefused("The calendar is excluded by MACOS_MCP_CALENDARS.");
  if (findBlockedRecipient(item.attendees)) throw new InvitationRefused("An attendee is excluded by MACOS_MCP_ALLOWED_RECIPIENTS.");
  return item;
}

export function eventBytes(item: Invitation, uid: string): string {
  const calendar = new ICAL.Component("vcalendar");
  calendar.addPropertyWithValue("version", "2.0");
  calendar.addPropertyWithValue("prodid", "-//mac-apps-mcp//Personal invitations//EN");
  const event = new ICAL.Component("vevent");
  for (const [name, value] of Object.entries({ uid, summary: item.title, location: item.location, description: item.description, sequence: 0, transp: "OPAQUE", status: "CONFIRMED" })) event.addPropertyWithValue(name, value);
  for (const [name, value] of Object.entries({ dtstamp: new Date(), dtstart: new Date(item.start), dtend: new Date(item.end) })) event.addPropertyWithValue(name, ICAL.Time.fromJSDate(value, true));
  const uri = (value: string) => `mailto:${encodeURIComponent(value).replace(/%40/g, "@")}`;
  event.addPropertyWithValue("organizer", uri(item.organizer));
  for (const attendee of item.attendees) {
    const prop = event.addPropertyWithValue("attendee", uri(attendee));
    prop.setParameter("partstat", "NEEDS-ACTION");
    prop.setParameter("rsvp", "TRUE");
    prop.setParameter("schedule-agent", "SERVER");
  }
  calendar.addSubcomponent(event);
  return calendar.toString() + "\r\n";
}

export interface InvitationReceipt {
  state: "stored" | "outcome_unknown";
  operationId: string;
  uid: string;
  resourceUrl: string;
  reused: boolean;
  writeResponseStatus?: number;
  event?: { calendar: string; calendarUrl: string; organizer: string; title: string; start: string; end: string; location: string; description: string; attendees: string[] };
  recipients: { attendee: string; scheduleStatus: string[]; scheduling: string; participation: string }[];
  message: string;
}
function unknown(item: Invitation, reused: boolean): InvitationReceipt {
  return { state: "outcome_unknown", operationId: item.operationId, uid: identity(item), resourceUrl: item.calendarUrl + identity(item) + ".ics", reused, recipients: [], message: "Storage could not be verified. Reconcile this operationId; do not create a new operation or resend. Delivery and acceptance are unverified." };
}

export function receipt(raw: string, item: Invitation, reused: boolean): InvitationReceipt {
  const result = unknown(item, reused);
  try {
    const calendar = new ICAL.Component(ICAL.parse(raw));
    const events = calendar.getAllSubcomponents("vevent");
    if (calendar.name !== "vcalendar" || events.length !== 1) return result;
    const event = events[0];
    const scalar = (name: string) => {
      const props = event.getAllProperties(name);
      if (props.length !== 1) throw new Error("Missing or ambiguous property");
      return props[0].getFirstValue();
    };
    for (const key of ["rrule", "rdate", "exdate", "recurrence-id"]) if (event.hasProperty(key)) return result;
    if (event.getFirstPropertyValue("status") === "CANCELLED" || event.getFirstPropertyValue("transp") === "TRANSPARENT") return result;
    if (scalar("uid") !== identity(item)) return result;
    const asTime = (name: string) => {
      const value = scalar(name);
      if (!(value instanceof ICAL.Time) || value.isDate || value.zone === ICAL.Timezone.localTimezone) throw new Error("Unresolved time");
      return value.toJSDate().toISOString();
    };
    const actual = {
      calendar: item.calendar, calendarUrl: item.calendarUrl,
      organizer: mailAddress(String(scalar("organizer"))), title: String(scalar("summary")),
      start: asTime("dtstart"), end: asTime("dtend"),
      location: String(scalar("location")), description: String(scalar("description")),
      attendees: event.getAllProperties("attendee").map(prop => mailAddress(String(prop.getFirstValue()))),
    };
    if (actual.organizer !== item.organizer.toLowerCase() || actual.title !== item.title || actual.location !== item.location || actual.description !== item.description ||
        actual.start !== new Date(item.start).toISOString() || actual.end !== new Date(item.end).toISOString() ||
        actual.attendees.length !== item.attendees.length || new Set(actual.attendees).size !== actual.attendees.length ||
        item.attendees.some(v => !actual.attendees.includes(v.toLowerCase()))) return result;
    const recipients = event.getAllProperties("attendee").map(prop => {
      const value = prop.getParameter("schedule-status");
      const codes = (Array.isArray(value) ? value : String(value || "").split(",")).map(String);
      const scheduleStatus = codes.length && codes.every(v => /^[1-5]\.\d+(?:\.\d+)?$/.test(v)) ? codes : [];
      const rawParticipation = String(prop.getParameter("partstat") || "unknown");
      const participation = ["NEEDS-ACTION", "ACCEPTED", "DECLINED", "TENTATIVE", "DELEGATED"].includes(rawParticipation) ? rawParticipation : "unknown";
      const scheduling = scheduleStatus.some(v => /^[345]\./.test(v)) ? "failed" :
        scheduleStatus.length === 1 ? ({ "1.0": "pending", "1.1": "sent_delivery_unknown", "1.2": "server_reports_delivered", "2.0": "success_delivery_unknown" }[scheduleStatus[0]] || "unknown") : "unknown";
      return { attendee: mailAddress(String(prop.getFirstValue())), scheduleStatus, scheduling, participation };
    });
    return { ...result, state: "stored", event: actual, recipients, message: "Exact event fields and attendees read back from the selected calendar. Storage is not proof of recipient receipt or acceptance; consult each recipient's reported status." };
  } catch { return result; }
}

/** Exclusive, fsynced operation reservation survives crashes and prevents repeat PUTs. */
export class OperationStore {
  constructor(private directory: string) {}
  async reserve(item: Invitation): Promise<boolean> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const dir = await lstat(this.directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) || dir.uid !== process.getuid?.()) throw new InvitationRefused("Invitation operation directory must be private and owner-controlled.");
    // Explicit property order binds every exact input, including offsets and attendee ordering.
    const digest = hash(JSON.stringify(InvitationSchema.parse(item)));
    const path = join(this.directory, identity(item) + ".json");
    // Publish the complete digest atomically, so concurrent callers never see a partial file.
    const temporary = join(this.directory, `.reserve-${randomUUID()}`);
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      try { await file.writeFile(digest); await file.sync(); } finally { await file.close(); }
      try { await link(temporary, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await existing.stat();
          if (!stat.isFile() || stat.size > 1024 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error();
          if ((await existing.readFile("utf8")) !== digest) throw new Error();
        } catch { throw new InvitationRefused("Operation identity is already reserved with different or unreadable data. Reconcile it; do not resend."); }
        finally { await existing.close(); }
        return false;
      }
      const directory = await open(this.directory, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
      return true;
    } finally { await unlink(temporary); }
  }
}

export async function sendInvitation(raw: unknown, selection: CalendarSelection, request: DavRequest, store: OperationStore): Promise<InvitationReceipt> {
  if (isReadOnly()) throw new InvitationRefused("Writes are disabled by MACOS_MCP_READONLY.");
  const item = validateInvitation(raw, selection);
  await preflight(request, selection);
  const first = await store.reserve(item);
  const result = unknown(item, !first);
  try {
    const existing = await request("GET", result.resourceUrl);
    if (existing.status === 200) return receipt(existing.body, item, true);
    if (existing.status !== 404 || !first) return result;
  } catch { return result; }
  let writeResponseStatus: number | undefined;
  try {
    // Reservation precedes the only allowed PUT. Even a crash or later 404 cannot allow another.
    writeResponseStatus = (await request("PUT", result.resourceUrl, eventBytes(item, result.uid), { "If-None-Match": "*", "Content-Type": "text/calendar; charset=utf-8" })).status;
  } catch { /* A timeout can follow successful storage. Read back once, never resend. */ }
  const readback = await reconcileInvitation(item, selection, request, false);
  return writeResponseStatus === undefined ? readback : { ...readback, writeResponseStatus };
}

export async function reconcileInvitation(raw: unknown, selection: CalendarSelection, request: DavRequest, reused = true): Promise<InvitationReceipt> {
  const item = validateInvitation(raw, selection);
  const result = unknown(item, reused);
  try {
    const response = await request("GET", result.resourceUrl);
    if (response.status === 200) return receipt(response.body, item, reused);
  } catch { /* Unknown remains explicit. */ }
  return result;
}
