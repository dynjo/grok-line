// Session plumbing: device choice, private storage, and a logged-in Client.
import { BaseClient, type Device } from "@evex/linejs/base";
import { Client } from "@evex/linejs";
import { FileStorage } from "@evex/linejs/storage";

const HOME = Deno.env.get("HOME") ?? ".";
export const CONFIG_DIR = Deno.env.get("GROK_LINE_CONFIG") ??
  `${HOME}/.config/grok-line`;
export const CACHE_DIR = `${HOME}/.cache/grok-line`;
export const STORAGE_PATH = `${CONFIG_DIR}/storage.json`;
export const SETTINGS_PATH = `${CONFIG_DIR}/settings.json`;
export const ALLOWLIST_PATH = `${CONFIG_DIR}/allowlist`;

export interface Settings {
  device: Device;
  /** App version to present. Defaults to the installed LINE for Mac version. */
  version?: string;
}

const LINE_PLIST = "/Applications/LINE.app/Contents/Info.plist";

/** Version of the installed LINE for Mac, so a DESKTOPMAC session matches the real client. */
export function installedLineVersion(): string | undefined {
  try {
    const plist = Deno.readTextFileSync(LINE_PLIST);
    return plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  } catch {
    return undefined;
  }
}

export function versionFor(s: Settings): string | undefined {
  return s.version ?? (s.device === "DESKTOPMAC" ? installedLineVersion() : undefined);
}

const DEFAULT_SETTINGS: Settings = { device: "DESKTOPMAC" };

export function ensurePrivateDir(path: string) {
  Deno.mkdirSync(path, { recursive: true, mode: 0o700 });
  Deno.chmodSync(path, 0o700);
}

export function readSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(Deno.readTextFileSync(SETTINGS_PATH)) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeSettings(s: Settings) {
  ensurePrivateDir(CONFIG_DIR);
  Deno.writeTextFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
}

// storage.json holds the auth token, refresh token, and E2EE private keys.
// It never leaves this Mac and stays 0600.
export function openStorage(): FileStorage {
  ensurePrivateDir(CONFIG_DIR);
  const storage = new FileStorage(STORAGE_PATH);
  Deno.chmodSync(STORAGE_PATH, 0o600);
  return storage;
}

export function newBase(settings: Settings, storage: FileStorage): BaseClient {
  const base = new BaseClient({ device: settings.device, version: versionFor(settings), storage });
  // Token refreshes arrive as events. Persist every one so the next run reuses it.
  base.on("update:authtoken", (t: string) => void storage.set(".auth", t));
  return base;
}

export class NotLoggedIn extends Error {}

/** Returns a ready Client from the cached token, or throws NotLoggedIn. */
export async function connect(): Promise<Client> {
  const settings = readSettings();
  const storage = openStorage();
  const token = await storage.get(".auth");
  if (typeof token !== "string" || !token) throw new NotLoggedIn("no cached session");
  const base = newBase(settings, storage);
  await base.loginProcess.login({ authToken: token });
  return new Client(base);
}
