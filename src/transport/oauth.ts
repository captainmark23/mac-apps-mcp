/**
 * Single-user OAuth 2.1 authorization server for the HTTP connector.
 *
 * Implements the SDK's OAuthServerProvider; the SDK's mcpAuthRouter supplies
 * the endpoints, PKCE (S256) checking and rate limits. What lives here:
 * - One fixed OAuth client (see client.ts) whose secret is checked at /token
 *   and /revoke. There is no registration endpoint.
 * - A password page at /authorize, posting to /login, locked for 15 minutes
 *   after 5 failures.
 * - Codes (10 minutes), access tokens (1 hour) and rotating refresh tokens
 *   (30 days), persisted as SHA-256 hashes in a 0600 JSON file so a restart
 *   keeps connections signed in.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { NextFunction, Request, Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { type ClientCredentials, verifyClientSecret } from "./client.js";
import { verifyPassword } from "./password.js";

const CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * Where the client may send sign-in codes: Claude's hosted callback (claude.ai,
 * Desktop, mobile, Cowork; the claude.com form is announced as a future move)
 * and Claude Code's loopback callback, whose port the SDK relaxes at /authorize.
 */
const REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  "http://localhost/callback",
  "http://127.0.0.1/callback",
];

interface StoredGrant {
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

interface StoredCode extends StoredGrant {
  challenge: string;
  redirectUri: string;
}

interface AuthState {
  codes: Record<string, StoredCode>;
  access: Record<string, StoredGrant>;
  refresh: Record<string, StoredGrant>;
}

interface PendingAuthorization {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expiresAt: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export interface ConnectorAuthOptions {
  /** JSON file for code and token hashes (created 0600). */
  stateFile: string;
  /** scrypt hash of the connector password. */
  passwordHash: string;
  /** The protected resource (<public url>/mcp); tokens are bound to it. */
  resource: URL;
  /** The one client allowed to sign in. Replacing it invalidates every token. */
  client: ClientCredentials;
  log?: (message: string) => void;
}

export class ConnectorAuth implements OAuthServerProvider {
  private state: AuthState;
  private readonly client: OAuthClientInformationFull;
  /** Handed to the SDK as the client secret; only authenticateClient supplies it. */
  private readonly sdkSecret = newSecret();
  private readonly pending = new Map<string, PendingAuthorization>();
  private failures = 0;
  private lockedUntil = 0;

  constructor(private readonly opts: ConnectorAuthOptions) {
    this.state = this.load();
    // The SDK compares secrets in plain text from the form body only, so
    // authenticateClient checks the real one first. The SDK gets a per-process
    // secret that only authenticateClient puts in the body: any route that
    // reached the SDK without it fails the SDK's own check.
    this.client = {
      client_id: opts.client.clientId,
      client_secret: this.sdkSecret,
      client_name: "Claude",
      redirect_uris: REDIRECT_URIS,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_basic",
    };
  }

  // ─── Persistence ─────────────────────────────────────────────

  private load(): AuthState {
    if (!existsSync(this.opts.stateFile)) return { codes: {}, access: {}, refresh: {} };
    try {
      const saved = JSON.parse(readFileSync(this.opts.stateFile, "utf8")) as Partial<AuthState>;
      return { codes: saved.codes ?? {}, access: saved.access ?? {}, refresh: saved.refresh ?? {} };
    } catch (e) {
      this.opts.log?.(`Auth state unreadable, starting empty: ${e instanceof Error ? e.message : String(e)}`);
      return { codes: {}, access: {}, refresh: {} };
    }
  }

  private save(): void {
    const now = Date.now();
    for (const table of [this.state.codes, this.state.access, this.state.refresh]) {
      for (const [key, grant] of Object.entries(table)) {
        if (grant.expiresAt <= now) delete table[key];
      }
    }
    mkdirSync(dirname(this.opts.stateFile), { recursive: true });
    const tmp = `${this.opts.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(tmp, this.opts.stateFile);
  }

  // ─── Client ──────────────────────────────────────────────────

  get clientsStore(): OAuthRegisteredClientsStore {
    // No registerClient, so the SDK mounts no /register endpoint.
    return { getClient: async (clientId: string) => (clientId === this.client.client_id ? this.client : undefined) };
  }

  /**
   * Client authentication for /token and /revoke, mounted ahead of the SDK's.
   * Accepts client_secret_basic and client_secret_post and compares hashes in
   * constant time. Anything else gets 401 invalid_client before the SDK runs.
   */
  readonly authenticateClient = (req: Request, res: Response, next: NextFunction): void => {
    let id: string | undefined;
    let secret: string | undefined;
    const header = req.get("authorization") ?? "";
    if (/^basic /i.test(header)) {
      // RFC 6749 2.3.1: both parts are form-urlencoded before base64.
      const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      try {
        if (colon >= 0) {
          id = decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, " "));
          secret = decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, " "));
        }
      } catch { /* malformed: rejected below */ }
    } else if (typeof req.body?.client_id === "string" && typeof req.body?.client_secret === "string") {
      id = req.body.client_id;
      secret = req.body.client_secret;
    }
    if (id !== this.opts.client.clientId || secret === undefined || !verifyClientSecret(secret, this.opts.client)) {
      res.status(401)
        .set("WWW-Authenticate", 'Basic realm="mac-apps-mcp"')
        .set("Cache-Control", "no-store")
        .json({ error: "invalid_client", error_description: "Client authentication failed" });
      return;
    }
    // The SDK reads client_id from the body, so carry it over from Basic auth.
    req.body = { ...(req.body ?? {}), client_id: id, client_secret: this.sdkSecret };
    next();
  };

  // ─── Authorization (password page) ───────────────────────────

  private checkResource(resource?: URL): void {
    if (resource && resource.href !== this.opts.resource.href) {
      throw new InvalidTargetError(`Unknown resource: ${resource.href}`);
    }
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.checkResource(params.resource);
    const requestId = newSecret();
    const now = Date.now();
    for (const [id, p] of this.pending) {
      if (p.expiresAt <= now) this.pending.delete(id);
    }
    this.pending.set(requestId, { client, params, expiresAt: now + PENDING_TTL_MS });
    this.renderLogin(res, 200, requestId);
  }

  private renderLogin(res: Response, status: number, requestId: string, error?: string): void {
    const pending = this.pending.get(requestId);
    const clientName = escapeHtml(pending?.client.client_name || "An MCP client");
    let redirectHost = "";
    try {
      redirectHost = escapeHtml(new URL(pending?.params.redirectUri ?? "").host);
    } catch { /* shown blank */ }
    res.status(status)
      .set("Content-Type", "text/html; charset=utf-8")
      .set("Cache-Control", "no-store")
      .set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
      .set("X-Frame-Options", "DENY")
      .set("Referrer-Policy", "no-referrer")
      .send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to mac-apps-mcp</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;max-width:22rem;margin:4rem auto;padding:0 1rem}
input,button{font:inherit;width:100%;box-sizing:border-box;padding:.6rem;margin:.4rem 0}.err{color:#b00020}</style></head>
<body><h1>mac-apps-mcp</h1>
<p><strong>${clientName}</strong> wants access to Mail, Calendar, Reminders, Contacts, Notes and Messages on this Mac.</p>
<p>After sign-in you return to <strong>${redirectHost}</strong>.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/login">
<input type="hidden" name="request" value="${escapeHtml(requestId)}">
<input type="password" name="password" autocomplete="current-password" placeholder="Password" required autofocus>
<button type="submit">Allow</button>
</form></body></html>`);
  }

  /** POST /login: check the password, then redirect to the client with a code. */
  readonly handleLogin = async (req: Request, res: Response): Promise<void> => {
    const requestId = typeof req.body?.request === "string" ? req.body.request : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const pending = this.pending.get(requestId);
    if (!pending || pending.expiresAt <= Date.now()) {
      this.pending.delete(requestId);
      res.status(400).set("Cache-Control", "no-store").type("text/plain")
        .send("This sign-in has expired. Start again from your MCP client.");
      return;
    }

    const now = Date.now();
    if (now < this.lockedUntil) {
      const minutes = Math.ceil((this.lockedUntil - now) / 60_000);
      this.renderLogin(res, 429, requestId, `Too many failed attempts. Try again in ${minutes} minutes.`);
      return;
    }

    if (!verifyPassword(password, this.opts.passwordHash)) {
      this.failures++;
      this.opts.log?.(`OAuth login failed (${this.failures}/${MAX_FAILURES})`);
      if (this.failures >= MAX_FAILURES) {
        this.failures = 0;
        this.lockedUntil = now + LOCKOUT_MS;
        this.opts.log?.("OAuth login locked for 15 minutes");
        this.renderLogin(res, 429, requestId, "Too many failed attempts. Try again in 15 minutes.");
      } else {
        this.renderLogin(res, 401, requestId, "Wrong password.");
      }
      return;
    }

    this.failures = 0;
    this.pending.delete(requestId);
    const { client, params } = pending;
    const code = newSecret();
    this.state.codes[sha256(code)] = {
      clientId: client.client_id,
      challenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      scopes: params.scopes ?? [],
      resource: params.resource?.href,
      expiresAt: now + CODE_TTL_MS,
    };
    this.save();
    this.opts.log?.(`OAuth login succeeded for client ${client.client_id}`);

    const target = new URL(params.redirectUri);
    target.searchParams.set("code", code);
    if (params.state !== undefined) target.searchParams.set("state", params.state);
    res.redirect(302, target.href);
  };

  // ─── Tokens ──────────────────────────────────────────────────

  private findCode(client: OAuthClientInformationFull, code: string): StoredCode {
    const stored = this.state.codes[sha256(code)];
    if (!stored || stored.clientId !== client.client_id || stored.expiresAt <= Date.now()) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return stored;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.findCode(client, code).challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const stored = this.findCode(client, code);
    if (redirectUri !== undefined && redirectUri !== stored.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    this.checkResource(resource);
    delete this.state.codes[sha256(code)];
    return this.issueTokens(client.client_id, stored.scopes, stored.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const key = sha256(refreshToken);
    const stored = this.state.refresh[key];
    if (!stored || stored.clientId !== client.client_id || stored.expiresAt <= Date.now()) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    if (scopes && scopes.some((s) => !stored.scopes.includes(s))) {
      throw new InvalidScopeError("Requested scope exceeds the original grant");
    }
    this.checkResource(resource);
    // Rotate: the old refresh token dies with this exchange.
    delete this.state.refresh[key];
    return this.issueTokens(client.client_id, scopes ?? stored.scopes, stored.resource);
  }

  private issueTokens(clientId: string, scopes: string[], resource?: string): OAuthTokens {
    const now = Date.now();
    const accessToken = newSecret();
    const refreshToken = newSecret();
    this.state.access[sha256(accessToken)] = { clientId, scopes, resource, expiresAt: now + ACCESS_TTL_MS };
    this.state.refresh[sha256(refreshToken)] = { clientId, scopes, resource, expiresAt: now + REFRESH_TTL_MS };
    this.save();
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_MS / 1000,
      refresh_token: refreshToken,
      ...(scopes.length > 0 ? { scope: scopes.join(" ") } : {}),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = this.state.access[sha256(token)];
    if (!stored || stored.clientId !== this.client.client_id) throw new InvalidTokenError("Invalid access token");
    if (stored.expiresAt <= Date.now()) throw new InvalidTokenError("Access token has expired");
    return {
      token,
      clientId: stored.clientId,
      scopes: stored.scopes,
      expiresAt: Math.floor(stored.expiresAt / 1000),
      ...(stored.resource ? { resource: new URL(stored.resource) } : {}),
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const key = sha256(request.token);
    for (const table of [this.state.access, this.state.refresh]) {
      if (table[key]?.clientId === client.client_id) delete table[key];
    }
    this.save();
  }
}
