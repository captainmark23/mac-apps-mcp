/**
 * Contacts tool and resource registrations for the MCP server.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, err, paginatedOutput, resource } from "../shared/mcp-helpers.js";
import * as contacts from "./tools.js";

// ─── Output Schemas ─────────────────────────────────────────────

const ContactSummaryZ = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  organization: z.string(),
  jobTitle: z.string(),
  email: z.string(),
  phone: z.string(),
});

const ContactFullZ = ContactSummaryZ.extend({
  middleName: z.string(),
  nickname: z.string(),
  department: z.string(),
  title: z.string(),
  suffix: z.string(),
  birthday: z.string(),
  emails: z.array(z.object({ address: z.string(), label: z.string() })),
  phones: z.array(z.object({ number: z.string(), label: z.string() })),
  addresses: z.array(z.object({
    street: z.string(),
    city: z.string(),
    state: z.string(),
    zip: z.string(),
    country: z.string(),
    label: z.string(),
  })),
  note: z.string(),
});

// ─── Tool Registrations ─────────────────────────────────────────

export function registerContactsTools(server: McpServer): void {
  server.registerTool("contacts_list", {
    title: "List Contacts",
    description: "Browse contacts alphabetically with pagination. Use when: browsing the address book, listing contacts without a specific search term",
    inputSchema: z.object({
      query: z.string().max(1000, "Query too long").optional().describe("Search term to filter contacts by name or organization"),
      limit: z.number().min(1).max(500).default(50).describe("Max contacts to return"),
      offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
      response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
    }).strict(),
    outputSchema: paginatedOutput(ContactSummaryZ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ query, limit, offset, response_format }) => {
    try {
      const result = await contacts.listContacts(query, limit, offset);
      return ok(result, true, response_format);
    } catch (e) { return err(e); }
  });

  server.registerTool("contacts_get", {
    title: "Get Contact Details",
    description: "Get full details for a specific contact including all emails, phones, addresses, and notes. Use when: viewing complete contact information, getting phone numbers or addresses",
    inputSchema: z.object({
      contactId: z.string().max(500).describe("Contact unique ID (from contacts_list or contacts_search)"),
      response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
    }).strict(),
    outputSchema: ContactFullZ.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ contactId, response_format }) => {
    try {
      const contact = await contacts.getContact(contactId);
      return ok(contact, true, response_format);
    } catch (e) { return err(e); }
  });

  server.registerTool("contacts_search", {
    title: "Search Contacts",
    description: "Search contacts by name, email, phone number, or organization. Use when: finding a specific person's contact details by name or email",
    inputSchema: z.object({
      query: z.string().min(1, "Query must not be empty").max(1000, "Query too long").describe("Search term"),
      scope: z.enum(["all", "name", "email", "phone", "organization"]).default("all").describe("Where to search: all, name, email, phone, organization"),
      limit: z.number().min(1).max(500).default(20).describe("Max results to return"),
      offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
      response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
    }).strict(),
    outputSchema: paginatedOutput(ContactSummaryZ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ query, scope, limit, offset, response_format }) => {
    try {
      const result = await contacts.searchContacts(query, scope, limit, offset);
      return ok(result, true, response_format);
    } catch (e) { return err(e); }
  });
}

// ─── Resource Registrations ─────────────────────────────────────

export function registerContactsResources(server: McpServer): void {
  server.registerResource(
    "contacts_list",
    "macos://contacts",
    { description: "Browsable contacts from macOS Address Book (first 25)" },
    resource("macos://contacts", () => contacts.listContacts(undefined, 25, 0))
  );
}
