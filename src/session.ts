import { execFile } from 'child_process';
import { createDecipheriv, pbkdf2Sync } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

const TOKEN_KEY = 'cursorAuth/accessToken';

// Recent Cursor versions encrypt the token with Electron's safeStorage when the OS has a
// secrets manager: this prefix, then the base64 of Chromium's OSCrypt ciphertext.
const ENCRYPTED_PREFIX = 'cursor-safe-storage:v1:';

// Where the safeStorage key is remembered (the extension's SecretStorage), so the OS asks for
// access to it only once. vscode.SecretStorage fits this shape.
export interface KeyCache {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export interface Session {
  cookie: string;
  expiresAt: number;
}

// node:sqlite ships with Cursor's runtime (Node 22.5+). It reads only the pages it
// needs, unlike sql.js, which loads the whole multi-GB state.vscdb into memory.
const sqlite: typeof import('node:sqlite') | undefined = (() => {
  try {
    return require('node:sqlite');
  } catch {
    return undefined;
  }
})();

// globalStorageUri is <user>/globalStorage/<publisher.name>; state.vscdb sits beside it.
export function stateDbPath(globalStoragePath: string): string {
  return path.join(path.dirname(globalStoragePath), 'state.vscdb');
}

async function readAccessToken(dbPath: string): Promise<string | undefined> {
  if (sqlite) {
    // readOnly exists since Node 22.12; the bundled @types/node predates it.
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true } as object);
    try {
      const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(TOKEN_KEY) as { value?: unknown } | undefined;
      return row ? String(row.value) : undefined;
    } finally {
      db.close();
    }
  }
  // Older runtimes: fall back to the sqlite3 CLI (bundled with macOS and most Linux distros).
  return new Promise((resolve, reject) => {
    execFile('sqlite3', ['-readonly', dbPath, `SELECT value FROM ItemTable WHERE key = '${TOKEN_KEY}'`],
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim() || undefined)));
  });
}

// Chat titles live in Cursor's local DB under composerData:<conversationId>. Each lookup hits
// the key index, and json_extract keeps the (often large) conversation JSON inside SQLite.
export function readConversationTitles(dbPath: string, ids: string[]): Record<string, string> {
  const titles: Record<string, string> = {};
  if (!sqlite || !ids.length) return titles;
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true } as object);
  try {
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const rows = db
        .prepare(`SELECT key, json_extract(value, '$.name') AS name FROM cursorDiskKV WHERE key IN (${chunk.map(() => '?').join(',')})`)
        .all(...chunk.map((id) => `composerData:${id}`)) as { key: string; name?: string | null }[];
      for (const r of rows) if (r.name) titles[r.key.slice('composerData:'.length)] = String(r.name);
    }
  } finally {
    db.close();
  }
  return titles;
}

// Keys in flight or already read in this extension host, by ciphertext version ("v10", "v11").
const keys = new Map<string, Promise<Buffer>>();

async function decryptToken(value: string, dbPath: string, cache?: KeyCache): Promise<string> {
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value;
  const data = Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64');
  const version = data.subarray(0, 3).toString();
  const cacheKey = `safeStorageKey.${version}`;
  if (!keys.has(version)) {
    keys.set(version, (async () => {
      const cached = await cache?.get(cacheKey);
      if (cached) return Buffer.from(cached, 'base64');
      const key = await readSafeStorageKey(version, dbPath);
      void cache?.store(cacheKey, key.toString('base64'));
      return key;
    })());
  }
  try {
    return decrypt(data, await keys.get(version)!);
  } catch (err) {
    // A stale cached key (Cursor reinstalled, keychain reset): drop it so the next try asks the OS.
    keys.delete(version);
    void cache?.delete(cacheKey);
    throw new Error(`Couldn't decrypt the Cursor sign-in token: ${err instanceof Error ? err.message : err}`);
  }
}

function decrypt(data: Buffer, key: Buffer): string {
  let plain: string;
  if (process.platform === 'win32') {
    // "v10" + 12-byte nonce + AES-256-GCM ciphertext + 16-byte tag.
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(3, 15));
    decipher.setAuthTag(data.subarray(data.length - 16));
    plain = Buffer.concat([decipher.update(data.subarray(15, data.length - 16)), decipher.final()]).toString();
  } else {
    // "v10"/"v11" + AES-128-CBC with a fixed IV of 16 spaces.
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
    plain = Buffer.concat([decipher.update(data.subarray(3)), decipher.final()]).toString();
  }
  if (plain.split('.').length !== 3) throw new Error('wrong key');
  return plain;
}

// The OSCrypt key, as Chromium derives it on each platform.
async function readSafeStorageKey(version: string, dbPath: string): Promise<Buffer> {
  if (process.platform === 'darwin') {
    // macOS asks the user to let `security` read Cursor's keychain item the first time.
    const { stdout } = await run('security', ['find-generic-password', '-w', '-s', 'Cursor Safe Storage', '-a', 'Cursor Key']);
    return pbkdf2Sync(stdout.trim(), 'saltysalt', 1003, 16, 'sha1');
  }
  if (process.platform === 'win32') {
    // The AES key sits DPAPI-protected in "Local State", next to the User folder.
    const localState = path.resolve(dbPath, '..', '..', '..', 'Local State');
    const encrypted: string = JSON.parse(await fs.readFile(localState, 'utf8')).os_crypt.encrypted_key;
    const dpapi = Buffer.from(encrypted, 'base64').subarray('DPAPI'.length).toString('base64');
    const script = 'Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::'
      + `Unprotect([Convert]::FromBase64String('${dpapi}'), $null, 'CurrentUser'))`;
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    return Buffer.from(stdout.trim(), 'base64');
  }
  // Linux: "v10" uses a fixed password, "v11" one kept in the Secret Service (libsecret).
  if (version === 'v10') return pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');
  for (const application of ['Cursor', 'cursor']) {
    const password = await run('secret-tool', ['lookup', 'application', application]).then((r) => r.stdout.trim(), () => '');
    if (password) return pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1');
  }
  throw new Error('safeStorage key not found in the Secret Service');
}

export async function loadSession(dbPath: string, cache?: KeyCache): Promise<Session | undefined> {
  const stored = await readAccessToken(dbPath);
  if (!stored) return undefined;
  const jwt = await decryptToken(stored, dbPath, cache);
  const [, body] = jwt.split('.');
  if (!body) throw new Error('The Cursor sign-in token has an unrecognized format');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  const userId = String(payload.sub ?? '').split('|')[1];
  if (!userId) return undefined;
  return {
    cookie: `WorkosCursorSessionToken=${userId}%3A%3A${jwt}`,
    expiresAt: Number(payload.exp ?? 0) * 1000,
  };
}
