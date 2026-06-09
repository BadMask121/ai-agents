# 09 — Operations

## Daily use

- A client emails → within a poll cycle (~90s) you get a Telegram alert with their message and a
  suggested reply.
- Tap **Approve** to send as-is, **Edit** to revise (reply with new text, then confirm), **Reject** to
  drop it, or **Not a lead** to stop hearing from that sender.
- When a client pays, open their alert and tap **Deposit received** or **Paid in full**. If the bot
  doesn't yet have the date/time, it asks — reply with something like `Aug 14 2026, 2pm, 4 hours` and
  it creates the calendar event and sends you the link.

## Managing accounts

| Want to… | Do |
|---|---|
| Add an inbox | `/connect` |
| See connected accounts | `/accounts` |
| Remove an inbox | `/disconnect <email>` |
| Change the booking calendar | `/setcalendar <email>` |

## Re-authentication

If an account's token goes bad (revoked, or the consent screen was left in "Testing" and expired),
the worker posts: `⚠️ <email> disconnected (auth expired). Re-link with /connect.` Just run
`/connect` again for that account. To avoid weekly expiry, make sure the Google consent screen is
**Published to Production** ([03](03-google-setup.md)).

## Logs & state

- **Logs**: container stdout (Coolify log viewer) and `logs/` in the volume. Each line is
  `TIMESTAMP LEVEL [scope] message`.
- **Inspect state**: the volume holds human-readable JSON — `clients/<id>.json`, `actions/`,
  `suppressed.json`, `settings.json`. Safe to read; edit only if you know what you're doing
  (writes are atomic, but the running worker caches some files in memory).

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| No alerts at all | Check logs for `telegram loop started`; verify `TELEGRAM_CHAT_ID` is *your* chat; confirm at least one account is connected (`/accounts`). |
| `409 Conflict` from Telegram | Two pollers running. Ensure only one container/instance; the worker calls `deleteWebhook` on boot. |
| Drafts ignore your prices | `config/packages.yml` missing or empty in the volume — add it. |
| Bot offers booked dates | The default calendar account's free/busy isn't visible — check `/setcalendar` and that `calendar.readonly` was granted. |
| A sender keeps alerting that isn't a client | Tap **Not a lead** once; they're added to `suppressed.json`. |
| "auth expired" messages | Re-`/connect`; publish the consent screen to Production. |
| Reply didn't thread for the client | Confirm the original had a `Message-ID`; booking-ops sets `In-Reply-To`/`References` + `threadId`. |

## Suppression upkeep

To un-suppress someone, edit `suppressed.json` (remove their email) and restart the worker, or just
let them email again after editing — the in-memory cache reloads on restart.
