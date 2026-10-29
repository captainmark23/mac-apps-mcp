/**
 * Tests for the HTTP connector: password hashing, redirect and toolset rules,
 * and the full OAuth + MCP flow against an in-process server on loopback.
 * Hermetic: a temp directory holds auth state and the audit log, and a small
 * stand-in MCP server replaces the macOS tools.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hashPassword, verifyPassword } from "../transport/password.js";
import { ConnectorAuth } from "../transport/oauth.js";
import { newClient, verifyClientSecret } from "../transport/client.js";
import { applyToolsets, createHttpApp, toolModule } from "../transport/http.js";
import { getHttpToolsets, getPublicUrl, getTransport } from "../shared/config.js";

// ─── Password ────────────────────────────────────────────────────

describe("connector password", () => {
  const stored = hashPassword("correct horse battery");

  it("verifies the right password only", () => {
    assert.match(stored, /^scrypt\$\d+\$\d+\$\d+\$[^$]+\$[^$]+$/);
    assert.equal(verifyPassword("correct horse battery", stored), true);
    assert.equal(verifyPassword("correct horse batterY", stored), false);
    assert.equal(verifyPassword("", stored), false);
  });

  it("salts each hash", () => {
    assert.notEqual(hashPassword("correct horse battery"), stored);
  });

  it("never verifies against a malformed hash", () => {
    for (const bad of ["", "plain", "scrypt$1$2$3", "bcrypt$1$1$1$AA==$AA==", "scrypt$x$8$1$AA==$AA=="]) {
      assert.equal(verifyPassword("anything", bad), false, bad);
    }
  });
});

// ─── Rules ───────────────────────────────────────────────────────

describe("OAuth client secret", () => {
  const { secret, record } = newClient();

  it("verifies the right secret only, against a stored hash", () => {
    assert.match(record.secretSha256, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(record).includes(secret));
    assert.equal(verifyClientSecret(secret, record), true);
    assert.equal(verifyClientSecret(`${secret}x`, record), false);
    assert.equal(verifyClientSecret("", record), false);
  });

  it("never verifies against a malformed hash", () => {
    assert.equal(verifyClientSecret(secret, { ...record, secretSha256: "abc" }), false);
  });
});

describe("HTTP configuration", () => {
  function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    try {
      for (const [k, v] of Object.entries(vars)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("defaults to stdio", () => {
    withEnv({ MACOS_MCP_TRANSPORT: undefined }, () => assert.equal(getTransport(), "stdio"));
    withEnv({ MACOS_MCP_TRANSPORT: "HTTP" }, () => assert.equal(getTransport(), "http"));
  });

  it("parses toolsets with an optional :read suffix", () => {
    withEnv({ MACOS_MCP_HTTP_TOOLSETS: undefined }, () => assert.equal(getHttpToolsets(), null));
    withEnv({ MACOS_MCP_HTTP_TOOLSETS: " mail:read, Messages ,briefing" }, () =>
      assert.deepEqual([...getHttpToolsets()!], [["mail", "read"], ["messages", "all"], ["briefing", "all"]]));
    withEnv({ MACOS_MCP_HTTP_TOOLSETS: "mail:write" }, () => assert.throws(() => getHttpToolsets()));
  });

  it("requires the public URL to be a bare origin", () => {
    withEnv({ MACOS_MCP_PUBLIC_URL: undefined }, () => assert.throws(() => getPublicUrl()));
    withEnv({ MACOS_MCP_PUBLIC_URL: "https://host.example.ts.net:8443" }, () =>
      assert.equal(getPublicUrl().origin, "https://host.example.ts.net:8443"));
    withEnv({ MACOS_MCP_PUBLIC_URL: "https://host.example.ts.net/mcp" }, () => assert.throws(() => getPublicUrl()));
  });
});

/** A stand-in server: one read tool and one write tool per module used below. */
function testServer(): McpServer {
  const server = new McpServer({ name: "test", version: "0" });
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  server.registerTool("mail_echo", { description: "echo", inputSchema: z.object({ text: z.string() }), annotations: read },
    async ({ text }) => ({ content: [{ type: "text" as const, text }] }));
  server.registerTool("mail_send", { description: "send", inputSchema: z.object({}), annotations: write },
    async () => ({ content: [{ type: "text" as const, text: "sent" }] }));
  server.registerTool("messages_unread", { description: "unread", inputSchema: z.object({}), annotations: read },
    async () => ({ content: [{ type: "text" as const, text: "none" }] }));
  server.registerTool("daily_briefing", { description: "briefing", inputSchema: z.object({}), annotations: read },
    async () => ({ content: [{ type: "text" as const, text: "brief" }] }));
  return server;
}

function toolNames(server: McpServer): string[] {
  return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
}

describe("toolsets", () => {
  it("maps tools to modules", () => {
    assert.equal(toolModule("mail_fts_index"), "mail");
    assert.equal(toolModule("messages_send"), "messages");
    assert.equal(toolModule("daily_briefing"), "briefing");
  });

  it("keeps everything when unset", () => {
    const server = testServer();
    applyToolsets(server, null);
    assert.deepEqual(toolNames(server), ["daily_briefing", "mail_echo", "mail_send", "messages_unread"]);
  });

  it("drops unlisted modules and write tools under :read", () => {
    const server = testServer();
    applyToolsets(server, new Map([["mail", "read"], ["briefing", "all"]]));
    assert.deepEqual(toolNames(server), ["daily_briefing", "mail_echo"]);
  });
});

// ─── End-to-end OAuth + MCP ─────────────────────────────────────

const PASSWORD = "a long test password";
const HOSTED = "https://claude.ai/api/mcp/auth_callback";

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

const OWNER = "owner@example.com";

describe("HTTP connector (loopback)", () => {
  let dir: string;
  let base: string;
  let listener: Server;
  let accessToken: string;
  let refreshToken: string;
  const { secret: clientSecret, record: client } = newClient();
  const clientId = client.clientId;

  const form = (body: Record<string, string>) => new URLSearchParams(body).toString();
  const formHeaders = { "Content-Type": "application/x-www-form-urlencoded" };
  const owner = { "Tailscale-User-Login": OWNER };
  const basic = (id: string, secret: string) =>
    `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;

  function authorizeUrl(overrides: Record<string, string> = {}): URL {
    const url = new URL("/authorize", base);
    url.search = new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: HOSTED,
      code_challenge: pkce().challenge, code_challenge_method: "S256", state: "s1", scope: "mcp",
      resource: `${base}/mcp`, ...overrides,
    }).toString();
    return url;
  }

  async function startAuthorization(): Promise<{ requestId: string; verifier: string }> {
    const { verifier, challenge } = pkce();
    const res = await fetch(authorizeUrl({ code_challenge: challenge }), { headers: owner });
    assert.equal(res.status, 200);
    const html = await res.text();
    const requestId = /name="request" value="([^"]+)"/.exec(html)?.[1];
    assert.ok(requestId, "login form carries a request id");
    assert.match(html, /claude\.ai/);
    return { requestId: requestId!, verifier };
  }

  const login = (requestId: string, password: string, headers: Record<string, string> = owner) =>
    fetch(`${base}/login`, {
      method: "POST", headers: { ...formHeaders, ...headers }, body: form({ request: requestId, password }), redirect: "manual",
    });

  const token = (body: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${base}/token`, { method: "POST", headers: { ...formHeaders, ...headers }, body: form(body) });

  const mcp = (accessToken: string | null, body: unknown) => fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "macos-mcp-http-"));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const app = createHttpApp({
      publicUrl: new URL(base),
      passwordHash: hashPassword(PASSWORD),
      client,
      tailscaleLogin: OWNER,
      stateFile: join(dir, "auth.json"),
      auditFile: join(dir, "audit.log"),
      toolsets: null,
      serverFactory: testServer,
    });
    await new Promise<void>((resolve) => { listener = app.listen(port, "127.0.0.1", () => resolve()); });
  });

  after(async () => {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports health without data", async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.status, "ok");
    assert.equal(body.transport, "http");
    assert.deepEqual(Object.keys(body).sort(), ["readable", "status", "transport", "uptimeSec", "version"]);
    assert.deepEqual(Object.keys(body.readable as object).sort(), ["mail", "messages"]);

    const viaTunnel = await fetch(`${base}/healthz`, { headers: { "X-Forwarded-For": "203.0.113.9" } });
    assert.deepEqual(await viaTunnel.json(), { status: "ok" });
  });

  it("answers only its public host, so DNS rebinding cannot reach sign-in", async () => {
    const statusFor = (host: string) => new Promise<number>((resolve, reject) => {
      const { port } = new URL(base);
      httpRequest({ host: "127.0.0.1", port, path: authorizeUrl().pathname + authorizeUrl().search, headers: { Host: host, ...owner } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on("error", reject).end();
    });
    assert.equal(await statusFor("rebound.example:8443"), 421);
    assert.equal(await statusFor(new URL(base).host), 200);
  });

  it("answers an unauthenticated call with 401 and a resource_metadata pointer", async () => {
    const res = await mcp(null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "",
      new RegExp(`resource_metadata="${base}/\\.well-known/oauth-protected-resource/mcp"`));
  });

  it("serves metadata that offers no registration and requires a client secret", async () => {
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json() as Record<string, unknown>;
    assert.equal(prm.resource, `${base}/mcp`);
    assert.deepEqual(prm.authorization_servers, [`${base}/`]);
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>;
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
    assert.equal(as.registration_endpoint, undefined);
    assert.deepEqual(as.token_endpoint_auth_methods_supported, ["client_secret_basic", "client_secret_post"]);
  });

  it("has no registration endpoint", async () => {
    const res = await fetch(`${base}/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [HOSTED], token_endpoint_auth_method: "none" }),
    });
    assert.equal(res.status, 404);
  });

  it("shows the sign-in page only to the owner's Tailscale login", async () => {
    assert.equal((await fetch(authorizeUrl())).status, 403);
    assert.equal((await fetch(authorizeUrl(), { headers: { "Tailscale-User-Login": "someone@example.com" } })).status, 403);
    assert.equal((await fetch(authorizeUrl(), { headers: { "Tailscale-User-Login": "Owner@Example.com" } })).status, 200);

    const { requestId } = await startAuthorization();
    const refused = await login(requestId, PASSWORD, {});
    assert.equal(refused.status, 403);
    assert.equal(refused.headers.get("location"), null);
  });

  it("refuses an unknown client or a redirect outside Claude's callbacks", async () => {
    assert.equal((await fetch(authorizeUrl({ client_id: "someone-else" }), { headers: owner })).status, 400);
    assert.equal((await fetch(authorizeUrl({ redirect_uri: "https://evil.example/api/mcp/auth_callback" }), { headers: owner })).status, 400);
    assert.equal((await fetch(authorizeUrl({ redirect_uri: "http://localhost:3118/callback" }), { headers: owner })).status, 200);
    assert.equal((await fetch(authorizeUrl({ redirect_uri: "http://localhost:3118/other" }), { headers: owner })).status, 400);
  });

  it("issues a code for the right password, exchanged only with the secret and only once", async () => {
    const { requestId, verifier } = await startAuthorization();
    assert.equal((await login(requestId, "wrong password!")).status, 401);

    const ok = await login(requestId, PASSWORD);
    assert.equal(ok.status, 302);
    const location = new URL(ok.headers.get("location")!);
    assert.equal(`${location.origin}${location.pathname}`, HOSTED);
    assert.equal(location.searchParams.get("state"), "s1");
    const code = location.searchParams.get("code")!;

    const exchange = { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: HOSTED, resource: `${base}/mcp` };
    for (const res of [await token(exchange), await token({ ...exchange, client_secret: "wrong" })]) {
      assert.equal(res.status, 401);
      assert.equal(((await res.json()) as { error: string }).error, "invalid_client");
    }

    const res = await token({ ...exchange, client_secret: clientSecret });
    assert.equal(res.status, 200);
    const tokens = await res.json() as { access_token: string; refresh_token: string; expires_in: number; token_type: string };
    assert.equal(tokens.expires_in, 3600);
    assert.equal(tokens.token_type, "Bearer");
    accessToken = tokens.access_token;
    refreshToken = tokens.refresh_token;

    const replay = await token({ ...exchange, client_secret: clientSecret });
    assert.equal(replay.status, 400);
    assert.equal(((await replay.json()) as { error: string }).error, "invalid_grant");
  });

  it("checks the secret on every path variant the SDK would accept", async () => {
    const body = form({ grant_type: "refresh_token", refresh_token: "anything", client_id: clientId });
    for (const path of ["/token/", "/token//", "/Token", "/TOKEN//", "/revoke//"]) {
      const res = await fetch(`${base}${path}`, { method: "POST", headers: formHeaders, body });
      assert.equal(res.status, 401, path);
      assert.equal(((await res.json()) as { error: string }).error, "invalid_client", path);
    }
  });

  it("answers malformed requests with a short JSON error, never a stack trace", async () => {
    const res = await fetch(`${base}/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=foo" }, body: "a=b",
    });
    assert.equal(res.status, 415);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: "invalid_request" });
    assert.ok(!text.includes("node_modules"));
  });

  it("rejects a code exchanged with the wrong PKCE verifier", async () => {
    const { requestId } = await startAuthorization();
    const code = new URL((await login(requestId, PASSWORD)).headers.get("location")!).searchParams.get("code")!;
    const res = await token({ grant_type: "authorization_code", code, code_verifier: pkce().verifier }, { Authorization: basic(clientId, clientSecret) });
    assert.equal(res.status, 400);
  });

  it("serves MCP with the token and audits calls without their arguments", async () => {
    const list = await mcp(accessToken, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(list.status, 200);
    const names = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    assert.ok(names.includes("mail_echo"));

    const call = await mcp(accessToken, {
      jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mail_echo", arguments: { text: "secret body" } },
    });
    assert.equal(call.status, 200);
    assert.equal(((await call.json()) as { result: { content: { text: string }[] } }).result.content[0].text, "secret body");

    const audit = readFileSync(join(dir, "audit.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const entry = audit.find((e) => e.tool === "mail_echo");
    assert.equal(entry.client, clientId);
    assert.match(entry.args_sha256, /^[0-9a-f]{64}$/);
    assert.ok(!readFileSync(join(dir, "audit.log"), "utf8").includes("secret body"));
    assert.equal(statSync(join(dir, "audit.log")).mode & 0o777, 0o600);

    const get = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${accessToken}` } });
    assert.equal(get.status, 405);
  });

  it("rotates refresh tokens with Basic client auth and refuses the old one", async () => {
    const refresh = (t: string) => token({ grant_type: "refresh_token", refresh_token: t }, { Authorization: basic(clientId, clientSecret) });
    assert.equal((await token({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId })).status, 401);
    const res = await refresh(refreshToken);
    assert.equal(res.status, 200);
    const tokens = await res.json() as { access_token: string; refresh_token: string };
    assert.notEqual(tokens.refresh_token, refreshToken);
    assert.equal((await mcp(tokens.access_token, { jsonrpc: "2.0", id: 3, method: "tools/list" })).status, 200);

    const old = await refresh(refreshToken);
    assert.equal(old.status, 400);
    assert.equal(((await old.json()) as { error: string }).error, "invalid_grant");
    refreshToken = tokens.refresh_token;
  });

  it("revokes a token only with the client secret", async () => {
    const revoke = (headers: Record<string, string>) =>
      fetch(`${base}/revoke`, { method: "POST", headers: { ...formHeaders, ...headers }, body: form({ token: refreshToken, client_id: clientId }) });
    assert.equal((await revoke({})).status, 401);
    assert.equal((await revoke({ Authorization: basic(clientId, clientSecret) })).status, 200);
    const res = await token({ grant_type: "refresh_token", refresh_token: refreshToken }, { Authorization: basic(clientId, clientSecret) });
    assert.equal(res.status, 400);
  });

  it("stores only token hashes, in a 0600 file", () => {
    const raw = readFileSync(join(dir, "auth.json"), "utf8");
    assert.ok(!raw.includes(accessToken));
    assert.ok(!raw.includes(refreshToken));
    assert.equal(statSync(join(dir, "auth.json")).mode & 0o777, 0o600);
  });

  it("drops every token when the client is replaced", async () => {
    const reload = (record: typeof client) =>
      new ConnectorAuth({ stateFile: join(dir, "auth.json"), passwordHash: "unused", client: record, resource: new URL(`${base}/mcp`) });
    assert.equal((await reload(client).verifyAccessToken(accessToken)).clientId, clientId);
    await assert.rejects(reload(newClient().record).verifyAccessToken(accessToken), { errorCode: "invalid_token" });
  });

  it("locks sign-in for 15 minutes after 5 wrong passwords", async () => {
    const { requestId } = await startAuthorization();
    for (let i = 1; i <= 4; i++) assert.equal((await login(requestId, `wrong ${i} password`)).status, 401);
    assert.equal((await login(requestId, "wrong 5 password")).status, 429);
    const locked = await login(requestId, PASSWORD);
    assert.equal(locked.status, 429);
    assert.match(await locked.text(), /Try again in 15 minutes/);
  });
});

describe("HTTP connector without a Tailscale login", () => {
  let dir: string;
  let base: string;
  let listener: Server;
  const { record: client } = newClient();

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "macos-mcp-http-open-"));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const app = createHttpApp({
      publicUrl: new URL(base), passwordHash: hashPassword(PASSWORD), client, tailscaleLogin: null,
      stateFile: join(dir, "auth.json"), auditFile: join(dir, "audit.log"), toolsets: null, serverFactory: testServer,
    });
    await new Promise<void>((resolve) => { listener = app.listen(port, "127.0.0.1", () => resolve()); });
  });

  after(async () => {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows the sign-in page to any caller, still for the one client only", async () => {
    const url = new URL("/authorize", base);
    const params = {
      response_type: "code", client_id: client.clientId, redirect_uri: HOSTED,
      code_challenge: pkce().challenge, code_challenge_method: "S256", resource: `${base}/mcp`,
    };
    url.search = new URLSearchParams(params).toString();
    assert.equal((await fetch(url)).status, 200);
    url.search = new URLSearchParams({ ...params, client_id: "someone-else" }).toString();
    assert.equal((await fetch(url)).status, 400);
  });
});
