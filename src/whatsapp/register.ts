/**
 * WhatsApp tool registrations for the MCP server. All read-only.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, err, paginatedOutput, isoDateString } from "../shared/mcp-helpers.js";
import * as whatsapp from "./tools.js";

// ─── Output Schemas ─────────────────────────────────────────────

const PersonZ = z.object({
  name: z.string().describe("Saved contact name, '~name' for a self-chosen WhatsApp profile name, a phone number, or 'Unknown'"),
  phone: z.string().describe("E.164 number, or '' when WhatsApp holds only a privacy id for this person"),
});

const ChatRefZ = z.object({
  chatId: z.number(),
  name: z.string(),
  isGroup: z.boolean(),
});

const ChatSummaryZ = ChatRefZ.extend({
  phone: z.string(),
  lastMessageDate: z.string(),
  unreadCount: z.number(),
  archived: z.boolean(),
  lastMessage: z.object({
    direction: z.enum(["incoming", "outgoing"]),
    sender: z.string(),
    text: z.string(),
    mediaType: z.string(),
  }).nullable(),
});

const MessageZ = z.object({
  id: z.number(),
  date: z.string().describe("ISO 8601 in this Mac's time zone, with UTC offset"),
  direction: z.enum(["incoming", "outgoing"]),
  sender: PersonZ,
  text: z.string(),
  media: z.object({ type: z.string(), fileName: z.string() }).nullable().describe("Media type and file name only; content is never returned"),
});

const MessageInChatZ = MessageZ.extend({ chat: ChatRefZ });

const historyDate = z.string().describe("Time of the newest message stored on this Mac. If old, WhatsApp is not running or not signed in here");

const responseFormat = z.enum(["json", "markdown"]).default("json").describe("Output format: 'json' for structured data, 'markdown' for human-readable text");

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// ─── Tool Registrations ─────────────────────────────────────────

export function registerWhatsAppTools(server: McpServer): void {
  server.registerTool("whatsapp_list_chats", {
    title: "List WhatsApp Chats",
    description: "Recent WhatsApp chats and groups, newest first, with unread count and last message preview. Read-only. Use when: seeing who has messaged on WhatsApp, finding a chat_id",
    inputSchema: z.object({
      limit: z.number().min(1).max(200).default(20).describe("Max chats to return"),
      offset: z.number().min(0).default(0).describe("Number of chats to skip for pagination"),
      response_format: responseFormat,
    }).strict(),
    outputSchema: { ...paginatedOutput(ChatSummaryZ), history_current_to: historyDate },
    annotations: readOnly,
  }, async ({ limit, offset, response_format }) => {
    try {
      return ok(await whatsapp.listChats(limit, offset), true, response_format);
    } catch (e) { return err(e); }
  });

  server.registerTool("whatsapp_get_chat", {
    title: "Get WhatsApp Chat",
    description: "Messages in one WhatsApp chat or group, newest first, each with its individual sender. Media is reported by type and file name only. Read-only. Use when: reading a WhatsApp conversation",
    inputSchema: z.object({
      chat_id: z.number().optional().describe("chatId from whatsapp_list_chats"),
      chat_name: z.string().max(200).optional().describe("Chat, group or contact name; must match one chat"),
      since: isoDateString.optional().describe("Only messages since this ISO 8601 date"),
      limit: z.number().min(1).max(500).default(50).describe("Max messages to return"),
      offset: z.number().min(0).default(0).describe("Number of messages to skip for pagination"),
      response_format: responseFormat,
    }).strict(),
    outputSchema: { chat: ChatRefZ, ...paginatedOutput(MessageZ) },
    annotations: readOnly,
  }, async ({ chat_id, chat_name, since, limit, offset, response_format }) => {
    try {
      return ok(await whatsapp.getChat({ chatId: chat_id, chatName: chat_name }, limit, offset, since), true, response_format);
    } catch (e) { return err(e); }
  });

  server.registerTool("whatsapp_search", {
    title: "Search WhatsApp",
    description: "Search WhatsApp message text and captions across chats, newest first. Optionally limit to one chat, or to one person by name (their messages in groups and the one-to-one chat with them). Read-only. Use when: finding what someone said on WhatsApp",
    inputSchema: z.object({
      query: z.string().min(1, "Query must not be empty").max(1000, "Query too long").describe("Text to find (case-insensitive for plain letters)"),
      chat_id: z.number().optional().describe("Only this chat (chatId from whatsapp_list_chats)"),
      chat_name: z.string().max(200).optional().describe("Only the chat with this name; must match one chat"),
      contact: z.string().max(200).optional().describe("Only messages from or with people whose name contains this"),
      since: isoDateString.optional().describe("Only messages since this ISO 8601 date"),
      limit: z.number().min(1).max(500).default(20).describe("Max results to return"),
      offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
      response_format: responseFormat,
    }).strict(),
    outputSchema: paginatedOutput(MessageInChatZ),
    annotations: readOnly,
  }, async ({ query, chat_id, chat_name, contact, since, limit, offset, response_format }) => {
    try {
      const result = await whatsapp.searchMessages(query, { chatId: chat_id, chatName: chat_name, contact, since, limit, offset });
      return ok(result, true, response_format);
    } catch (e) { return err(e); }
  });

  server.registerTool("whatsapp_unread", {
    title: "Unread WhatsApp Messages",
    description: "Unread incoming WhatsApp messages across chats and groups, newest first. Channels and Status are excluded. Read-only. Use when: checking for new WhatsApp messages",
    inputSchema: z.object({
      limit: z.number().min(1).max(500).default(50).describe("Max messages to return"),
      offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
      response_format: responseFormat,
    }).strict(),
    outputSchema: { ...paginatedOutput(MessageInChatZ), history_current_to: historyDate },
    annotations: readOnly,
  }, async ({ limit, offset, response_format }) => {
    try {
      return ok(await whatsapp.getUnread(limit, offset), true, response_format);
    } catch (e) { return err(e); }
  });
}
