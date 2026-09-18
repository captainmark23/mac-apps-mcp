import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCalendarNames, isReadOnly } from "../shared/config.js";
import { ok, err, confirmParam, needsConfirmation } from "../shared/mcp-helpers.js";
import { InvitationSchema, sendInvitation, reconcileInvitation } from "./invitations.js";
import { InvitationRefused, preflight } from "./invitation-caldav.js";
import { invitationConnection } from "./invitation-settings.js";

// Never surface untrusted HTTP bodies, parser exceptions or credential subprocess errors.
const failure = (error: unknown) => err(error instanceof InvitationRefused ? error : new Error("Invitation operation failed. Preserve the operationId and use calendar_get_invitation to reconcile; do not resend under a new identity."));

export function registerInvitationTools(server: McpServer, connect = invitationConnection): void {
  server.registerTool("calendar_invitation_check", {
    title: "Check Personal Invitation Calendar",
    description: "Read-only preflight of the owner-configured personal iCloud calendar, organizer and scheduling privileges. Returns the exact selection required by invitation tools. No event is sent. Owner must run calendar-invitations --configure locally first.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => {
    try {
      const { settings, request } = await connect();
      const names = getCalendarNames();
      if (names && !names.includes(settings.calendar)) throw new InvitationRefused("Calendar excluded by MACOS_MCP_CALENDARS.");
      await preflight(request, settings);
      return ok({ ready: true, calendar: settings.calendar, calendarUrl: settings.calendarUrl, organizer: settings.organizer, liveDeliveryVerified: false });
    } catch (error) { return failure(error); }
  });
  server.registerTool("calendar_get_invitation", {
    title: "Read Back Personal Invitation",
    description: "Reconcile the exact approved invitation and its original operationId using GET only. Returns stored fields, per-recipient scheduling and participation, or outcome_unknown. Does not create, retry or resend an invitation.",
    inputSchema: InvitationSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async item => {
    try {
      const { settings, request } = await connect();
      return ok(await reconcileInvitation(item, settings, request));
    } catch (error) { return failure(error); }
  });
  if (isReadOnly()) return;
  server.registerTool("calendar_send_invitation", {
    title: "Send Personal Calendar Invitation",
    description: "Create a genuine attendee invitation on the exact owner-configured personal iCloud calendar. Obtain approval of all exact fields before calling. Persist one operationId per approved proposal and reuse it on retries. Requires start/end offsets, location and description (empty allowed); no default duration. A stored event does not prove recipient delivery or acceptance. After outcome_unknown, reconcile the same operation; never use a fresh identity to resend.",
    inputSchema: InvitationSchema.extend({ confirm: confirmParam }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ confirm, ...item }) => {
    try {
      if (isReadOnly()) throw new InvitationRefused("Writes are disabled by MACOS_MCP_READONLY.");
      const guard = needsConfirmation(confirm, "calendar_send_invitation", "This sends invitations to the exact listed attendees.");
      if (guard) return guard;
      const { settings, request, store } = await connect();
      return ok(await sendInvitation(item, settings, request, store));
    } catch (error) { return failure(error); }
  });
}
