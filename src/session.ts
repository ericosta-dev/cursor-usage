import { execFile } from 'child_process';
import * as path from 'path';

const TOKEN_KEY = 'cursorAuth/accessToken';

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

export async function loadSession(dbPath: string): Promise<Session | undefined> {
  const jwt = await readAccessToken(dbPath);
  if (!jwt) return undefined;
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString());
  const userId = String(payload.sub ?? '').split('|')[1];
  if (!userId) return undefined;
  return {
    cookie: `WorkosCursorSessionToken=${userId}%3A%3A${jwt}`,
    expiresAt: Number(payload.exp ?? 0) * 1000,
  };
}
