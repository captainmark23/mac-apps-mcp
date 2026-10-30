/**
 * Sending through Messages.app via JXA.
 *
 * Behaviour checked on macOS 27.2:
 * - Messages scripting only exposes the ~200 most recent chats, so
 *   `chats.byId(guid)` works for a recent chat and fails for an older one.
 * - `accounts.whose({serviceType})` fails ("Can't convert types") and some
 *   accounts throw on `serviceType()`, so accounts are scanned one by one.
 * - `participants.whose({handle})` works; a participant's id is
 *   "<account id>:<handle>", which tells which service it belongs to.
 * - There is no command to mark a chat read.
 */

import { executeJxaWrite, jxaString } from "../shared/applescript.js";

export interface SendTarget {
  /** chat.guid of an existing chat; tried first. */
  chatGuid?: string;
  /** 1:1 handle to fall back to when the chat is not scriptable. */
  handle?: string;
  /** Allow an SMS participant when no iMessage one exists (only if the handle already has an SMS chat). */
  allowSms: boolean;
}

/** How the message was addressed: an existing chat, or a participant on a service. */
export type SendVia = "chat" | "iMessage" | "SMS";

const SEND_TIMEOUT_MS = 30_000;

export async function sendText(target: SendTarget, text: string): Promise<SendVia> {
  const result = await executeJxaWrite<{ via?: SendVia; error?: string }>(`
    const Messages = Application("Messages");
    const chatGuid = ${jxaString(target.chatGuid ?? "")};
    const handle = ${jxaString(target.handle ?? "")};
    const allowSms = ${target.allowSms ? "true" : "false"};
    let to = null;
    let via = null;

    if (chatGuid) {
      try {
        const chat = Messages.chats.byId(chatGuid);
        chat.id();
        to = chat;
        via = "chat";
      } catch (e) { /* not among the chats Messages exposes */ }
    }

    if (!to && handle) {
      const accountIds = {};
      for (const a of Messages.accounts()) {
        let type = null;
        try { type = a.serviceType(); } catch (e) { continue; }
        if ((type === "iMessage" || type === "SMS") && !accountIds[type] && a.enabled()) accountIds[type] = a.id();
      }
      const people = Messages.participants.whose({ handle: handle })();
      const on = (service) => accountIds[service]
        ? people.find((p) => p.id().indexOf(accountIds[service] + ":") === 0)
        : undefined;
      const im = on("iMessage");
      const sms = allowSms ? on("SMS") : undefined;
      if (im) { to = im; via = "iMessage"; }
      else if (sms) { to = sms; via = "SMS"; }
    }

    if (!to) {
      JSON.stringify({ error: "Messages has no chat or participant for this recipient. Start the conversation in Messages first." });
    } else {
      Messages.send(${jxaString(text)}, { to: to });
      JSON.stringify({ via: via });
    }
  `, { timeout: SEND_TIMEOUT_MS });
  if (result.error || !result.via) throw new Error(result.error || "Messages did not accept the send.");
  return result.via;
}
