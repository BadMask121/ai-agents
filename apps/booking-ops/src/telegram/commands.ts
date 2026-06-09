import { loadConfig } from "../config.js";
import { sendMessage } from "./client.js";
import { createState } from "../crm/oauthState.js";
import { buildAuthUrl } from "../google/oauthWeb.js";
import {
  listAccounts,
  deleteAccount,
  setDefaultCalendarAccount,
  getDefaultCalendarAccount,
} from "../google/accounts.js";

const HELP = [
  "Booking-ops commands:",
  "/connect — link a Google (Gmail + Calendar) account",
  "/accounts — list connected accounts",
  "/disconnect <email> — unlink an account",
  "/setcalendar <email> — choose the default booking calendar",
].join("\n");

/**
 * Handle a slash command. Returns true if the text was a command we handled,
 * false otherwise (so the loop can treat it as a normal message / reply).
 */
export async function handleCommand(
  chatId: number | string,
  text: string,
): Promise<boolean> {
  if (!text.startsWith("/")) return false;
  const [cmd, ...args] = text.trim().split(/\s+/);

  switch (cmd) {
    case "/start":
    case "/help":
      await sendMessage(chatId, HELP);
      return true;

    case "/connect": {
      const cfg = loadConfig();
      if (!cfg.GOOGLE_REDIRECT_URI) {
        await sendMessage(
          chatId,
          "Linking isn't configured (GOOGLE_REDIRECT_URI unset). Set it on the server, or link locally with the auth:local CLI.",
        );
        return true;
      }
      const state = await createState(String(chatId), Date.now());
      const url = buildAuthUrl(state);
      await sendMessage(
        chatId,
        [
          "🔗 Tap to link a Google account (Gmail + Calendar):",
          "",
          url,
          "",
          "Authorize on the consent screen — I'll confirm here when it's done. (Link valid 15 min.)",
        ].join("\n"),
      );
      return true;
    }

    case "/accounts": {
      const accounts = await listAccounts();
      const def = await getDefaultCalendarAccount();
      if (accounts.length === 0) {
        await sendMessage(chatId, "No accounts connected yet. See /connect.");
      } else {
        const lines = accounts.map(
          (a) => `• ${a.email}${a.email === def?.email ? "  (default calendar)" : ""}`,
        );
        await sendMessage(chatId, `Connected accounts:\n${lines.join("\n")}`);
      }
      return true;
    }

    case "/disconnect": {
      const email = args[0];
      if (!email) {
        await sendMessage(chatId, "Usage: /disconnect <email>");
      } else {
        const ok = await deleteAccount(email);
        await sendMessage(chatId, ok ? `Disconnected ${email}.` : `Not connected: ${email}`);
      }
      return true;
    }

    case "/setcalendar": {
      const email = args[0];
      if (!email) {
        await sendMessage(chatId, "Usage: /setcalendar <email>");
      } else {
        const ok = await setDefaultCalendarAccount(email);
        await sendMessage(
          chatId,
          ok ? `Default calendar set to ${email}.` : `Not connected: ${email}`,
        );
      }
      return true;
    }

    default:
      await sendMessage(chatId, `Unknown command.\n\n${HELP}`);
      return true;
  }
}
