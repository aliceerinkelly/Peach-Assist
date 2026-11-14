import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { scryptHash } from './util.js';

/**
 * Build a clean copy of this install, on the device that is running it.
 *
 * The state save keeps everything, this machine included. This is the opposite:
 * the same program with a fresh database holding one account, admin/peach123,
 * and nothing else — no messages, no users, no DDNS hostname, no certificates.
 * It is meant to be downloaded and handed on, so anything that identifies the
 * person running this install has no business being in it.
 */

export interface CleanPackage {
  file: string;
  bytes: number;
  files: number;
  bankedOn: string;
}

/* ---------------- zip, written by hand so there is nothing to install ---------------- */

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** A zip with deflated entries. Enough of the format for any unzip tool. */
export function writeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const deflated = zlib.deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + deflated.length;
  }

  const centralBlock = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBlock.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBlock, end]);
}

/* ---------------- collecting files ---------------- */

function walk(dir: string, base: string, out: ZipEntry[], skip: (name: string) => boolean): void {
  if (!fs.existsSync(dir)) return;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip(item.name)) continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) walk(full, base, out, skip);
    else if (item.isFile()) out.push({ name: path.relative(base, full), data: fs.readFileSync(full) });
  }
}


const README = `Peach Assist - clean copy

This is a fresh install of the program, built from a working one and emptied of
anything belonging to whoever built it: no accounts except the one below, no
messages, no hostnames, no certificates.

Sign in with:
  username: admin
  password: peach123

Change that password immediately after the first sign-in.

To run it:
  Windows:  double-click start.bat
  anywhere: node --experimental-sqlite dist/server.js

Needs Node 22 or newer. The server listens on port 3000 unless PORT says
otherwise, and keeps its database in ./data.
`;

const START_BAT = `@echo off\r\nrem Runs Peach Assist from this folder.\r\nnode --experimental-sqlite dist\\server.js\r\npause\r\n`;

/* ---------------- the package ---------------- */

export async function buildCleanPackage(appRoot: string, dataDir: string, stamp: string): Promise<CleanPackage> {
  const exportsDir = path.join(dataDir, 'exports');
  fs.mkdirSync(exportsDir, { recursive: true });
  const staging = path.join(exportsDir, '.build-' + stamp);
  fs.rmSync(staging, { recursive: true, force: true });
  const freshData = path.join(staging, 'data');
  fs.mkdirSync(freshData, { recursive: true });
  const dbFile = path.join(freshData, 'app.db');

  // Take a consistent copy of the live database, then empty it, rather than
  // starting a second server to build one. A phone cannot spawn a node process
  // (the runtime is a library, not an executable), and starting a whole server
  // just to make an empty database was a heavy way to do a copy anyway.
  const live = new DatabaseSync(path.join(dataDir, 'app.db'));
  try {
    live.exec(`VACUUM INTO '${dbFile.replace(/'/g, "''")}'`);
  } finally {
    live.close();
  }

  const db = new DatabaseSync(dbFile);
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all() as { name: string }[]).map((row) => row.name);

    // Keep the shape, drop the contents: the schema is what the program needs,
    // the rows are what belongs to whoever is running this install.
    for (const table of tables) {
      if (table === 'users' || table === 'settings') continue;
      db.exec(`DELETE FROM "${table}"`);
    }

    const operator = db.prepare('SELECT id FROM users WHERE is_operator = 1 LIMIT 1').get() as { id: string } | undefined;
    if (!operator) throw new Error('this install has no operator account to carry over');
    db.prepare('DELETE FROM users WHERE id <> ?').run(operator.id);
    db.prepare(
      'UPDATE users SET display_name = ?, username = ?, password_hash = ?, role = ?, is_operator = 1, disabled = 0 WHERE id = ?',
    ).run('Admin', 'admin', scryptHash('peach123'), 'admin', operator.id);

    db.prepare('DELETE FROM settings').run();
    const ready: [string, string][] = [
      ['account_ready', '1'],
      ['setup_done', '1'],
      ['reopen_setup', '0'],
      ['default_admin_applied', '1'],
    ];
    for (const [key, value] of ready) {
      db.prepare('INSERT INTO settings(key, value) VALUES(?, ?)').run(key, value);
    }

    // Check what was actually produced, not what was intended.
    const users = db.prepare('SELECT username FROM users').all() as { username: string | null }[];
    if (users.length !== 1 || users[0].username !== 'admin') {
      throw new Error(`the clean database has ${users.length} accounts, refusing to package it`);
    }
    for (const table of ['messages', 'conversations', 'audit_log']) {
      if (!tables.includes(table)) continue;
      const count = (db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number }).c;
      if (count > 0) throw new Error(`the clean database still has ${count} rows in ${table}, refusing to package it`);
    }
  } finally {
    db.close();
  }
  for (const leftover of ['app.db-wal', 'app.db-shm']) {
    fs.rmSync(path.join(freshData, leftover), { force: true });
  }

  const entries: ZipEntry[] = [];
  const skipBackup = (name: string) => name === 'backups' || name.endsWith('.log');
  walk(path.join(appRoot, 'dist'), path.join(appRoot), entries, skipBackup);
  walk(path.join(appRoot, 'public'), path.join(appRoot), entries, skipBackup);
  walk(path.join(appRoot, 'node_modules', 'ws'), path.join(appRoot), entries, () => false);
  for (const file of ['main.js', 'package.json', 'package-lock.json']) {
    const full = path.join(appRoot, file);
    if (fs.existsSync(full)) entries.push({ name: file, data: fs.readFileSync(full) });
  }
  entries.push({ name: path.join('data', 'app.db'), data: fs.readFileSync(dbFile) });
  entries.push({ name: 'README.txt', data: Buffer.from(README, 'utf8') });
  entries.push({ name: 'start.bat', data: Buffer.from(START_BAT, 'utf8') });

  const zip = writeZip(entries);
  const name = `PeachMessenger-clean-${stamp}.zip`;
  const file = path.join(exportsDir, name);
  fs.writeFileSync(file, zip);
  fs.rmSync(staging, { recursive: true, force: true });

  return { file, bytes: zip.length, files: entries.length, bankedOn: stamp };
}
