---
name: LINE Desk
description: >-
  Use when the user wants to read, search, watch, or reply to their personal
  LINE chats (friends, groups) from their Mac. Local CLI `grok-line` that
  logs in as a LINE secondary device. Not the LINE Messaging API, not LINE
  Official Accounts, not OpenChat.
---
# LINE Desk

`grok-line` is a local CLI for the user's personal LINE account. Run it on the user's registered Mac only. Never on the cloud box.

## Install

```bash
cd ~/Developer/line-grok && ln -sf "$PWD/bin/grok-line" ~/.local/bin/grok-line
grok-line doctor
```

`not_logged_in` (exit 3) means the user must run `grok-line login --force` themselves: it shows a QR to scan on their phone and a PIN to type. Do not loop the doctor. Tell the user that login takes LINE for Mac's desktop slot and logs that app out.

## Read

```bash
grok-line unread --json
grok-line chats --json [--query "name"]
grok-line recent --to "Person" --limit 20 --json
grok-line recent --chat <mid> --limit 20 --json
grok-line watch --json      # long-running JSONL stream of incoming messages
```

## Send (consent required)

1. Draft the recipient and the exact text and show both to the user.
2. `grok-line send --to "Person" --text "…" --dry-run` to confirm the resolved target.
3. Only after an explicit yes: the same command with `--force` instead of `--dry-run`.

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
| 4 | refusing_group / not_allowlisted | Do not work around it. Ask the user. |
| 1 | line_error | Report the message once. No retry loop. |
