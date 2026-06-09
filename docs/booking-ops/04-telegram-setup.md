# 04 — Telegram setup

Telegram is your entire control surface. One bot, one authorized chat (you).

## Create the bot (~2 min)

1. DM [@BotFather](https://t.me/BotFather): `/newbot`, pick a name and username.
2. Copy the **bot token** → set `TELEGRAM_BOT_TOKEN`.
3. Send `/start` to your new bot once so a chat exists.

## Find your chat id

Easiest: message your bot, then visit (token filled in):

```
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates
```

Read `result[].message.chat.id` — that number is your `TELEGRAM_CHAT_ID`. The worker only accepts
updates from this chat and ignores everyone else (the bot token is a bearer secret).

```
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=123456789
```

## Commands

| Command | Action |
|---|---|
| `/start`, `/help` | Show the command list. |
| `/connect` | Link a Google (Gmail + Calendar) account via the device flow (below). |
| `/accounts` | List connected accounts (marks the default calendar). |
| `/disconnect <email>` | Unlink an account. |
| `/setcalendar <email>` | Choose which account's calendar new bookings go on. |

## The `/connect` web flow

1. DM the bot `/connect`.
2. It replies with a **Google authorization link** (tap it on your phone).
3. Authorize on Google's consent screen.
4. Google redirects to the bot's callback (`GOOGLE_REDIRECT_URI`); the bot exchanges the code, saves
   the account, and DMs you `✅ Connected <email>`.
5. Repeat `/connect` for each inbox you want watched. The **first** connected account becomes the
   default booking calendar; change it any time with `/setcalendar`.

The link is valid ~15 minutes; if it lapses, just run `/connect` again. `/connect` only works once
`GOOGLE_REDIRECT_URI` is set (a deployed, public callback) — see [03](03-google-setup.md) /
[08](08-deployment.md). Until then, link from a terminal with `auth:local`.

## Buttons on a draft alert

- **✅ Approve** — send the reply (threaded) from the receiving account.
- **✏️ Edit** — reply with revised text; the bot re-shows Approve/Reject to confirm before sending.
- **🚫 Reject** — dismiss without sending.
- **🙅 Not a lead** — suppress this sender (no more alerts from them).
- **💵 Deposit received** / **💰 Paid in full** — confirm payment → create the calendar event.
