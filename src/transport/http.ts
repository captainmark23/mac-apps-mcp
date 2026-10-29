/**
 * Streamable HTTP transport with OAuth, for use as a remote connector.
 *
 * Binds to 127.0.0.1 only; a tunnel such as Tailscale Funnel is the only
 * public path. Stateless: each POST /mcp gets a fresh server and transport and
 * a JSON response, so there are no sessions to track or expire.
 *
 * Routes: /mcp (bearer token required), /healthz, /login, and the OAuth
 * endpoints and metadata from the SDK's mcpAuthRouter. /token and /revoke
 * need the client secret; with a Tailscale login set, /authorize and /login
 * answer only that Tailscale user.
 */

import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, createOAuthMetadata, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getHttpPort, getHttpToolsets, getPublicUrl, getMailDbPath, getTailscaleLogin } from "../shared/config.js";
import { createServer, SERVER_VERSION } from "../server.js";
import { type ClientCredentials, readClient } from "./client.js";
import { ConnectorAuth } from "./oauth.js";
import { readPasswordHash } from "./password.js";

const STATE_DIR = join(homedir(), ".macos-mcp");

type RequestHandler = (req: { params: { name?: string; arguments?: unknown } }, extra: { authInfo?: { clientId?: string } }) => Promise<unknown>;

// ─── Tool filtering and audit ───────────────────────────────────

/** Module a tool belongs to, for MACOS_MCP_HTTP_TOOLSETS. */
export function toolModule(name: string): string {
  return name === "daily_briefing" ? "briefing" : name.split("_")[0];
}

/**
 * Remove tools the toolsets do not allow. Uses the SDK's private
 * `_registeredTools` map (stable across SDK 1.x), the same price paid by
 * normalizeToolSchemaDialect.
 */
export function applyToolsets(server: McpServer, toolsets: Map<string, "all" | "read"> | null): void {
  if (!toolsets) return;
  const tools = (server as unknown as {
    _registeredTools: Record<string, { annotations?: { readOnlyHint?: boolean }; remove(): void }>;
  })._registeredTools;
  for (const [name, tool] of Object.entries(tools)) {
    const mode = toolsets.get(toolModule(name));
    if (!mode || (mode === "read" && tool.annotations?.readOnlyHint !== true)) tool.remove();
  }
}

/**
 * Append one line per tool call: time, OAuth client, tool, and a hash of the
 * arguments. Never the arguments themselves, which can hold message text.
 */
export function auditToolCalls(server: McpServer, auditFile: string): void {
  const handlers = (server.server as unknown as { _requestHandlers: Map<string, RequestHandler> })._requestHandlers;
  const original = handlers.get("tools/call");
  if (!original) return;
  handlers.set("tools/call", async (req, extra) => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      client: extra.authInfo?.clientId ?? "",
      tool: req.params.name ?? "",
      args_sha256: createHash("sha256").update(JSON.stringify(req.params.arguments ?? {})).digest("hex"),
    });
    appendFileSync(auditFile, `${line}\n`, { mode: 0o600 });
    return original(req, extra);
  });
}

// ─── Health ─────────────────────────────────────────────────────

/** True if this process can open the file; a Full Disk Access loss shows up here. */
function canOpen(path: () => string): boolean {
  try {
    closeSync(openSync(path(), "r"));
    return true;
  } catch {
    return false;
  }
}

// ─── Owner-only sign-in ─────────────────────────────────────────

/**
 * Tailscale Serve adds Tailscale-User-Login to requests from tailnet users,
 * never to Funnel traffic, and strips any copy a client sends. So when the
 * header names the owner, the request came from the owner's own device. Only
 * a process on this Mac could forge it, by calling 127.0.0.1 directly.
 */
function ownerOnly(login: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.get("tailscale-user-login")?.trim().toLowerCase() === login) {
      next();
      return;
    }
    res.status(403).set("Cache-Control", "no-store").type("text/plain")
      .send("Sign in from one of your own devices, connected to Tailscale.");
  };
}

// ─── App ────────────────────────────────────────────────────────

export interface HttpAppOptions {
  publicUrl: URL;
  passwordHash: string;
  client: ClientCredentials;
  /** Lower-case Tailscale login allowed to sign in; null leaves sign-in open to anyone with the URL. */
  tailscaleLogin: string | null;
  stateFile: string;
  auditFile: string;
  toolsets: Map<string, "all" | "read"> | null;
  /** Builds the MCP server for each request (tests pass a small one). */
  serverFactory?: () => McpServer;
  log?: (message: string) => void;
}

export function createHttpApp(opts: HttpAppOptions): Express {
  const resource = new URL("/mcp", opts.publicUrl);
  const auth = new ConnectorAuth({
    stateFile: opts.stateFile, passwordHash: opts.passwordHash, client: opts.client, resource, log: opts.log,
  });
  const factory = opts.serverFactory ?? (() => createServer({ resources: false }));
  const startedAt = Date.now();

  mkdirSync(dirname(opts.auditFile), { recursive: true });
  if (existsSync(opts.auditFile)) chmodSync(opts.auditFile, 0o600);

  const app = express();
  app.disable("x-powered-by");
  // The tunnel connects from loopback; trust its X-Forwarded-For for rate limits.
  app.set("trust proxy", "loopback");

  // Full detail only for direct local checks; the tunnel always adds X-Forwarded-For.
  app.get("/healthz", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.get("x-forwarded-for") !== undefined) {
      res.json({ status: "ok" });
      return;
    }
    res.json({
      status: "ok",
      version: SERVER_VERSION,
      transport: "http",
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      readable: {
        messages: canOpen(() => join(homedir(), "Library/Messages/chat.db")),
        mail: canOpen(getMailDbPath),
      },
    });
  });

  // Everything else answers only the public host, so a web page that rebinds
  // its own hostname to 127.0.0.1 cannot reach the sign-in page or tokens.
  // Tailscale Serve and Funnel pass the Host header through unchanged.
  const publicHost = opts.publicUrl.host;
  app.use((req, res, next) => {
    if (req.get("host")?.toLowerCase() === publicHost) {
      next();
      return;
    }
    res.status(421).set("Cache-Control", "no-store").type("text/plain").send("Unknown host.");
  });

  const authOptions = {
    provider: auth,
    issuerUrl: opts.publicUrl,
    resourceServerUrl: resource,
    scopesSupported: ["mcp"],
    resourceName: "mac-apps-mcp",
  };
  // The SDK advertises client_secret_post and "none"; this server takes a
  // secret only, in either standard form. Mounted first, so it wins.
  app.use("/.well-known/oauth-authorization-server", metadataHandler({
    ...createOAuthMetadata(authOptions),
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    revocation_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
  }));
  // app.use, not app.post: it matches the same paths the SDK's router.use
  // does, including /token// and /Token, so no variant skips the secret.
  if (opts.tailscaleLogin) app.use(["/authorize", "/login"], ownerOnly(opts.tailscaleLogin));
  app.use(["/token", "/revoke"], express.urlencoded({ extended: false, limit: "10kb" }), auth.authenticateClient);
  app.use(mcpAuthRouter(authOptions));
  app.post("/login", express.urlencoded({ extended: false, limit: "10kb" }), auth.handleLogin);

  const bearer = requireBearerAuth({
    verifier: auth,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
  });

  app.post("/mcp", bearer, express.json({ limit: "4mb" }), async (req, res) => {
    const server = factory();
    applyToolsets(server, opts.toolsets);
    auditToolCalls(server, opts.auditFile);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      opts.log?.(`HTTP /mcp error: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  // Stateless: no server-initiated stream and no sessions to delete.
  app.all("/mcp", bearer, (_req, res) => {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  });

  // Body-parser and other errors: a short JSON reply, never Express's default
  // HTML stack trace, and nothing logged, so bad requests cannot fill the disk.
  app.use((err: { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    res.status(status).json({ error: status < 500 ? "invalid_request" : "server_error" });
  });

  return app;
}

/** Start the connector from environment configuration. Fails closed without a password. */
export async function startHttp(log: (message: string) => void): Promise<void> {
  const passwordHash = readPasswordHash();
  if (!passwordHash) {
    throw new Error("No connector password set. Run `npm run set-password` first.");
  }
  const client = readClient();
  if (!client) {
    throw new Error("No OAuth client set. Run `npm run new-client` first.");
  }
  const tailscaleLogin = getTailscaleLogin();
  if (!tailscaleLogin) {
    log("MACOS_MCP_TAILSCALE_LOGIN is not set, so anyone with the URL can reach the sign-in page. Set it if you use Tailscale.");
  }
  const publicUrl = getPublicUrl();
  const port = getHttpPort();
  const toolsets = getHttpToolsets();
  const app = createHttpApp({
    publicUrl,
    passwordHash,
    client,
    tailscaleLogin,
    stateFile: join(STATE_DIR, "auth.json"),
    auditFile: join(STATE_DIR, "audit.log"),
    toolsets,
    log,
  });
  await new Promise<void>((resolve, reject) => {
    const listener = app.listen(port, "127.0.0.1", () => resolve());
    listener.on("error", reject);
  });
  log(`HTTP connector listening on 127.0.0.1:${port} for ${publicUrl.origin}/mcp` +
    (toolsets ? ` (toolsets: ${[...toolsets].map(([m, mode]) => mode === "read" ? `${m}:read` : m).join(",")})` : ""));
}
