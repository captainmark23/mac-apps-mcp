/** iCloud CalDAV scheduling, adapted from Casamia PR #587; no household policy. */
import { DOMParser, type Element } from "@xmldom/xmldom";

export class InvitationRefused extends Error {}
export interface DavResponse { status: number; headers: Headers; body: string }
export type DavRequest = (method: string, url: string, body?: string, headers?: Record<string, string>) => Promise<DavResponse>;
export interface CalendarSelection { calendar: string; calendarUrl: string; organizer: string }
export const DAV = "DAV:";
export const CAL = "urn:ietf:params:xml:ns:caldav";
const MAX_BODY = 1024 * 1024;

export function icloudUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash ||
      !/^(?:caldav|p\d+-caldav)\.icloud\.com$/.test(url.hostname)) {
    throw new InvitationRefused("Only HTTPS iCloud CalDAV endpoints are supported.");
  }
  return url.href;
}

export function davClient(username: string, password: string, fetcher: typeof fetch = fetch): DavRequest {
  return async (method, url, body, headers = {}) => {
    icloudUrl(url);
    const response = await fetcher(url, {
      method, body, redirect: "manual", signal: AbortSignal.timeout(15_000),
      headers: { ...headers, Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` },
    });
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_BODY) throw new InvitationRefused("Calendar response exceeds the read bound.");
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
    }
    return { status: response.status, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") };
  };
}

export function children(parent: Element, ns: string, name: string): Element[] {
  return Array.from(parent.childNodes).filter((node): node is Element =>
    node.nodeType === 1 && (node as Element).namespaceURI === ns && (node as Element).localName === name);
}
function one(parent: Element, ns: string, name: string): Element {
  const values = children(parent, ns, name);
  if (values.length !== 1) throw new InvitationRefused("Calendar properties are missing or ambiguous.");
  return values[0];
}
export function href(prop: Element, ns: string, name: string, base: string): string {
  const value = one(one(prop, ns, name), DAV, "href").textContent;
  if (!value) throw new InvitationRefused("Calendar property has no URL.");
  return icloudUrl(new URL(value, base).href);
}
export function has(parent: Element, ns: string, name: string): boolean {
  return children(parent, ns, name).length > 0;
}

export async function properties(request: DavRequest, startUrl: string, names: string[], depth = "0", discovery = false) {
  let url = icloudUrl(startUrl);
  const body = '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop>' +
    names.map(name => `<${name}/>`).join("") + "</D:prop></D:propfind>";
  for (let redirects = 0; redirects < 4; redirects++) {
    const response = await request("PROPFIND", url, body, { Depth: depth, "Content-Type": "application/xml" });
    if (discovery && [301, 302, 307, 308].includes(response.status) && response.headers.get("Location")) {
      url = icloudUrl(new URL(response.headers.get("Location")!, url).href);
      continue;
    }
    if (response.status !== 207 || /<!DOCTYPE|<!ENTITY/i.test(response.body) || Buffer.byteLength(response.body) > MAX_BODY) {
      throw new InvitationRefused("Calendar account properties could not be verified.");
    }
    const doc = new DOMParser({ onError: () => { throw new InvitationRefused("Malformed calendar properties."); } })
      .parseFromString(response.body, "application/xml");
    const root = doc.documentElement;
    if (!root || root.namespaceURI !== DAV || root.localName !== "multistatus") throw new InvitationRefused("Malformed calendar properties.");
    const rows = children(root, DAV, "response").map(row => {
      const resource = icloudUrl(new URL(one(row, DAV, "href").textContent || "", url).href);
      const props = doc.createElement("properties");
      for (const stat of children(row, DAV, "propstat")) {
        if (one(stat, DAV, "status").textContent?.split(/\s+/)[1] !== "200") continue;
        for (const child of Array.from(one(stat, DAV, "prop").childNodes)) props.appendChild(child.cloneNode(true));
      }
      return { url: resource, props };
    });
    return { url, rows };
  }
  throw new InvitationRefused("Calendar discovery exceeded its redirect bound.");
}
async function props(request: DavRequest, url: string, names: string[]) {
  const result = await properties(request, url, names);
  const rows = result.rows.filter(row => row.url === icloudUrl(url));
  if (rows.length !== 1) throw new InvitationRefused("The exact calendar resource was not verified.");
  return rows[0].props;
}

export function mailAddress(uri: string): string {
  if (!/^mailto:/i.test(uri)) throw new InvitationRefused("Expected a mailto calendar address.");
  const value = decodeURIComponent(uri.slice(7));
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(value)) throw new InvitationRefused("Expected a bare email address.");
  return value.toLowerCase();
}
function addresses(properties: Element): string[] {
  return children(one(properties, CAL, "calendar-user-address-set"), DAV, "href")
    .map(node => node.textContent || "").filter(value => /^mailto:/i.test(value)).map(mailAddress);
}
function grants(properties: Element, ns: string, name: string): boolean {
  return children(one(properties, DAV, "current-user-privilege-set"), DAV, "privilege")
    .some(priv => has(priv, DAV, "all") || has(priv, ns, name) ||
      (ns === DAV && has(priv, DAV, "write")) || (ns === CAL && has(priv, CAL, "schedule-send")));
}

/** Reads only: scheduling support, exact collection, ownership, organizer and privileges. */
export async function preflight(request: DavRequest, selection: CalendarSelection): Promise<void> {
  const url = icloudUrl(selection.calendarUrl);
  if (!url.endsWith("/")) throw new InvitationRefused("Select an exact calendar collection ending in '/'.");
  const options = await request("OPTIONS", url);
  if (options.status !== 200 || !options.headers.get("DAV")?.split(",").map(x => x.trim()).includes("calendar-auto-schedule")) throw new InvitationRefused("This calendar does not advertise automatic scheduling.");
  const calendar = await props(request, url, ["D:owner", "D:current-user-principal", "D:resourcetype", "D:current-user-privilege-set", "C:supported-calendar-component-set"]);
  if (!has(one(calendar, DAV, "resourcetype"), CAL, "calendar") ||
      !children(one(calendar, CAL, "supported-calendar-component-set"), CAL, "comp").some(c => c.getAttribute("name") === "VEVENT") ||
      !grants(calendar, DAV, "bind") || !grants(calendar, DAV, "write-content")) throw new InvitationRefused("The selected calendar does not grant event creation.");
  const owner = href(calendar, DAV, "owner", url);
  const principal = href(calendar, DAV, "current-user-principal", url);
  if (owner !== principal || new URL(owner).origin !== new URL(url).origin) throw new InvitationRefused("The authenticated account does not own this calendar.");
  const account = await props(request, owner, ["C:calendar-user-address-set", "C:schedule-outbox-URL"]);
  if (!addresses(account).includes(selection.organizer.toLowerCase())) throw new InvitationRefused("The organizer is not an address of this calendar owner.");
  const outboxUrl = href(account, CAL, "schedule-outbox-URL", owner);
  if (new URL(outboxUrl).origin !== new URL(url).origin ||
      !grants(await props(request, outboxUrl, ["D:current-user-privilege-set"]), CAL, "schedule-send-invite")) throw new InvitationRefused("The account does not grant invitation scheduling.");
}

/** Owner-run discovery; never issues PUT/POST/DELETE. */
export async function discover(request: DavRequest) {
  const root = await properties(request, "https://caldav.icloud.com/", ["D:current-user-principal"], "0", true);
  const rootRow = root.rows.filter(row => row.url === root.url);
  if (rootRow.length !== 1) throw new InvitationRefused("No unique account principal.");
  const principalUrl = href(rootRow[0].props, DAV, "current-user-principal", root.url);
  const principal = await properties(request, principalUrl, ["C:calendar-home-set", "C:calendar-user-address-set"], "0", true);
  const account = principal.rows.filter(row => row.url === principal.url);
  if (account.length !== 1) throw new InvitationRefused("No unique account principal.");
  const home = href(account[0].props, CAL, "calendar-home-set", principal.url);
  const collections = await properties(request, home, ["D:displayname", "D:resourcetype"], "1", true);
  const calendars = collections.rows.filter(row => children(row.props, DAV, "resourcetype").some(type => has(type, CAL, "calendar")))
    .map(row => ({ calendar: children(row.props, DAV, "displayname")[0]?.textContent || "(unnamed)", calendarUrl: row.url }));
  if (!calendars.length) throw new InvitationRefused("No calendars were found.");
  return { organizers: addresses(account[0].props), calendars };
}
