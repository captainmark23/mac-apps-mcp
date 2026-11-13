/**
 * Alerts for the HTTP connector, sent to the owner (by iMessage in production).
 *
 * - Sign-in events, raised by ConnectorAuth through notify(): a new sign-in, a
 *   wrong password, a lockout.
 * - The first authenticated call from each new network (IPv4 /24, IPv6 /48).
 *   Networks, not addresses, because Claude calls from a pool of addresses and
 *   an alert per address would be noise. Only calls with a valid token count,
 *   so a stranger with the URL cannot trigger these.
 * - A daily digest of the audit log: calls per tool and the networks they came
 *   from. Nothing is sent for a day with no calls.
 *
 * Alerts never block or fail a request: sends run one at a time in the
 * background, and a failed send or state write is only logged.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const DIGEST_HOUR = 8;
const DIGEST_CHECK_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The network an address belongs to: IPv4 /24 or IPv6 /48. */
export function network(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d+\.\d+\.\d+)\.\d+$/i.exec(ip);
  if (v4) return `${v4[1]}.0/24`;
  const [head, tail] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 3).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/48`;
}

interface AlertState {
  /** Network -> ISO time of its first authenticated call. */
  networks: Record<string, string>;
  /** When the last digest was sent or skipped (ms). */
  lastDigestAt?: number;
}

export interface AlertsOptions {
  /** JSON file for known networks and the last digest time (created 0600). */
  stateFile: string;
  /** The audit log the digest summarises. */
  auditFile: string;
  /** Delivers one alert. */
  send: (text: string) => Promise<unknown>;
  log?: (message: string) => void;
}

export class Alerts {
  private state: AlertState;

  constructor(private readonly opts: AlertsOptions) {
    this.state = this.load();
  }

  private load(): AlertState {
    try {
      if (existsSync(this.opts.stateFile)) {
        const saved = JSON.parse(readFileSync(this.opts.stateFile, "utf8")) as Partial<AlertState>;
        return { networks: saved.networks ?? {}, lastDigestAt: saved.lastDigestAt };
      }
    } catch (e) {
      this.opts.log?.(`Alert state unreadable, starting empty: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { networks: {} };
  }

  /** Persist state. A failure is logged; the in-memory state still stops repeat alerts until restart. */
  private save(): void {
    try {
      const tmp = `${this.opts.stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      renameSync(tmp, this.opts.stateFile);
    } catch (e) {
      this.opts.log?.(`Alert state not saved: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private sendTail: Promise<unknown> = Promise.resolve();

  /** Send one alert in the background, after any alert already being sent. */
  readonly notify = (text: string): void => {
    this.sendTail = this.sendTail
      .then(() => this.opts.send(`mac-apps-mcp: ${text}`))
      .catch((e: unknown) => {
        this.opts.log?.(`Alert not sent (${e instanceof Error ? e.message : String(e)}): ${text}`);
      });
  };

  /** Record an authenticated call; alert if its network is new. */
  seen(ip: string | undefined, now = new Date()): void {
    if (!ip) return;
    const net = network(ip);
    if (this.state.networks[net]) return;
    this.state.networks[net] = now.toISOString();
    this.save();
    this.notify(`First call from a new network: ${net} (${ip}).`);
  }

  /** Send the digest once a day, at the first check after 08:00 local time. */
  digestIfDue(now = new Date()): void {
    const last = this.state.lastDigestAt;
    if (now.getHours() < DIGEST_HOUR) return;
    if (last !== undefined && new Date(last).toDateString() === now.toDateString()) return;
    const text = this.digest(last ?? now.getTime() - DAY_MS, now.getTime());
    this.state.lastDigestAt = now.getTime();
    this.save();
    if (text) this.notify(text);
  }

  /** Summary of audited calls in (since, until], or null if there were none. */
  digest(since: number, until: number): string | null {
    if (!existsSync(this.opts.auditFile)) return null;
    const tools = new Map<string, number>();
    const networks = new Set<string>();
    let total = 0;
    for (const line of readFileSync(this.opts.auditFile, "utf8").split("\n")) {
      if (!line) continue;
      let entry: { ts?: string; tool?: string; ip?: string };
      try { entry = JSON.parse(line); } catch { continue; }
      const ts = Date.parse(entry.ts ?? "");
      if (!(ts > since && ts <= until)) continue;
      total++;
      const tool = entry.tool || "unknown";
      tools.set(tool, (tools.get(tool) ?? 0) + 1);
      if (entry.ip) networks.add(network(entry.ip));
    }
    if (total === 0) return null;
    const byTool = [...tools].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t, n]) => `${t} ${n}`).join(", ");
    const hours = Math.round((until - since) / 3_600_000);
    return `${total} call${total === 1 ? "" : "s"} in the last ${hours} hours. ${byTool}. Networks: ${[...networks].sort().join(", ") || "unknown"}.`;
  }

  /** Check for a due digest now and every 10 minutes. */
  start(): void {
    const check = () => {
      try { this.digestIfDue(); } catch (e) {
        this.opts.log?.(`Digest failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    check();
    setInterval(check, DIGEST_CHECK_MS).unref();
  }
}
