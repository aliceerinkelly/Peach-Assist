/**
 * Entry point for the Android build.
 *
 * The server is the same code the desktop runs. The only things this file does
 * are the things a phone cannot be told by whoever installs it: where private
 * storage is, and a session secret that survives a restart.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.argv[2] || path.join(here, 'data');

fs.mkdirSync(dataDir, { recursive: true });
process.env.DATA_DIR = dataDir;

if (!process.env.SESSION_SECRET) {
  const secretFile = path.join(dataDir, 'session.secret');
  try {
    process.env.SESSION_SECRET = fs.readFileSync(secretFile, 'utf8').trim();
  } catch {
    const fresh = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretFile, fresh);
    process.env.SESSION_SECRET = fresh;
  }
}

// The phone build ships ready to use: a known operator, and setup treated as
// complete, so nobody has to read a password out of a console that a phone does
// not have. Change it in Admin after signing in, before letting the internet in.
process.env.OP_USERNAME = process.env.OP_USERNAME || 'admin';
process.env.OP_PASSWORD = process.env.OP_PASSWORD || 'peach123';
process.env.DEFAULT_ADMIN = '1';

// The port is the panel's to decide. Pinning PORT here would make the server
// ignore the operator's own setting, which is exactly what it did at first.

// Keep a log on the phone. Without a USB cable logcat is unreachable, and a
// blank screen tells nobody why the server refused to start.
const logFile = path.join(dataDir, 'server.log');
try {
  if (fs.existsSync(logFile) && fs.statSync(logFile).size > 400_000) fs.truncateSync(logFile, 0);
} catch { /* a log we cannot trim is not a reason to stop */ }
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function (chunk, ...rest) {
  try { fs.appendFileSync(logFile, typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()); } catch { /* ignore */ }
  return realWrite(chunk, ...rest);
};

console.log('Peach Messenger on Android');
console.log('  data: ' + dataDir);
console.log('  runtime: Node ' + process.version + (process.versions.mobile ? ' (mobile ' + process.versions.mobile + ')' : ''));

await import('./dist/server.js');
