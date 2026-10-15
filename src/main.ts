// grok-line — personal LINE account CLI for Grok Bot.
// Speaks LINE's own protocol (Thrift over the LEGY gateway, E2EE) through linejs.
// Sends are refused unless --force is passed.
import { parseArgs } from "@std/cli/parse-args";
import QRCode from "qrcode";
import type { Device } from "@evex/linejs/base";
import type { Client } from "@evex/linejs";
import {
  ALLOWLIST_PATH,
  CACHE_DIR,
  connect,
  ensurePrivateDir,
  newBase,
  NotLoggedIn,
  openStorage,
  readSettings,
  STORAGE_PATH,
  versionFor,
  writeSettings,
} from "./session.ts";
import { decrypt, iso, midKind, Names, num, shape, type ShapedMessage } from "./lines.ts";

const VERSION = "0.1.1";
const TOOL = "grok-line";
const MAX_TEXT = 5000;
const DEVICES: Device[] = ["DESKTOPMAC", "DESKTOPWIN", "IOSIPAD", "ANDROIDSECONDARY", "WATCHOS", "WEAROS"];

const GAPS = [
  "This is not the LINE Messaging API. It logs in as a secondary device on your personal account (like LINE for Mac does) using the reverse-engineered protocol via linejs. LINE does not endorse it, and its terms forbid unofficial clients. Automated or bulk sending can get the account restricted. Keep volume human.",
  "Logging in as DESKTOPMAC takes LINE for Mac's device slot, so the Mac app gets logged out (observed on LINE 26.5.0). Another device type (for example IOSIPAD) avoids that but takes that slot instead.",
  "History comes from the server (getPreviousMessagesV2). E2EE messages decrypt only with keys exchanged during QR login. Messages from before this login may not decrypt and come back with decrypt_error.",
  "send encrypts (Letter Sealing E2EE) whenever the recipient has a key. Official/business accounts have none, so messages to them go as normal unencrypted LINE text, as LINE for Mac does. The dry run and the --json result say which (encrypted: true/false).",
  "send is plain text only. No stickers, images, files, reactions, unsend, or edits yet. Text is capped at 5000 characters.",
  "send --to is a person only (a friend or 1:1 chat name, or a u… mid). It never targets a group. Groups need --chat with the exact c… mid, after the user named that group.",
  "send --force only takes an exact mid (--chat, or --to u…). Names are for --dry-run: the dry run prints the mid, and that mid is what gets sent after approval, so a rename between approval and send cannot change the recipient.",
  "send --to searches friends first. An exact match on a nickname you set wins over names people chose themselves. Non-friends (strangers, official accounts) match on an exact name only, and only when no friend matches; the result has friend: false. Display names are chosen by their owners, so always confirm the mid.",
  "An optional allowlist (~/.config/grok-line/allowlist) restricts send targets when it exists. One mid per line (names are ignored, since anyone can pick any name). A file with no mids, or one that cannot be read, blocks every send.",
  "OpenChat (Square) is not covered. Calls are not covered.",
  "watch does not mark anything read. Read receipts are never sent by this CLI.",
];

type Flags = ReturnType<typeof parse>;
function parse(args: string[]) {
  return parseArgs(args, {
    string: ["to", "chat", "text", "limit", "query", "device"],
    boolean: ["json", "force", "dry-run", "unread", "include-own", "refresh", "help", "version"],
    alias: { h: "help", n: "limit" },
  });
}

/**
 * Human output carries text other people control (messages, display names).
 * Strip terminal control sequences (C0/C1, DEL, ESC-based ANSI/OSC) and bidi
 * overrides so a message cannot rewrite the screen, set the clipboard, or fake output.
 */
function clean(text: string): string {
  // deno-lint-ignore no-control-regex -- matching control characters is the point
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "\uFFFD");
}

/**
 * A display name as one quoted, bounded line. Names are chosen by their owners, so a
 * name with line breaks could otherwise print fake rows (e.g. a forged "mid:" line).
 */
function label(name: string | null | undefined): string {
  if (!name) return "?";
  const flat = clean(name).replace(/[\r\n\t\u0085\u2028\u2029\uFFFD]+/g, " ").trim();
  return JSON.stringify(flat.length > 64 ? flat.slice(0, 63) + "…" : flat);
}

function say(text: string) {
  console.log(clean(text));
}

class CliError extends Error {
  constructor(public error: string, message: string, public code = 1) {
    super(message);
  }
}

function out(flags: Flags, payload: Record<string, unknown>, human: () => void) {
  if (flags.json) console.log(JSON.stringify({ ok: true, tool: TOOL, version: VERSION, ...payload }));
  else human();
}

function limitOf(flags: Flags, def: number): number {
  const n = flags.limit === undefined ? def : Number(flags.limit);
  if (!Number.isInteger(n) || n < 1 || n > 500) throw new CliError("bad_limit", "--limit must be 1..500");
  return n;
}

// ---------- login / doctor ----------

async function cmdLogin(flags: Flags) {
  const settings = readSettings();
  const device = (flags.device ?? settings.device) as Device;
  if (!DEVICES.includes(device)) throw new CliError("bad_device", `--device must be one of ${DEVICES.join(", ")}`);
  if (!flags.force) {
    say(`Dry run. This would start a QR login as ${device}.`);
    say("It registers a new device on your LINE account and can log out another session that uses the same slot.");
    say("Rerun with --force to continue.");
    return;
  }
  const next = { ...settings, device };
  writeSettings(next);
  const storage = openStorage();
  const base = newBase(next, storage);
  const qrPng = `${CACHE_DIR}/login-qr.png`;
  base.on("qrcall", async (url: string) => {
    ensurePrivateDir(CACHE_DIR);
    await QRCode.toFile(qrPng, url, { width: 480, margin: 2 });
    Deno.chmodSync(qrPng, 0o600);
    console.log(await QRCode.toString(url, { type: "terminal", small: true }));
    say(`Scan with the LINE app on your phone (Home → QR scanner).\nAlso saved: ${qrPng}`);
    try { await new Deno.Command("open", { args: [qrPng] }).output(); } catch { /* headless */ }
  });
  base.on("pincall", (pin: string) => {
    say(`\nEnter this PIN on your phone: ${pin}\n`);
  });
  await base.loginProcess.login({ qr: true });
  try { Deno.removeSync(qrPng); } catch { /* already gone */ }
  const me = base.profile;
  out(flags, { device, mid: me?.mid, name: me?.displayName }, () => {
    say(`Logged in as ${label(me?.displayName)} (${device}). Session saved to ${STORAGE_PATH} (0600).`);
  });
}

async function cmdDoctor(flags: Flags) {
  const settings = readSettings();
  const checks: Record<string, unknown> = { device: settings.device, app_version: versionFor(settings) ?? "linejs default", storage: STORAGE_PATH };
  try {
    const st = Deno.statSync(STORAGE_PATH);
    checks.storage_mode = (st.mode! & 0o777).toString(8);
  } catch {
    checks.storage_mode = null;
  }
  let client: Client;
  try {
    client = await connect();
  } catch (e) {
    if (e instanceof NotLoggedIn) throw new CliError("not_logged_in", "No session. Run: grok-line login --force", 3);
    throw new CliError("session_invalid", `Cached session rejected: ${(e as Error).message}\nRun: grok-line login --force`, 3);
  }
  const me = client.base.profile!;
  checks.account = me.displayName;
  checks.mid = me.mid;
  out(flags, { checks }, () => {
    for (const [k, v] of Object.entries(checks)) say(`${k.padEnd(13)} ${v ?? "-"}`);
    say("status        ok");
  });
}

// ---------- reads ----------

// deno-lint-ignore no-explicit-any
async function messageBoxes(client: Client, opts: { limit: number; unreadOnly?: boolean }): Promise<any[]> {
  const res = await client.base.talk.getMessageBoxes({
    messageBoxListRequest: {
      messageBoxCountLimit: Math.min(opts.limit, 100),
      withUnreadCount: true,
      lastMessagesPerMessageBoxCount: 1,
      unreadOnly: !!opts.unreadOnly,
      activeOnly: true,
    },
    syncReason: "INTERNAL",
  });
  return res?.messageBoxes ?? [];
}

async function cmdChats(flags: Flags) {
  const client = await connect();
  const names = new Names(client);
  const limit = limitOf(flags, 30);
  const boxes = await messageBoxes(client, { limit: 100, unreadOnly: flags.unread });
  await names.resolve(boxes.map((b) => b.id), flags.refresh);
  const q = flags.query?.toLowerCase();
  const rows = boxes
    .map((b) => ({
      chat: b.id as string,
      type: midKind(b.id),
      name: names.get(b.id) ?? null,
      unread: num(b.unreadCount),
      last_time: iso(b.lastDeliveredMessageId?.deliveredTime ?? b.lastMessages?.[0]?.createdTime),
    }))
    .filter((r) => !q || (r.name ?? "").toLowerCase().includes(q) || r.chat === flags.query)
    .sort((a, b) => (b.last_time ?? "").localeCompare(a.last_time ?? ""))
    .slice(0, limit);
  out(flags, { chats: rows }, () => {
    for (const r of rows) {
      const unread = r.unread ? ` (${r.unread} unread)` : "";
      say(`${local(r.last_time)}  ${r.type.padEnd(5)}  ${r.chat}  ${label(r.name)}${unread}`);
    }
    if (!rows.length) say("No chats.");
  });
}

async function cmdUnread(flags: Flags) {
  const client = await connect();
  const names = new Names(client);
  const boxes = (await messageBoxes(client, { limit: 100, unreadOnly: true })).filter((b) => num(b.unreadCount) > 0);
  await names.resolve(boxes.map((b) => b.id));
  const rows = boxes.map((b) => ({ chat: b.id, type: midKind(b.id), name: names.get(b.id) ?? null, unread: num(b.unreadCount) }));
  const total = rows.reduce((s, r) => s + r.unread, 0);
  out(flags, { total, chats: rows }, () => {
    say(`${total} unread in ${rows.length} chat(s)`);
    for (const r of rows) say(`  ${String(r.unread).padStart(4)}  ${r.type.padEnd(5)}  ${r.chat}  ${label(r.name)}`);
  });
}

/** Name key for matching: case-, space- and punctuation-insensitive ("Corner Cafe" == "cornercafe"). */
function loose(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

interface Target {
  mid: string;
  name: string | null;
  /** "yours" = a nickname the account owner set; "theirs" = self-chosen by that account. */
  name_source: "yours" | "theirs" | null;
  /** In the friend list. null when the friend list could not be read. */
  friend: boolean | null;
}

/**
 * Resolves --to (person) or --chat (exact mid). Never maps a person to a group.
 *
 * Display names are chosen by the other person, so a stranger can pick any name.
 * --to therefore searches friends first (exact, then substring). Non-friends who
 * only appear as 1:1 chats (strangers, official accounts) match on an exact name
 * only, and only when no friend matches. The result says whether it is a friend.
 */
async function resolveTarget(client: Client, names: Names, flags: Flags, fresh = false): Promise<Target> {
  if (flags.to && flags.chat) throw new CliError("bad_target", "Pass --to or --chat, not both.");
  let friends: Set<string> | null = null;
  try {
    const { userFriendMids } = await client.base.relation.getUserFriendIds({ request: { blockStatus: "NOT_BLOCK" } });
    friends = new Set(userFriendMids ?? []);
  } catch { /* device may not be capable */ }
  const isFriend = (mid: string) => (friends ? friends.has(mid) : null);

  const explicit = flags.chat?.trim() ?? (/^u[0-9a-f]{32}$/.test(flags.to?.trim() ?? "") ? flags.to!.trim() : undefined);
  if (explicit !== undefined) {
    if (midKind(explicit) === "unknown") throw new CliError("bad_target", `Not a LINE mid: ${explicit}`);
    await names.resolve([explicit], fresh);
    return {
      mid: explicit,
      name: names.get(explicit) ?? null,
      name_source: names.source(explicit),
      friend: midKind(explicit) === "user" ? isFriend(explicit) : null,
    };
  }
  if (!flags.to) throw new CliError("bad_target", "Pass --to NAME or --chat MID.");
  const want = flags.to.trim();
  if (/^[cr][0-9a-f]{32}$/.test(want)) {
    throw new CliError("refusing_group", "--to is for a person. Use --chat with a group mid after the user named that group.", 4);
  }
  const boxes = await messageBoxes(client, { limit: 100 });
  const chatPeople = boxes.map((b) => b.id as string).filter((m) => midKind(m) === "user");
  // Names can change at any time; a send re-reads them rather than trusting the cache.
  await names.resolve([...chatPeople, ...(friends ?? [])], fresh);
  const key = loose(want);
  if (!key) throw new CliError("bad_target", "--to needs a name with letters or digits.");
  const asPerson = (mid: string): Target => ({ mid, name: names.get(mid) ?? null, name_source: names.source(mid), friend: isFriend(mid) });
  const named = (mid: string) => loose(names.get(mid) ?? "");

  const friendList = [...(friends ?? [])];
  const strangers = chatPeople.filter((m) => !friends?.has(m));
  const yours = (m: string) => names.source(m) === "yours";
  const tiers: string[][] = [
    // An exact match on a nickname you set wins. Otherwise every exact friend match
    // competes, so a friend who renames themselves to match is reported as ambiguous.
    friendList.filter((m) => yours(m) && named(m) === key),
    friendList.filter((m) => named(m) === key),
    friendList.filter((m) => named(m).includes(key)),
    strangers.filter((m) => named(m) === key),
  ];
  for (const hits of tiers) {
    if (hits.length === 1) return asPerson(hits[0]);
    if (hits.length > 1) {
      throw new CliError("ambiguous", `"${want}" matches ${hits.length} people:\n` +
        hits.map((m) => `  ${m}  ${label(names.get(m))}  (${yours(m) ? "your name for them" : "self-chosen name"}${isFriend(m) === false ? ", not a friend" : ""})`).join("\n"), 2);
    }
  }
  const groupHit = boxes.some((b) => midKind(b.id) !== "user" && named(b.id) === key);
  if (groupHit) {
    throw new CliError("refusing_group", `"${want}" is a group. --to is for a person. Use --chat with that group's mid.`, 4);
  }
  throw new CliError("not_found", `No friend named "${want}" (non-friends must match exactly). Try: grok-line chats --query "${want}"`, 2);
}

async function cmdRecent(flags: Flags) {
  const client = await connect();
  const names = new Names(client);
  const limit = limitOf(flags, 20);
  const target = await resolveTarget(client, names, flags);
  const myMid = client.base.profile!.mid;
  const raw = await client.base.talk.getRecentMessagesV2({ messageBoxId: target.mid, messagesCount: limit });
  // deno-lint-ignore no-explicit-any
  const list: any[] = Array.isArray(raw) ? raw : [];
  await names.resolve(list.map((m) => m.from));
  const msgs: ShapedMessage[] = [];
  for (const m of list) {
    const { msg, error } = await decrypt(client, m);
    msgs.push(shape(msg, myMid, names, error));
  }
  msgs.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
  out(flags, { chat: target.mid, name: target.name, messages: msgs }, () => printMessages(msgs));
}

/** ISO → "YYYY-MM-DD HH:MM" in local time, for human output. */
function local(isoTime: string | null): string {
  if (!isoTime) return "";
  const d = new Date(isoTime);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function printMessages(msgs: ShapedMessage[]) {
  for (const m of msgs) {
    let who = m.own ? "me" : label(m.from_name ?? m.from.slice(0, 9));
    if (m.chat_type !== "user") who += ` in ${label(m.chat_name)}`;
    const body = m.decrypt_error ? `[could not decrypt: ${m.decrypt_error}]` : m.kind === "text" ? m.text : `[${m.kind}] ${m.text ?? ""}`;
    say(`${local(m.time)}  ${who}: ${(body ?? "").replaceAll("\n", "\n      ")}`);
  }
}

// ---------- send ----------

/**
 * Optional send allowlist: one mid per line (u…, c…, r…). Names are not accepted,
 * because display names are chosen by the other person. A missing file means no
 * allowlist. Any other read error, or a file with no mids, blocks every send.
 */
function readAllowlist(): Set<string> | null {
  let raw: string;
  try {
    raw = Deno.readTextFileSync(ALLOWLIST_PATH);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw new CliError("allowlist_unreadable", `Cannot read ${ALLOWLIST_PATH}: ${(e as Error).message}. Refusing to send.`, 4);
  }
  const mids = new Set<string>();
  for (const line of raw.split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean)) {
    if (/^[ucr][0-9a-f]{32}$/.test(line)) mids.add(line);
    else console.error(clean(`grok-line: ignoring allowlist entry "${line}" (mids only; see grok-line chats)`));
  }
  return mids;
}

async function cmdSend(flags: Flags) {
  const text = flags.text;
  if (!text || !text.trim()) throw new CliError("empty_text", "Pass --text with the exact message.");
  if (text.length > MAX_TEXT) throw new CliError("text_too_long", `Text is ${text.length} chars; cap is ${MAX_TEXT}.`);
  const sending = flags.force && !flags["dry-run"];
  const toMid = /^u[0-9a-f]{32}$/.test(flags.to?.trim() ?? "");
  if (sending && flags.to && !toMid) {
    // A name is looked up again on every call, and display names can change between the
    // dry run and the send. Sending only to an exact mid means the approved recipient is
    // the one that gets the message.
    throw new CliError(
      "needs_mid",
      "--force needs the exact recipient mid. Run the --dry-run first, get the user's approval, then send with --chat <mid from the dry run>.",
      4,
    );
  }
  const client = await connect();
  const names = new Names(client);
  const target = await resolveTarget(client, names, flags, true);
  const allow = readAllowlist();
  if (allow && !allow.has(target.mid)) {
    throw new CliError("not_allowlisted", `${target.mid} ${label(target.name)} is not in ${ALLOWLIST_PATH}.`, 4);
  }
  const encrypted = await supportsE2EE(client, target.mid);
  const plan = {
    to: target.mid,
    name: target.name,
    name_source: target.name_source,
    type: midKind(target.mid),
    friend: target.friend,
    encrypted,
    text,
  };
  if (flags["dry-run"] || !flags.force) {
    out(flags, { sent: false, dry_run: true, ...plan }, () => {
      const warn = target.friend === false
        ? "NOT A FRIEND, name chosen by that account"
        : target.name_source === "theirs" ? "name chosen by that account" : "your name for them";
      // The mid comes first and the self-chosen name is quoted on one line, so a name
      // cannot pose as part of this block.
      say(`Dry run. Nothing sent.`);
      say(`  mid:   ${target.mid}`);
      say(`  name:  ${label(target.name)} (${plan.type}, ${warn})`);
      say(`  mode:  ${encrypted ? "E2EE" : "plain text, no E2EE key"}`);
      say(`  text:\n${text}`);
      say(`\nAfter the user approves this recipient and exact text:\n  grok-line send --chat ${target.mid} --text <same text> --force`);
    });
    return;
  }
  const sent = await client.base.talk.sendMessage({ to: target.mid, text, e2ee: encrypted });
  out(flags, { sent: true, id: String(sent?.id ?? ""), ...plan }, () => {
    say(`Sent to ${target.mid} ${label(target.name)}${encrypted ? "" : " (not end-to-end encrypted: recipient has no Letter Sealing key)"}.`);
  });
}

/**
 * Whether to encrypt. People (and groups) with Letter Sealing get E2EE.
 * Official/business accounts have no E2EE key (specVersion -1) and only accept plain text,
 * which is what LINE for Mac sends them too. Any other lookup failure stays encrypted.
 */
async function supportsE2EE(client: Client, mid: string): Promise<boolean> {
  if (midKind(mid) !== "user") return true;
  try {
    const r = await client.base.talk.negotiateE2EEPublicKey({ mid });
    return r.specVersion !== -1;
  } catch {
    return true;
  }
}

// ---------- watch ----------

async function cmdWatch(flags: Flags) {
  const client = await connect();
  const names = new Names(client);
  const myMid = client.base.profile!.mid;
  const ac = new AbortController();
  Deno.addSignalListener("SIGINT", () => ac.abort());
  Deno.addSignalListener("SIGTERM", () => ac.abort());
  if (!flags.json) console.error(`Watching as ${label(client.base.profile!.displayName)}. Ctrl-C to stop.`);
  // LEGY push stream, the same long-lived channel the desktop app keeps open.
  ac.signal.addEventListener("abort", () => client.base.push.opStream.close());
  const stream = client.base.createPolling().listenTalkEvents();
  for await (const op of stream) {
    if (op.type !== "RECEIVE_MESSAGE" && !(flags["include-own"] && op.type === "SEND_MESSAGE")) continue;
    if (!op.message) continue;
    const { msg, error } = await decrypt(client, op.message);
    await names.resolve([msg.from, msg.to]);
    const m = shape(msg, myMid, names, error);
    if (flags.json) console.log(JSON.stringify({ type: "message", ...m }));
    else printMessages([m]);
  }
}

// ---------- entry ----------

const HELP = `grok-line ${VERSION} — personal LINE account CLI (local, via linejs)

  grok-line login [--device DESKTOPMAC|IOSIPAD|…] --force   QR login, saves session
  grok-line doctor [--json]
  grok-line chats [--query Q] [--unread] [--limit N] [--refresh] [--json]
  grok-line unread [--json]
  grok-line recent (--to NAME | --chat MID) [--limit N] [--json]
  grok-line send (--to NAME | --chat MID) --text "…" [--dry-run] --force
  grok-line watch [--json] [--include-own]     stream incoming messages (JSONL with --json)
  grok-line gaps

Sends need --force. --to is a person only; groups need --chat MID.`;

async function main() {
  const [cmd, ...rest] = Deno.args;
  const flags = parse(rest);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return console.log(HELP);
  if (cmd === "--version" || cmd === "version") return console.log(VERSION);
  switch (cmd) {
    case "login": return await cmdLogin(flags);
    case "doctor": return await cmdDoctor(flags);
    case "chats": return await cmdChats(flags);
    case "unread": return await cmdUnread(flags);
    case "recent": return await cmdRecent(flags);
    case "send": return await cmdSend(flags);
    case "watch": return await cmdWatch(flags);
    case "gaps": return GAPS.forEach((g) => say(`- ${g}\n`));
    default: throw new CliError("unknown_command", `Unknown command: ${cmd}\n\n${HELP}`, 2);
  }
}

try {
  await main();
  Deno.exit(0);
} catch (e) {
  const asJson = Deno.args.includes("--json");
  const err = e instanceof CliError ? e
    : e instanceof NotLoggedIn ? new CliError("not_logged_in", "No session. Run: grok-line login --force", 3)
    : new CliError("line_error", (e as Error)?.message ?? String(e));
  if (asJson) console.log(JSON.stringify({ ok: false, tool: TOOL, version: VERSION, error: err.error, code: err.code, message: err.message }));
  else console.error(clean(`grok-line: ${err.error}\n${err.message}`));
  Deno.exit(err.code);
}
