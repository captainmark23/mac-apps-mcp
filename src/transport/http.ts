/**
 * Streamable HTTP transport with OAuth, for use as a remote connector.
 *
 * Binds to 127.0.0.1 only; a tunnel such as Tailscale Funnel is the only
 * public path. Stateless: each POST /mcp gets a fresh server and transport and
 * a JSON response, so there are no sessions to track or expire.
 *
 * Routes: /mcp (bearer token required), /healthz, /login, and the OAuth
 * endpoints and metadata from the SDK's mcpAuthRouter.
 */

import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import express, { type Express } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getHttpPort, getHttpToolsets, getPublicUrl, getMailDbPath } from "../shared/config.js";
import { createServer, SERVER_VERSION } from "../server.js";
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

// ─── App ────────────────────────────────────────────────────────

export interface HttpAppOptions {
  publicUrl: URL;
  passwordHash: string;
  stateFile: string;
  auditFile: string;
  toolsets: Map<string, "all" | "read"> | null;
  /** Builds the MCP server for each request (tests pass a small one). */
  serverFactory?: () => McpServer;
  log?: (message: string) => void;
}

export function createHttpApp(opts: HttpAppOptions): Express {
  const resource = new URL("/mcp", opts.publicUrl);
  const auth = new ConnectorAuth({ stateFile: opts.stateFile, passwordHash: opts.passwordHash, resource, log: opts.log });
  const factory = opts.serverFactory ?? (() => createServer({ resources: false }));
  const startedAt = Date.now();

  mkdirSync(dirname(opts.auditFile), { recursive: true });
  if (existsSync(opts.auditFile)) chmodSync(opts.auditFile, 0o600);

  const app = express();
  app.disable("x-powered-by");
  // The tunnel connects from loopback; trust its X-Forwarded-For for rate limits.
  app.set("trust proxy", "loopback");

  app.get("/healthz", (_req, res) => {
    res.set("Cache-Control", "no-store").json({
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

  app.use(mcpAuthRouter({
    provider: auth,
    issuerUrl: opts.publicUrl,
    resourceServerUrl: resource,
    scopesSupported: ["mcp"],
    resourceName: "mac-apps-mcp",
  }));
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

  return app;
}

/** Start the connector from environment configuration. Fails closed without a password. */
export async function startHttp(log: (message: string) => void): Promise<void> {
  const passwordHash = readPasswordHash();
  if (!passwordHash) {
    throw new Error("No connector password set. Run `npm run set-password` first.");
  }
  const publicUrl = getPublicUrl();
  const port = getHttpPort();
  const toolsets = getHttpToolsets();
  const app = createHttpApp({
    publicUrl,
    passwordHash,
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
