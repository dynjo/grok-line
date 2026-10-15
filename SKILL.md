---
name: LINE Desk
description: >-
  Use when the user wants to read, search, watch, or reply to their personal
  LINE chats (friends, groups). Local CLI `grok-line` that
  logs in as a LINE secondary device. Not the LINE Messaging API, not LINE
  Official Accounts, not OpenChat.
---
# LINE Desk

`grok-line` is a local CLI for the user's personal LINE account. Run it on the computer where the user logged in, never on a cloud sandbox.

## Install

```bash
git clone https://github.com/dynjo/grok-line.git ~/grok-line
ln -s ~/grok-line/bin/grok-line ~/.local/bin/grok-line
grok-line doctor
```

Requires Deno 2.x. `not_logged_in` (exit 3) means the user must run `grok-line login --force` themselves: it shows a QR to scan on their phone and a PIN to type. Do not loop the doctor. Tell the user that login takes a LINE device slot (default: the desktop slot, which signs out LINE's desktop app).

## Read

```bash
grok-line unread --json
grok-line chats --json [--query "name"]
grok-line recent --to "Person" --limit 20 --json
grok-line recent --chat <mid> --limit 20 --json
grok-line watch --json      # long-running JSONL stream of incoming messages
```

## Send (consent required)

1. Draft the recipient and the exact text.
2. `grok-line send --to "Person" --text "…" --dry-run --json` to resolve the recipient. Show the user the name, `name_source`, `friend`, and the `to` mid alongside the text.
3. Only after an explicit yes: `grok-line send --chat <to mid from step 2> --text "…" --force`. `--force` refuses names, so the approved mid is the one that gets the message.

- `--to` matches friends loosely ("Corner Cafe" finds "cornercafe"). Non-friends (strangers, business accounts) need the exact name and come back with `friend: false`. Names are self-chosen, so when `friend` is false, show the user the mid and the chat history before asking for approval. If unsure, use `chats --query` and pass `--chat <mid>`.
- Business/Official accounts can't take E2EE, so those sends go unencrypted (`encrypted: false`). That is expected, not an error.
- `--to` is a person only. Never resolve a person to a group.
- Groups need `--chat <mid>`, and only when the user named that group.
- Never send on your own initiative, in bulk, or the same text to several chats. LINE restricts accounts that look automated.

## Errors

| Exit | error | Action |
| --- | --- | --- |
| 2 | not_found / ambiguous | Ask the user which person; show the candidates. |
| 3 | not_logged_in / session_invalid | User runs `grok-line login --force`. Stop. |
| 4 | refusing_group / not_allowlisted / allowlist_unreadable | Do not work around it. Ask the user. |
| 4 | needs_mid | You passed a name with --force. Dry-run, get approval, send to the mid. |
| 1 | line_error | Report the message once. No retry loop. |
