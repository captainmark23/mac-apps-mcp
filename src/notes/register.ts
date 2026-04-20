/**
 * Notes tool and resource registrations for the MCP server.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, err, paginatedOutput, SuccessZ, resource } from "../shared/mcp-helpers.js";
import { isReadOnly } from "../shared/config.js";
import { sanitizeErrorMessage } from "../shared/types.js";
import * as notes from "./tools.js";

// ─── Output Schemas ─────────────────────────────────────────────

export const NoteSummaryZ = z.object({
  identifier: z.string(),
  title: z.string(),
  snippet: z.string(),
  creationDate: z.string(),
  modificationDate: z.string(),
  folder: z.string(),
  account: z.string(),
  isPinned: z.boolean(),
  isLocked: z.boolean(),
  hasChecklist: z.boolean(),
});

const NoteFullZ = NoteSummaryZ.extend({
  body: z.string(),
  bodyFormat: z.enum(["plaintext", "html"]),
  attachmentCount: z.number(),
  shared: z.boolean(),
});

// ─── Tool Registrations ─────────────────────────────────────────

export function registerNotesTools(server: McpServer): void {
  server.registerTool("notes_list", {
    title: "List Notes",
    description: "List notes with filtering by folder, account, pinned status, or date. Returns title, snippet, and metadata (not full body). Use when: browsing notes, checking recent activity",
    inputSchema: z.object({
      folder: z.string().max(200, "Name too long").optional().describe("Filter by folder name"),
      account: z.string().max(200, "Name too long").optional().describe("Filter by account name (e.g. 'iCloud', 'Exchange')"),
      filter: z.enum(["all", "pinned", "with_checklist", "today", "this_week"]).default("all").describe("Filter: all (default), pinned, with_checklist, today, this_week"),
      sort: z.enum(["modified", "created", "title"]).default("modified").describe("Sort order"),
      limit: z.number().min(1).max(100).default(25).describe("Max notes to return"),
      offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
      response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
    }).strict(),
    outputSchema: paginatedOutput(NoteSummaryZ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ folder, account, filter, sort, limit, offset, response_format }) => {
    try {
      const result = await notes.listNotes(folder, account, filter, sort, limit, offset);
      return ok(result, true, response_format);
    } catch (e) { return err(e); }
  });

  server.registerTool("notes_get", {
    title: "Get Note",
    description: "Get a single note with full body content. Returns plaintext by default; use format='html' for rich text. Password-protected notes return metadata only. Use when: reading a specific note's content",
    inputSchema: z.object({
      identifier: z.string().max(500).describe("Note identifier (UUID from notes_list or notes_search)"),
      format: z.enum(["plaintext", "html"]).default("plaintext").describe("Body format: 'plaintext' (default) or 'html'"),
      response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
    }).strict(),
    outputSchema: NoteFullZ.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ identifier, format, response_format }) => {
    try {
      const result = await notes.getNote(identifier, format);
      return ok(result, true, response_format);
    } catch (e) { return err(e); }
  });

  server.registerTool("notes_search", {
    title: "Search Notes",
    description: "Search notes by title and/or snippet content. Does not search full body text (use notes_get for that). Use when: finding notes by keyword, looking up a specific topic",
    inputSchema: z.object({
      query: z.string().min(1).max(500).describe("Search query"),
      scope: z.enum(["title", "snippet", "all"]).default("all").describe("Search scope: title only, snippet only, or all (default)"),
      folder: z.string().max(200, "Name too long").optional().describe("Filter by folder name"),
      limit: z.number().min(1).max(50).default(20).describe("Max results to return"),
      offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
      response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
    }).strict(),
    outputSchema: paginatedOutput(NoteSummaryZ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ query, scope, folder, limit, offset, response_format }) => {
    try {
      const result = await notes.searchNotes(query, scope, folder, limit, offset);
      return ok(result, true, response_format);
    } catch (e) { return err(e); }
  });

  server.registerTool("notes_list_folders", {
    title: "List Note Folders",
    description: "List all note folders with note counts. Use when: discovering available folders, checking folder structure before creating or moving notes",
    inputSchema: z.object({
      account: z.string().max(200, "Name too long").optional().describe("Filter by account name"),
      include_trash: z.boolean().default(false).describe("Include 'Recently Deleted' folder"),
      response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
    }).strict(),
    outputSchema: {
      folders: z.array(z.object({
        name: z.string(),
        identifier: z.string(),
        folderType: z.number(),
        noteCount: z.number(),
        accountName: z.string(),
      })),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ account, include_trash, response_format }) => {
    try {
      const folders = await notes.listFolders(account, include_trash);
      return ok({ folders }, true, response_format);
    } catch (e) { return err(e); }
  });

  // ─── Write Tools (guarded by MACOS_MCP_READONLY) ────────────

  if (!isReadOnly()) {
  server.registerTool("notes_create", {
    title: "Create Note",
    description: "Create a new note in the specified folder. Body is plain text (converted to HTML internally). Use when: saving information, capturing meeting notes, creating a new document",
    inputSchema: z.object({
      title: z.string().min(1).max(500).describe("Note title (becomes the heading)"),
      body: z.string().max(50000).describe("Note body in plain text"),
      folder: z.string().max(200).default("Notes").describe("Target folder name (default: 'Notes')"),
      account: z.string().max(200).optional().describe("Target account name (e.g. 'iCloud')"),
      response_format: z.enum(["json", "markdown"]).default("json").describe("Output format"),
    }).strict(),
    outputSchema: { success: z.boolean(), name: z.string(), identifier: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ title, body, folder, account, response_format }) => {
    try {
      const result = await notes.createNote(title, body, folder, account);
      return ok(result, false, response_format);
    } catch (e) { return err(e); }
  });

  server.registerTool("notes_update", {
    title: "Update Note",
    description: "Update a note's body content. WARNING: This replaces the ENTIRE body — there is no append or patch. Read the note first if you need to preserve existing content. Cannot modify password-protected or trashed notes. Use when: editing an existing note",
    inputSchema: z.object({
      identifier: z.string().max(500).describe("Note identifier (UUID)"),
      body: z.string().max(50000).describe("New body content (replaces entire body)"),
      format: z.enum(["plaintext", "html"]).default("plaintext").describe("Body format: 'plaintext' (auto-converted to HTML) or 'html' (used as-is)"),
      response_format: z.enum(["json", "markdown"]).default("json").describe("Output format"),
    }).strict(),
    outputSchema: { success: z.boolean(), name: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ identifier, body, format, response_format }) => {
    try {
      const result = await notes.updateNote(identifier, body, format);
      return ok(result, false, response_format);
    } catch (e) { return err(e); }
  });

  server.registerTool("notes_delete", {
    title: "Delete Note",
    description: "Move a note to Recently Deleted (not permanent deletion). Use when: removing a note that is no longer needed",
    inputSchema: z.object({
      identifier: z.string().max(500).describe("Note identifier (UUID)"),
      response_format: z.enum(["json", "markdown"]).default("json").describe("Output format"),
    }).strict(),
    outputSchema: SuccessZ,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ identifier, response_format }) => {
    try {
      const result = await notes.deleteNote(identifier);
      return ok(result, false, response_format);
    } catch (e) { return err(e); }
  });

  server.registerTool("notes_move", {
    title: "Move Note",
    description: "Move a note to a different folder. Use when: organizing notes, moving between folders or accounts",
    inputSchema: z.object({
      identifier: z.string().max(500).describe("Note identifier (UUID)"),
      folder: z.string().min(1).max(200).describe("Destination folder name"),
      account: z.string().max(200).optional().describe("Destination account name"),
      response_format: z.enum(["json", "markdown"]).default("json").describe("Output format"),
    }).strict(),
    outputSchema: { success: z.boolean(), folder: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ identifier, folder, account, response_format }) => {
    try {
      const result = await notes.moveNote(identifier, folder, account);
      return ok(result, false, response_format);
    } catch (e) { return err(e); }
  });

  server.registerTool("notes_create_folder", {
    title: "Create Note Folder",
    description: "Create a new folder in Notes. Use when: organizing notes into a new category",
    inputSchema: z.object({
      name: z.string().min(1).max(200).describe("Folder name"),
      account: z.string().max(200).optional().describe("Account name (default: primary account)"),
      response_format: z.enum(["json", "markdown"]).default("json").describe("Output format"),
    }).strict(),
    outputSchema: { success: z.boolean(), name: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ name, account, response_format }) => {
    try {
      const result = await notes.createFolder(name, account);
      return ok(result, false, response_format);
    } catch (e) { return err(e); }
  });
  } // end read-only guard
}

// ─── Resource Registrations ─────────────────────────────────────

export function registerNotesResources(server: McpServer): void {
  server.registerResource(
    "notes_accounts",
    "macos://notes/accounts",
    { description: "List of all Notes accounts" },
    resource("macos://notes/accounts", () => notes.listAccounts())
  );

  server.registerResource(
    "notes_folders",
    new ResourceTemplate("macos://notes/{account}/folders", { list: undefined }),
    { description: "List of folders for a Notes account" },
    async (uri, { account }) => {
      try {
        const acct = typeof account === "string" ? account : String(account);
        const folders = await notes.listFolders(acct);
        return {
          contents: [{
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(folders, null, 2),
          }],
        };
      } catch (e) {
        return {
          contents: [{
            uri: uri.href,
            mimeType: "text/plain",
            text: `Error: ${sanitizeErrorMessage(e instanceof Error ? e.message : String(e))}`,
          }],
        };
      }
    }
  );
}
