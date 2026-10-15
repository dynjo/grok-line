# grok-line

A command-line client for your **personal LINE account**, built so an AI agent (Grok Bot, or any agent that can run shell commands) can read your chats and, with your approval, reply.

```bash
grok-line unread
grok-line recent --to "Ada" --limit 10
grok-line send --to "Ada" --text "On my way" --dry-run
```

> [!WARNING]
> This is an **unofficial client**. LINE does not endorse it, and LINE's terms of use forbid third-party clients. Accounts that look automated (bulk sends, identical messages to many chats, instant replies around the clock) can be restricted. Use it on your own account, keep the volume human, and accept that risk before you log in.

## How it works

`grok-line` is not the [LINE Messaging API](https://developers.line.biz/en/docs/messaging-api/), which only works for Official Accounts. It signs in to your own account as a secondary device, the same way LINE's desktop apps do, and speaks LINE's client protocol (Thrift over the LEGY gateway, with Letter Sealing end-to-end encryption).

The protocol implementation is [linejs](https://github.com/evex-dev/linejs). This project is the CLI around it: login, name lookup, JSON output for agents, and guard rails for sending.

Everything runs on your own computer. Your session and encryption keys stay in a local file, and the only network traffic is to LINE's servers.

## Requirements

- [Deno](https://deno.com) 2.x (`brew install deno` on macOS)
- A LINE account on your phone, used to approve the login
- Built and tested on macOS. It should run anywhere Deno runs, but other platforms are untested.

## Install

```bash
git clone https://github.com/dynjo/grok-line.git
cd grok-line
ln -s "$PWD/bin/grok-line" ~/.local/bin/grok-line   # or anywhere on your PATH
```

Dependencies are pinned in `deno.lock` and download on first run.

## Log in

```bash
grok-line login --force
```

1. A QR code appears in the terminal (and opens as an image on macOS).
2. Scan it with the LINE app on your phone: Home tab → QR scanner.
3. A PIN appears in the terminal. Enter it on your phone.

Then check the session:

```bash
grok-line doctor
```

### Pick a device slot first

LINE allows one session per secondary-device type. Logging in here **signs out whatever is already using that slot**.

| `--device` | Signs out |
| --- | --- |
| `DESKTOPMAC` (default) | LINE for Mac. On a Mac with LINE installed, `grok-line` reports that app's version. |
| `DESKTOPWIN` | Likely the desktop app too (untested) |
| `IOSIPAD` | LINE on an iPad |

If you use LINE's desktop app and want to keep it, log in with a slot you don't use, for example `grok-line login --device IOSIPAD --force`.

## Usage

```bash
grok-line doctor                                    # session check
grok-line chats [--query Q] [--unread] [--limit N]  # recent conversations
grok-line unread                                    # unread counts per chat
grok-line recent --to "Ada" [--limit N]             # history with a friend
grok-line recent --chat <mid> [--limit N]           # history of any chat, including groups
grok-line send --to "Ada" --text "hi" --dry-run     # resolve the recipient, print its mid
grok-line send --chat <mid> --text "hi" --force     # send to that exact mid
grok-line watch [--include-own]                     # stream incoming messages
grok-line gaps                                      # known limitations
```

Every command except `gaps` accepts `--json`. Run `grok-line --help` for the full list.

Every LINE user, group, and room has a **mid**, an ID like `u1a2b…` (user), `c1a2b…` (group), or `r1a2b…` (room). `chats` lists them, and `--chat` accepts any of them.

### Streaming messages to an agent

`grok-line watch --json` prints one JSON object per message as it arrives:

```json
{"type":"message","id":"…","chat":"u…","chat_type":"user","chat_name":"Ada","from":"u…","from_name":"Ada","own":false,"kind":"text","text":"Are you coming?","time":"2026-10-15T13:04:48.027Z"}
```

`chat` is the conversation to reply into: the group's mid, or the other person's mid in a 1:1 chat. Messages that can't be decrypted carry a `decrypt_error` field instead of text.

## Sending safely

Sending is a two-step process, so that a person approves every message before it goes out:

1. **Dry run.** `send --to "Ada" --text "…" --dry-run` finds the recipient and prints the name, mid, whether they're a friend, and whether the message will be encrypted. Nothing is sent.
2. **Send.** After you approve, `send --chat <that mid> --text "…" --force`.

`--force` only accepts an exact mid, never a name. The recipient you approved is the one that gets the message, even if someone renames themselves in between.

More rules:

- **Names can be faked.** People choose their own display names. `--to` searches your friends first. Nicknames you set yourself win over names people chose. Non-friends (strangers, business accounts) only match an exact name, and come back flagged `friend: false`.
- **No accidental group messages.** `--to` only matches people. A group needs `--chat` with its mid.
- **Optional allowlist.** If `~/.config/grok-line/allowlist` exists, only the mids listed there (one per line) can receive messages. Names in the file are ignored. A file with no mids, or one that can't be read, blocks every send.
- **No read receipts.** Nothing marks chats as read.
- **Encryption.** Messages are end-to-end encrypted whenever the recipient supports it. Official/business accounts don't, so messages to them go as normal LINE text, as with LINE's own apps.

## Using it with an AI agent

[`SKILL.md`](./SKILL.md) is a ready-made skill for agents that support the `SKILL.md` format (Grok, Claude Code, Cursor and others). It tells the agent which commands to use, to get your approval before every send, and how to handle each error. Install it however your agent loads skills, for example:

```bash
mkdir -p ~/.grok/skills/grok-line && ln -s "$PWD/SKILL.md" ~/.grok/skills/grok-line/SKILL.md
```

For a hosted agent like Grok Bot, ask it to install the skill from this repo's `SKILL.md`. The agent has to be able to run `grok-line` on the computer where you logged in.

## Your data

| Path | Contents |
| --- | --- |
| `~/.config/grok-line/storage.json` | Login token, refresh token, end-to-end encryption private keys. Created `0600`. **Treat it like a password.** |
| `~/.config/grok-line/settings.json` | Device slot and optional app-version override |
| `~/.config/grok-line/allowlist` | Optional send allowlist |
| `~/.cache/grok-line/names.json` | Cache of mid → display name |

Set `GROK_LINE_CONFIG` to use a different config directory. To log out, delete `storage.json`, then remove the device from the logged-in devices list in your phone's LINE account settings.

`grok-line` runs inside Deno's permission sandbox: network access, plus file access limited to the directories above.

## Limitations

- Text only: no stickers, images, files, reactions, edits, or unsending yet.
- Messages sent before you logged in may not decrypt, because the encryption keys come from the login.
- OpenChat (Square) and calls aren't covered.
- If LINE changes its protocol, login can break until linejs catches up. Update the pinned version in `deno.json`.

`grok-line gaps` prints the current list.

## Credits

- [linejs](https://github.com/evex-dev/linejs) by Evex Developers: the LINE protocol, E2EE and login
- [CHRLINE](https://github.com/DeachSword/CHRLINE): earlier protocol research that linejs builds on

Not affiliated with LY Corporation (LINE) or xAI (Grok).
