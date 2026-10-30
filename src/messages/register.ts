/**
 * Messages tool and resource registrations for the MCP server.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, err, paginatedOutput, resource, isoDateString, confirmParam, needsConfirmation } from "../shared/mcp-helpers.js";
import { isReadOnly } from "../shared/config.js";
import * as messages from "./tools.js";

// ─── Output Schemas ─────────────────────────────────────────────

const PersonZ = z.object({ name: z.string(), handle: z.string() });

const ChatRefZ = z.object({
  chatId: z.number(),
  chatIdentifier: z.string(),
  name: z.string(),
  isGroup: z.boolean(),
});

const ChatZ = ChatRefZ.extend({
  service: z.string(),
  participants: z.array(PersonZ),
});

const ChatSummaryZ = ChatZ.extend({
  lastMessageDate: z.string(),
  unreadCount: z.number(),
  lastMessage: z.object({
    direction: z.enum(["incoming", "outgoing"]),
    sender: z.string(),
    text: z.string(),
    attachmentCount: z.number(),
  }).nullable(),
});

const MessageZ = z.object({
  id: z.number(),
  date: z.string(),
  direction: z.enum(["incoming", "outgoing"]),
  sender: PersonZ,
  text: z.string(),
  read: z.boolean(),
  edited: z.boolean(),
  attachments: z.array(z.object({ name: z.string(), mimeType: z.string(), size: z.number() })),
  reactions: z.array(z.object({ reaction: z.string(), from: z.string() })).describe("Tapbacks on this message"),
});

export const MessageInChatZ = MessageZ.extend({ chat: ChatRefZ });

// ─── Tool Registrations ─────────────────────────────────────────

export function registerMessagesTools(server: McpServer): void {
  server.registerTool("messages_list_chats", {
    title: "List Message Chats",
    description: "Recent iMessage/SMS chats, newest first, with participants, unread count and last message preview. Use when: seeing who has texted, finding a chat_identifier",
    inputSchema: z.object({
      limit: z.number().min(1).max(200).default(20).describe("Max chats to return"),
      offset: z.number().min(0).default(0).describe("Number of chats to skip for pagination"),
      since: isoDateString.optional().describe("Only chats active since this ISO 8601 date"),
      response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
    }).strict(),
    outputSchema: paginatedOutput(ChatSummaryZ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ limit, offset, since, response_format }) => {
    try {
      const result = await messages.listChats(limit, offset, since);
      return ok(result, true, response_format);
    } catch (e) { return err(e); }
  });

  server.registerTool("messages_get_chat", {
    title: "Get Message Chat",
    description: "Messages in one chat, oldest first, with tapbacks folded into the message they react to. Returns the newest `limit` messages; page back with before_id = next_before_id. Use when: reading a conversation",
    inputSchema: z.object({
      chat_identifier: z.string().max(500).optional().describe("Phone, email or group id from messages_list_chats"),
      chat_id: z.number().optional().describe("chatId from messages_list_chats"),
      limit: z.number().min(1).max(500).default(50).describe("Max messages to return"),
      before: isoDateString.optional().describe("Only messages before this ISO 8601 date"),
      after: isoDateString.optional().describe("Only messages after this ISO 8601 date"),
      before_id: z.number().optional().describe("Only messages older than this message id (next_before_id from the previous page)"),
      response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
    }).strict(),
    outputSchema: {
      chat: ChatZ,
      count: z.number(),
      has_more: z.boolean(),
      next_before_id: z.number().optional(),
      messages: z.array(MessageZ),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ chat_identifier, chat_id, limit, before, after, before_id, response_format }) => {
    try {
      const result = await messages.getChat({ chatIdentifier: chat_identifier, chatId: chat_id }, limit, before, after, before_id);
      return ok(result, true, response_format);
    } catch (e) { return err(e); }
  });

  server.registerTool("messages_unread", {
    title: "Unread Messages",
    description: "Unread incoming texts across all chats, newest first. Junk is excluded. Use when: checking for new texts",
    inputSchema: z.object({
      limit: z.number().min(1).max(500).default(50).describe("Max messages to return"),
      offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
      response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
    }).strict(),
    outputSchema: paginatedOutput(MessageInChatZ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ limit, offset, response_format }) => {
    try {
      const result = await messages.getUnread(limit, offset);
      return ok(result, true, response_format);
    } catch (e) { return err(e); }
  });

  server.registerTool("messages_search", {
    title: "Search Messages",
    description: "Search text messages by content, newest first. Optionally limit to one person by handle or contact name. Use when: finding what someone texted",
    inputSchema: z.object({
      query: z.string().min(1, "Query must not be empty").max(1000, "Query too long").describe("Text to find (case-insensitive for plain letters)"),
      handle: z.string().max(200).optional().describe("Only messages with this phone number or email"),
      contact: z.string().max(200).optional().describe("Only messages with contacts whose name contains this"),
      since: isoDateString.optional().describe("Only messages since this ISO 8601 date"),
      limit: z.number().min(1).max(500).default(20).describe("Max results to return"),
      offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
      response_format: z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text"),
    }).strict(),
    outputSchema: paginatedOutput(MessageInChatZ),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ query, handle, contact, since, limit, offset, response_format }) => {
    try {
      const result = await messages.searchMessages(query, { handle, contact, since, limit, offset });
      return ok(result, true, response_format);
    } catch (e) { return err(e); }
  });

  if (!isReadOnly()) {
  server.registerTool("messages_send", {
    title: "Send Text Message",
    description: "Send an iMessage (or SMS where that chat already uses SMS) to a phone number or email, or to an existing chat by chat_identifier (needed for groups). A recipient with no existing chat and no contact needs confirm: true. Use when: texting someone",
    inputSchema: z.object({
      text: z.string().min(1, "Message must not be empty").max(10000).describe("Message text"),
      to: z.string().max(200).optional().describe("Phone number (E.164 preferred) or email"),
      chat_identifier: z.string().max(500).optional().describe("Existing chat from messages_list_chats"),
      confirm: confirmParam,
    }).strict(),
    outputSchema: {
      success: z.boolean().optional(),
      message: z.string().optional(),
      chatIdentifier: z.string().optional(),
      via: z.enum(["chat", "iMessage", "SMS"]).optional(),
      service: z.string().optional(),
      status: z.enum(["sent", "delivered", "pending", "failed", "unknown"]).optional(),
      warning: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ text, to, chat_identifier, confirm }) => {
    try {
      const guard = needsConfirmation(confirm, "messages_send", `This will text ${to ?? chat_identifier}.`);
      if (guard) return guard;
      const result = await messages.sendMessage(text, { to, chatIdentifier: chat_identifier }, confirm);
      return ok(result, false);
    } catch (e) { return err(e); }
  });
  } // end read-only guard
}

// ─── Resource Registrations ─────────────────────────────────────

export function registerMessagesResources(server: McpServer): void {
  server.registerResource(
    "messages_chats",
    "macos://messages/chats",
    { description: "Recent iMessage/SMS chats (first 20)" },
    resource("macos://messages/chats", () => messages.listChats(20, 0))
  );
}
