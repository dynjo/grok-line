# line-grok

`grok-line` lets Grok Bot use your personal LINE account from this Mac.

It does not drive the LINE app or read its screen. It speaks LINE's own client protocol, the same one LINE for Mac uses: Apache Thrift over the LEGY gateway (`/api/v4/TalkService.do`), QR login through `SecondaryQrCodeLoginService`, and Letter Sealing E2EE. The protocol work comes from [linejs](https://github.com/evex-dev/linejs) (`jsr:@evex/linejs`, pinned to 3.5.0). This repo is the CLI and the safety rails around it.

## Install

Requires Deno 2.x (`brew install deno`).

```bash
cd ~/Developer/line-grok
ln -sf "$PWD/bin/grok-line" ~/.local/bin/grok-line
grok-line login --force          # QR on screen, scan with your phone, enter the PIN
grok-line doctor
```

## Commands

```bash
grok-line doctor [--json]
grok-line chats [--query Q] [--unread] [--limit N] [--refresh] [--json]
grok-line unread [--json]
grok-line recent --to "Name" [--limit N] [--json]       # a person
grok-line recent --chat c0123… [--limit N] [--json]     # any chat by mid
grok-line send --to "Name" --text "hello" --dry-run
grok-line send --to "Name" --text "hello" --force
grok-line send --chat c0123… --text "hello" --force     # groups: exact mid only
grok-line watch --json [--include-own]                  # JSONL, one message per line
grok-line gaps
```

`watch --json` prints one line per message:

```json
{"type":"message","id":"…","chat":"u…","chat_type":"user","chat_name":"Ada","from":"u…","from_name":"Ada","own":false,"kind":"text","text":"hi","time":"2026-10-15T13:04:48.027Z"}
```

`chat` is the conversation: the group mid, or the other person's mid in a 1:1. Pass it straight to `recent --chat` or `send --chat`.

## Hard rules

- Never send without the user's approval of the recipient and the exact text. `--force` is the only send path. `--dry-run` never sends.
- `--to` is a person only. It refuses group names and group mids. Groups need `--chat` with the exact mid, and only after the user named that group.
- `--to` searches friends first. Strangers and official accounts only match on their exact name, and only when no friend matches. The dry run and `--json` result say `friend: false` for them. Display names are chosen by their owners, so confirm the mid.
- If `~/.config/grok-line/allowlist` exists, every target must be listed by mid (one `u…`/`c…`/`r…` per line; names are ignored because anyone can pick any name). A file with no mids, or one that can't be read, blocks every send.
- Human-readable output strips terminal control sequences from message text and names. `--json` output is plain JSON.
- Nothing marks chats read and no read receipts are sent.

## Device slot

The session logs in as a secondary device. The default is `DESKTOPMAC`, using the installed LINE for Mac version. LINE allows one desktop session, so **logging in here logs out LINE for Mac** (and logging LINE for Mac back in logs this out). To keep the Mac app, log in under another slot instead, e.g. `grok-line login --device IOSIPAD --force`, which in turn takes the iPad slot.

## Files

| Path | What |
| --- | --- |
| `~/.config/grok-line/storage.json` | Auth token, refresh token, E2EE private keys. `0600`. Treat it as a password. |
| `~/.config/grok-line/settings.json` | Device type and optional app version override. |
| `~/.config/grok-line/allowlist` | Optional send allowlist. |
| `~/.cache/grok-line/names.json` | mid → display name cache. `0600`. |

Nothing leaves the Mac except the traffic to LINE's own servers. Do not commit or copy `storage.json`.

`grok-line` runs under Deno's permission sandbox: network, plus read/write limited to the two directories above (and reading LINE.app's `Info.plist` for the version).

## Risks

LINE does not endorse this, and its terms forbid unofficial clients. Accounts get restricted for spam-like behaviour (bulk sends, identical messages to many chats, machine-speed replies), so keep the bot's volume and pacing human. Protocol changes on LINE's side can break login until linejs catches up. Bump the pinned version in `deno.json` when that happens.

Messages from before the login may not decrypt (`decrypt_error`). E2EE keys come from the QR login.
