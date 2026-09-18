import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ICAL from "ical.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { davClient, discover, preflight, properties, icloudUrl, type DavRequest, type DavResponse } from "../calendar/invitation-caldav.js";
import { eventBytes, identity, InvitationSchema, OperationStore, receipt, reconcileInvitation, sendInvitation, validateInvitation, type Invitation } from "../calendar/invitations.js";
import { registerInvitationTools } from "../calendar/invitation-register.js";
import { readSettings, saveSettings } from "../calendar/invitation-settings.js";

const base = "https://p01-caldav.icloud.com";
const selection = { calendar: "Fictional Personal", calendarUrl: `${base}/fictional/calendars/personal/`, organizer: "alex@example.com" };
const item: Invitation = {
  ...selection, operationId: "cd917617-b25a-4e1e-95b5-5e905aa29e23", attendees: ["blair@example.net", "casey@example.org"],
  title: "Coffee, walk; café \\ plans", start: "2027-06-08T10:00:00-07:00", end: "2027-06-08T11:15:00-07:00",
  location: "Fictional café", description: "First line\nSecond; line, with \\ and 日本語",
};
const principal = `${base}/fictional/principal/`;
const outbox = `${base}/fictional/outbox/`;
const home = `${base}/fictional/calendars/`;
const response = (status: number, body = "", headers: Record<string, string> = {}): DavResponse => ({ status, body, headers: new Headers(headers) });
const row = (url: string, props: string, status = "200 OK") => `<D:response><D:href>${url}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 ${status}</D:status></D:propstat></D:response>`;
const xml = (...rows: string[]) => `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${rows.join("")}</D:multistatus>`;
const privileges = (values: string[]) => `<D:current-user-privilege-set>${values.map(v => `<D:privilege><${v}/></D:privilege>`).join("")}</D:current-user-privilege-set>`;
class Server {
  calls: { method: string; url: string; body?: string; headers?: Record<string, string> }[] = [];
  resource: string | undefined;
  options = "calendar-access, calendar-auto-schedule";
  owner = principal;
  ownerAddress = selection.organizer;
  calendarPrivileges = ["D:bind", "D:write-content"];
  outboxPrivileges = ["C:schedule-send-invite"];
  putStatus = 201;
  timeout = false;
  loseWrite = false;
  failGet = false;
  mutate: (body: string) => string = body => body;
  request: DavRequest = async (method, url, body, headers) => {
    this.calls.push({ method, url, body, headers });
    if (method === "OPTIONS") return response(200, "", { DAV: this.options });
    if (method === "PROPFIND") {
      let props = "";
      if (url === "https://caldav.icloud.com/") props = `<D:current-user-principal><D:href>${principal}</D:href></D:current-user-principal>`;
      else if (url === selection.calendarUrl) props = `<D:owner><D:href>${this.owner}</D:href></D:owner><D:current-user-principal><D:href>${principal}</D:href></D:current-user-principal><D:resourcetype><C:calendar/></D:resourcetype><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>${privileges(this.calendarPrivileges)}`;
      else if (url === principal) props = `<C:calendar-user-address-set><D:href>mailto:${this.ownerAddress}</D:href></C:calendar-user-address-set><C:schedule-outbox-URL><D:href>${outbox}</D:href></C:schedule-outbox-URL><C:calendar-home-set><D:href>${home}</D:href></C:calendar-home-set>`;
      else if (url === outbox) props = privileges(this.outboxPrivileges);
      else if (url === home) return response(207, xml(row(selection.calendarUrl, `<D:displayname>${selection.calendar}</D:displayname><D:resourcetype><C:calendar/></D:resourcetype>`), row(home, "<D:resourcetype><D:collection/></D:resourcetype>")));
      else throw new Error("Unexpected PROPFIND");
      return response(207, xml(row(url, props)));
    }
    if (method === "GET") {
      if (this.failGet) throw new Error("GET timed out");
      return this.resource ? response(200, this.resource) : response(404);
    }
    if (method === "PUT") {
      assert.equal(headers?.["If-None-Match"], "*");
      if (!this.loseWrite && this.putStatus === 201) this.resource = this.mutate(body!);
      if (this.timeout) throw new Error("PUT timeout after possible commit");
      return response(this.putStatus);
    }
    throw new Error("Unexpected method");
  };
  get puts() { return this.calls.filter(c => c.method === "PUT"); }
}
const temporary: string[] = [];
async function store() {
  const directory = await mkdtemp(join(tmpdir(), "mcp-invitation-test-"));
  temporary.push(directory);
  return { directory, store: new OperationStore(directory) };
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function alter(body: string, change: (event: ICAL.Component) => void) {
  const calendar = new ICAL.Component(ICAL.parse(body));
  change(calendar.getFirstSubcomponent("vevent")!);
  return calendar.toString();
}

describe("exact invitations and scheduling receipts", () => {
  it("conditionally creates, reads actual fields and preserves offset instants and escaped Unicode text", async () => {
    const server = new Server(); const local = await store();
    const result = await sendInvitation(item, selection, server.request, local.store);
    assert.equal(result.state, "stored");
    assert.deepEqual(result.event, { ...selection, title: item.title, start: "2027-06-08T17:00:00.000Z", end: "2027-06-08T18:15:00.000Z", location: item.location, description: item.description, attendees: item.attendees });
    assert.equal(server.puts.length, 1);
    assert.equal(result.recipients[0].scheduling, "unknown");
    assert.equal(result.recipients[0].participation, "NEEDS-ACTION");
    assert.match(server.puts[0].body!, /SCHEDULE-AGENT=SERVER/);
    assert.match(server.puts[0].body!, /TRANSP:OPAQUE/);
    assert.ok(!server.puts[0].body!.includes("METHOD:"));
  });
  it("keeps scheduling success, failures and participation separate", async () => {
    const server = new Server(); const local = await store();
    server.mutate = body => alter(body, event => {
      const attendees = event.getAllProperties("attendee");
      attendees[0].setParameter("schedule-status", "1.2"); attendees[0].setParameter("partstat", "NEEDS-ACTION");
      attendees[1].setParameter("schedule-status", "5.1"); attendees[1].setParameter("partstat", "DECLINED");
    });
    const result = await sendInvitation(item, selection, server.request, local.store);
    assert.equal(result.state, "stored");
    assert.equal(result.recipients[0].scheduling, "server_reports_delivered");
    assert.equal(result.recipients[0].participation, "NEEDS-ACTION");
    assert.equal(result.recipients[1].scheduling, "failed");
    assert.equal(result.recipients[1].participation, "DECLINED");
  });
  for (const [status, expected] of [["1.0", "pending"], ["1.1", "sent_delivery_unknown"], ["2.0", "success_delivery_unknown"], ["nonsense", "unknown"]]) {
    it(`reports ${status} as ${expected} without inventing acceptance`, () => {
      const raw = alter(eventBytes(item, identity(item)), event => event.getFirstProperty("attendee")!.setParameter("schedule-status", status));
      const result = receipt(raw, item, true);
      assert.equal(result.recipients[0].scheduling, expected);
      assert.equal(result.recipients[0].participation, "NEEDS-ACTION");
    });
  }
  for (const property of ["summary", "location", "description", "organizer", "dtstart", "dtend", "attendee", "uid", "status", "transp", "rrule"]) {
    it(`does not report verified storage when read-back ${property} differs`, () => {
      const raw = alter(eventBytes(item, identity(item)), event => {
        if (["dtstart", "dtend"].includes(property)) event.updatePropertyWithValue(property, ICAL.Time.fromJSDate(new Date("2027-06-09T12:00:00Z"), true));
        else if (property === "rrule") event.addPropertyWithValue("rrule", ICAL.Recur.fromString("FREQ=DAILY"));
        else if (property === "attendee") event.removeProperty(event.getFirstProperty("attendee")!);
        else event.updatePropertyWithValue(property, property === "status" ? "CANCELLED" : property === "transp" ? "TRANSPARENT" : "changed");
      });
      assert.equal(receipt(raw, item, true).state, "outcome_unknown");
    });
  }
  it("rejects duplicated fields and floating time during read-back", () => {
    const original = eventBytes(item, identity(item));
    const duplicate = alter(original, event => event.addPropertyWithValue("summary", item.title));
    assert.equal(receipt(duplicate, item, true).state, "outcome_unknown");
    assert.equal(receipt(original.replace("20270608T170000Z", "20270608T170000"), item, true).state, "outcome_unknown");
  });
  it("supports empty location and description with no hidden defaults", () => {
    const empty = { ...item, location: "", description: "" };
    assert.equal(receipt(eventBytes(empty, identity(empty)), empty, true).state, "stored");
    assert.throws(() => InvitationSchema.parse({ ...item, end: undefined }));
    assert.throws(() => InvitationSchema.parse({ ...item, location: undefined }));
  });
});

describe("durable duplicate prevention", () => {
  it("converges across process-equivalent store instances and concurrent callers", async () => {
    const server = new Server(); const local = await store();
    const results = await Promise.all(Array.from({ length: 5 }, () => sendInvitation(item, selection, server.request, new OperationStore(local.directory))));
    assert.equal(server.puts.length, 1);
    assert.ok(results.some(r => r.state === "stored"));
    const retry = await sendInvitation(item, selection, server.request, new OperationStore(local.directory));
    assert.equal(retry.state, "stored"); assert.equal(retry.reused, true); assert.equal(server.puts.length, 1);
    const path = join(local.directory, identity(item) + ".json");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await readFile(path, "utf8")).length, 64);
  });
  for (const changed of [{ title: "Changed" }, { attendees: ["other@example.net"] }, { start: "2027-06-08T17:00:00Z" }, { description: "Changed" }]) {
    it(`refuses reuse with changed ${Object.keys(changed)[0]}, even before an earlier unknown is resolved`, async () => {
      const server = new Server(); const local = await store();
      server.loseWrite = true; server.timeout = true;
      await sendInvitation(item, selection, server.request, local.store);
      await assert.rejects(sendInvitation({ ...item, ...changed }, selection, server.request, local.store), /identity is already reserved/);
      assert.equal(server.puts.length, 1);
    });
  }
  it("recovers a timeout after successful PUT with one read-back", async () => {
    const server = new Server(); const local = await store(); server.timeout = true;
    assert.equal((await sendInvitation(item, selection, server.request, local.store)).state, "stored");
    assert.equal(server.puts.length, 1);
  });
  it("never sends again after unknown outcome and repeated 404, including deletion", async () => {
    const server = new Server(); const local = await store(); server.timeout = true; server.loseWrite = true;
    assert.equal((await sendInvitation(item, selection, server.request, local.store)).state, "outcome_unknown");
    server.timeout = false; server.loseWrite = false;
    assert.equal((await sendInvitation(item, selection, server.request, new OperationStore(local.directory))).state, "outcome_unknown");
    assert.equal(server.puts.length, 1);
  });
  it("reconciles a conditional 412 against the actual existing resource", async () => {
    const server = new Server(); const local = await store();
    const original = server.request;
    server.request = async (...args) => {
      if (args[0] === "PUT") { server.resource = eventBytes(item, identity(item)); server.putStatus = 412; }
      return original(...args);
    };
    assert.equal((await sendInvitation(item, selection, server.request, local.store)).state, "stored");
  });
  it("does not write when initial existence lookup fails or journal is corrupt", async () => {
    const server = new Server(); const local = await store(); server.failGet = true;
    assert.equal((await sendInvitation(item, selection, server.request, local.store)).state, "outcome_unknown");
    assert.equal(server.puts.length, 0);
    await writeFile(join(local.directory, identity(item) + ".json"), "");
    await assert.rejects(sendInvitation(item, selection, server.request, local.store), /identity is already reserved/);
  });
  for (const status of [403, 500, 302]) {
    it(`retains HTTP ${status} evidence without claiming storage or repeating a write`, async () => {
      const server = new Server(); const local = await store(); server.putStatus = status;
      const result = await sendInvitation(item, selection, server.request, local.store);
      assert.equal(result.state, "outcome_unknown"); assert.equal(result.writeResponseStatus, status);
      await sendInvitation(item, selection, server.request, local.store);
      assert.equal(server.puts.length, 1);
    });
  }
  it("does not recreate a previously verified event after deletion", async () => {
    const server = new Server(); const local = await store();
    assert.equal((await sendInvitation(item, selection, server.request, local.store)).state, "stored");
    server.resource = undefined;
    assert.equal((await sendInvitation(item, selection, server.request, local.store)).state, "outcome_unknown");
    assert.equal(server.puts.length, 1);
  });
  it("binds the operation across calendar reconfiguration", async () => {
    const local = await store();
    await local.store.reserve(item);
    await assert.rejects(local.store.reserve({ ...item, calendarUrl: `${base}/another/calendar/` }), /identity is already reserved/);
  });
  it("read-back never sends and can observe later acceptance", async () => {
    const server = new Server();
    server.resource = alter(eventBytes(item, identity(item)), event => event.getFirstProperty("attendee")!.setParameter("partstat", "ACCEPTED"));
    const result = await reconcileInvitation(item, selection, server.request);
    assert.equal(result.recipients[0].participation, "ACCEPTED");
    assert.deepEqual(server.calls.map(c => c.method), ["GET"]);
  });
});

describe("preflight and validation", () => {
  for (const change of [
    (server: Server) => { server.options = "calendar-access"; },
    (server: Server) => { server.owner = `${base}/another/principal/`; },
    (server: Server) => { server.ownerAddress = "other@example.com"; },
    (server: Server) => { server.calendarPrivileges = ["D:read"]; },
    (server: Server) => { server.outboxPrivileges = []; },
  ]) {
    it("refuses unsupported scheduling, foreign ownership or missing permissions without writing", async () => {
      const server = new Server(); const local = await store(); change(server);
      await assert.rejects(sendInvitation(item, selection, server.request, local.store));
      assert.equal(server.puts.length, 0);
    });
  }
  it("rejects invalid offsets, dates, control characters, duplicates, organizer attendee and extra fields", () => {
    for (const patch of [
      { start: "2027-06-08T10:00:00" }, { start: "2027-02-30T10:00:00Z" }, { start: "2027-06-08T10:00:00+25:00" },
      { end: item.start }, { title: "bad\r\nATTENDEE:other@example.net" }, { organizer: "Alex <alex@example.com>" },
      { attendees: ["blair@example.net", "BLAIR@example.net"] }, { attendees: [selection.organizer] },
      { attendees: [] }, { calendar: "Other" }, { calendarUrl: `${base}/other/` }, { extra: true },
    ]) assert.throws(() => validateInvitation({ ...item, ...patch }, selection), JSON.stringify(patch));
  });
  it("discovery uses only property requests and returns exact collection URLs", async () => {
    const server = new Server();
    assert.deepEqual(await discover(server.request), { organizers: [selection.organizer], calendars: [{ calendar: selection.calendar, calendarUrl: selection.calendarUrl }] });
    assert.ok(server.calls.every(c => c.method === "PROPFIND"));
    await preflight(server.request, selection);
    assert.ok(server.calls.every(c => ["PROPFIND", "OPTIONS"].includes(c.method)));
  });
  it("rejects failed propstats, wrong namespaces, entity declarations and foreign response resources", async () => {
    for (const body of [xml(row(selection.calendarUrl, "", "403 Forbidden")), xml(row(`${base}/other/`, "")), '<!DOCTYPE a><a/>', '<D:multistatus xmlns:D="evil"/>']) {
      const request: DavRequest = async method => method === "OPTIONS" ? response(200, "", { DAV: "calendar-auto-schedule" }) : response(207, body);
      await assert.rejects(preflight(request, selection));
    }
  });
  it("bounds and validates discovery redirects before credentials can reach another host", async () => {
    let calls = 0;
    const request: DavRequest = async () => { calls++; return response(302, "", { Location: "https://attacker.example.net/" }); };
    await assert.rejects(properties(request, selection.calendarUrl, [], "0", true));
    assert.equal(calls, 1);
    for (const value of ["http://caldav.icloud.com/", "https://caldav.icloud.com.evil.example/", "https://evil-caldav.icloud.com/", "https://user:pass@caldav.icloud.com/", "https://caldav.icloud.com/?x=1"]) assert.throws(() => icloudUrl(value));
  });
  it("bounds HTTP response bodies and disables automatic redirects", async () => {
    const fetcher: typeof fetch = async (_url, init) => {
      assert.equal(init?.redirect, "manual"); assert.ok(init?.signal);
      return new Response("x".repeat(1024 * 1024 + 1));
    };
    await assert.rejects(davClient("fictional", "fixture", fetcher)("GET", selection.calendarUrl), /read bound/);
  });
});

describe("MCP controls and owner settings", () => {
  const keys = ["MACOS_MCP_READONLY", "MACOS_MCP_CONFIRM_DESTRUCTIVE", "MACOS_MCP_CALENDARS", "MACOS_MCP_ALLOWED_RECIPIENTS"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  afterEach(() => { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
  function tools(connect: Parameters<typeof registerInvitationTools>[1]) {
    const registered = new Map<string, { config: any; run: (arg: any) => Promise<any> }>();
    registerInvitationTools({ registerTool(name: string, config: any, run: any) { registered.set(name, { config, run }); } } as unknown as McpServer, connect);
    return registered;
  }
  it("omits send in readonly mode but preserves check/reconcile", () => {
    process.env.MACOS_MCP_READONLY = "true";
    const registered = tools(async () => { throw new Error("must not connect"); });
    assert.equal(registered.has("calendar_send_invitation"), false);
    assert.equal(registered.has("calendar_get_invitation"), true);
    assert.equal(registered.has("calendar_invitation_check"), true);
  });
  it("requires configured confirmation before credentials or transport access", async () => {
    delete process.env.MACOS_MCP_READONLY;
    process.env.MACOS_MCP_CONFIRM_DESTRUCTIVE = "true";
    let connections = 0;
    const registered = tools(async () => { connections++; throw new Error("secret fixture must not surface"); });
    const send = registered.get("calendar_send_invitation")!;
    assert.ok((await send.run({ ...item, confirm: false })).structuredContent.warning);
    assert.equal(connections, 0);
    const failed = await send.run({ ...item, confirm: true });
    assert.equal(connections, 1); assert.ok(!JSON.stringify(failed).includes("secret fixture"));
  });
  it("rechecks read-only at execution and honors calendar/recipient restrictions", async () => {
    delete process.env.MACOS_MCP_READONLY;
    const registered = tools(async () => { throw new Error("must not connect"); });
    process.env.MACOS_MCP_READONLY = "1";
    assert.equal((await registered.get("calendar_send_invitation")!.run({ ...item, confirm: true })).isError, true);
    delete process.env.MACOS_MCP_READONLY;
    process.env.MACOS_MCP_CALENDARS = "Different";
    assert.throws(() => validateInvitation(item, selection), /MACOS_MCP_CALENDARS/);
    process.env.MACOS_MCP_CALENDARS = selection.calendar;
    process.env.MACOS_MCP_ALLOWED_RECIPIENTS = "*@example.net";
    assert.throws(() => validateInvitation(item, selection), /MACOS_MCP_ALLOWED_RECIPIENTS/);
  });
  it("writes private nonsecret settings, refuses replacement and rejects insecure settings", async () => {
    const local = await store();
    const settings = { ...selection, credentialId: item.operationId };
    await saveSettings(settings, local.directory);
    assert.deepEqual(await readSettings(local.directory), settings);
    assert.equal((await stat(join(local.directory, "calendar.json"))).mode & 0o777, 0o600);
    await assert.rejects(saveSettings(settings, local.directory));
    await chmod(join(local.directory, "calendar.json"), 0o644);
    await assert.rejects(readSettings(local.directory), /not configured correctly/);
  });
});


describe("MCP wire contract", () => {
  it("advertises, validates and executes invitation tools through the real SDK without real accounts", async () => {
    const server = new McpServer({ name: "invitation-fixture", version: "1" });
    const client = new Client({ name: "fixture-client", version: "1" });
    const remote = new Server(); const local = await store();
    registerInvitationTools(server, async () => ({ settings: { ...selection, credentialId: item.operationId }, request: remote.request, store: local.store }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const list = await client.listTools();
      assert.equal(list.tools.length, 3);
      const sendSchema = list.tools.find(tool => tool.name === "calendar_send_invitation")!.inputSchema;
      assert.ok(sendSchema.required?.includes("operationId"));
      assert.ok(sendSchema.required?.includes("end"));
      const check = await client.callTool({ name: "calendar_invitation_check", arguments: {} });
      assert.equal((check.structuredContent as Record<string, unknown>)?.ready, true);
      assert.ok(!JSON.stringify(check).includes("credentialId"));
      const invalid = await client.callTool({ name: "calendar_send_invitation", arguments: { ...item, unexpected: true } });
      assert.equal(invalid.isError, true); assert.equal(remote.puts.length, 0);
      const sent = await client.callTool({ name: "calendar_send_invitation", arguments: { ...item, confirm: true } });
      assert.equal((sent.structuredContent as Record<string, unknown>)?.state, "stored");
      const read = await client.callTool({ name: "calendar_get_invitation", arguments: item });
      assert.equal((read.structuredContent as Record<string, unknown>)?.state, "stored");
      assert.equal(remote.puts.length, 1);
    } finally { await client.close(); await server.close(); }
  });
});
