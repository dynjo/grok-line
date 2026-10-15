// Name lookups and message shaping shared by the commands.
import type { Client } from "@evex/linejs";
import { CACHE_DIR, ensurePrivateDir } from "./session.ts";

const NAMES_PATH = `${CACHE_DIR}/names.json`;

export type MidKind = "user" | "group" | "room" | "unknown";

export function midKind(mid: string): MidKind {
  switch (mid[0]) {
    case "u": return "user";
    case "c": return "group";
    case "r": return "room";
    default: return "unknown";
  }
}

export function num(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  if (typeof v === "string" && v !== "") return Number(v);
  return 0;
}

export function iso(ms: unknown): string | null {
  const n = num(ms);
  return n ? new Date(n).toISOString() : null;
}

/** mid → display name, cached in ~/.cache/grok-line/names.json (0600). */
export class Names {
  #map: Record<string, string> = {};
  #dirty = false;
  constructor(private client: Client) {
    try {
      this.#map = JSON.parse(Deno.readTextFileSync(NAMES_PATH));
    } catch { /* first run */ }
  }

  get(mid: string): string | undefined {
    return this.#map[mid];
  }

  /** Resolves any unknown mids in one round trip per kind. */
  async resolve(mids: Iterable<string>, refresh = false): Promise<void> {
    const want = [...new Set(mids)].filter((m) => refresh || !(m in this.#map));
    const users = want.filter((m) => midKind(m) === "user");
    const groups = want.filter((m) => midKind(m) === "group");
    const base = this.client.base;
    for (let i = 0; i < users.length; i += 100) {
      try {
        const contacts = await base.talk.getContacts({ mids: users.slice(i, i + 100) });
        for (const c of contacts ?? []) {
          if (c?.mid) this.#set(c.mid, c.displayNameOverridden || c.displayName || c.mid);
        }
      } catch (e) {
        console.error(`grok-line: contact lookup failed: ${(e as Error).message}`);
      }
    }
    for (let i = 0; i < groups.length; i += 100) {
      try {
        const { chats } = await base.talk.getChats({ chatMids: groups.slice(i, i + 100) });
        for (const c of chats ?? []) if (c?.chatMid) this.#set(c.chatMid, c.chatName || c.chatMid);
      } catch (e) {
        console.error(`grok-line: chat lookup failed: ${(e as Error).message}`);
      }
    }
    const me = base.profile;
    if (me?.mid) this.#set(me.mid, me.displayName);
    this.save();
  }

  #set(mid: string, name: string) {
    if (this.#map[mid] !== name) {
      this.#map[mid] = name;
      this.#dirty = true;
    }
  }

  save() {
    if (!this.#dirty) return;
    ensurePrivateDir(CACHE_DIR);
    Deno.writeTextFileSync(NAMES_PATH, JSON.stringify(this.#map), { mode: 0o600 });
    this.#dirty = false;
  }
}

// deno-lint-ignore no-explicit-any
type RawMessage = any;

export interface ShapedMessage {
  id: string;
  chat: string;
  chat_type: MidKind;
  chat_name: string | null;
  from: string;
  from_name: string | null;
  own: boolean;
  kind: string;
  text: string | null;
  time: string | null;
  decrypt_error?: string;
}

/** The conversation a message belongs to: the group, or the other person in a 1:1. */
export function chatOf(m: RawMessage, myMid: string): string {
  if (midKind(m.to) !== "user") return m.to;
  return m.from === myMid ? m.to : m.from;
}

export function kindOf(m: RawMessage): string {
  const t = m.contentType;
  if (t === undefined || t === null || t === 0 || t === "NONE") return "text";
  return String(t).toLowerCase();
}

export async function decrypt(client: Client, m: RawMessage): Promise<{ msg: RawMessage; error?: string }> {
  if (!m?.chunks?.length) return { msg: m };
  try {
    return { msg: await client.base.e2ee.decryptE2EEMessage(m) };
  } catch (e) {
    return { msg: m, error: (e as Error).message };
  }
}

export function shape(m: RawMessage, myMid: string, names: Names, error?: string): ShapedMessage {
  const chat = chatOf(m, myMid);
  const kind = kindOf(m);
  const out: ShapedMessage = {
    id: String(m.id),
    chat,
    chat_type: midKind(chat),
    chat_name: names.get(chat) ?? null,
    from: m.from,
    from_name: names.get(m.from) ?? null,
    own: m.from === myMid,
    kind,
    text: kind === "text" ? (m.text ?? null) : (m.text || m.contentPreview || null),
    time: iso(m.createdTime || m.deliveredTime),
  };
  if (error) out.decrypt_error = error;
  return out;
}
