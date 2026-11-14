import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openPort, detectVpn, vpnForwardedPort, renewVpnMapping, removeUpnpMapping, upnpProbe, defaultGateway, gatewayCandidates, routerCheck, type MappingResult } from './portmap.js';
import { fileURLToPath } from 'node:url';
import { reverse as reverseDns } from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';

import { db, seed, businessSpaceId, DATA_DIR, UPLOAD_DIR, getSetting, setSetting, audit } from './db.js';
import { buildCleanPackage } from './cleanPackage.js';
import { onAndroid, platformLabel, platformNote, portProblem } from './platform.js';
import {
  id, now, newToken, sha256, hmac, safeEqual, scryptHash, scryptVerify,
  parseCookies, setCookie, clearCookie, json, readBody, readJson, clientIp,
} from './util.js';
import { sendMail, sendReplyNotification, suppress, stopToken } from './mail.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
let PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 3000;
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

/* ------------------------------------------------------------------ */
/* modules: whole features that can be loaded and unloaded (admin)     */
/* ------------------------------------------------------------------ */

type ModuleDef = { id: string; label: string; hint: string; routes: string[]; suffix?: string };

const MODULES: ModuleDef[] = [
  { id: 'search', label: 'Search history', hint: 'The magnifier: search names, messages and attachments.', routes: ['/api/search'] },
  { id: 'archive', label: 'Archived chats', hint: 'The box icon and the archive tab that hides finished chats.', routes: [], suffix: '/archive' },
  { id: 'notes', label: 'Sticky notes', hint: 'Personal notes kept on the rail.', routes: ['/api/notes'] },
  { id: 'reminders', label: 'Reminders', hint: 'One-off nudges you set for yourself.', routes: ['/api/reminders'] },
  { id: 'tasks', label: 'Tasks', hint: 'Assignable to-do items with due dates.', routes: ['/api/tasks'] },
  { id: 'wall', label: 'Peach Wall', hint: 'A shared wall: posts, replies and likes.', routes: ['/api/wall'] },
  { id: 'calendar', label: 'Calendar', hint: 'Meetings, the calendar grid and the iCal feed.', routes: ['/api/events', '/api/calendar'] },
  { id: 'leave', label: 'Time off', hint: 'Leave requests, who is off and public holidays.', routes: ['/api/leave'] },
  { id: 'drive', label: 'Drive', hint: 'Shared and personal files with versions and sharing.', routes: ['/api/drive'] },
  { id: 'mail', label: 'Mail', hint: 'Internal mail with attachments.', routes: ['/api/mail'] },
  { id: 'helpdesk', label: 'Helpdesk', hint: 'Support tickets, shown to administrators only.', routes: ['/api/tickets'] },
  { id: 'signup', label: 'Sign-up', hint: 'Lets people create their own account from the sign-in page. Off unless you turn it on.', routes: ['/api/signup'], suffix: '/signup' },
  { id: 'invite', label: 'Invites', hint: 'Invited guests joining a room with a link. Off unless you turn it on.', routes: [] },
];

/** Modules the administrator has switched off. */
function disabledModules(): Set<string> {
  return new Set(getSetting('modules_off', '').split(',').map((s) => s.trim()).filter(Boolean));
}

/* ------------------------------------------------------------------ */
/* first-run setup                                                     */
/* ------------------------------------------------------------------ */

type Audience = 'personal' | 'business';

function audience(): Audience {
  return getSetting('audience', 'business') === 'personal' ? 'personal' : 'business';
}

/* ---------- work hours ---------- */
/**
 * Opening times. Outside them the app serves a closed sign instead of pages and
 * the phone releases its wake lock, which is what actually stops it running hot.
 */
function workHours(): { on: boolean; from: string; to: string; days: string; note: string } {
  const hm = (v: string, fallback: string) => (/^\d{2}:\d{2}$/.test(v) ? v : fallback);
  return {
    on: getSetting('work_hours_on', '0') === '1',
    from: hm(getSetting('work_hours_from', '09:00'), '09:00'),
    to: hm(getSetting('work_hours_to', '17:00'), '17:00'),
    days: getSetting('work_hours_days', '1,2,3,4,5'),
    note: getSetting('work_hours_note', ''),
  };
}

function dayList(days: string): number[] {
  return [...new Set(days.split(',').map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b);
}

/** Open right now? A range that ends before it starts (22:00 to 06:00) spans midnight. */
function workOpen(at = new Date()): boolean {
  const h = workHours();
  if (!h.on) return true;
  if (!dayList(h.days).includes(at.getDay())) return false;
  const mins = at.getHours() * 60 + at.getMinutes();
  const [fh, fm] = h.from.split(':').map(Number);
  const [th, tm] = h.to.split(':').map(Number);
  const from = fh * 60 + fm;
  const to = th * 60 + tm;
  if (from === to) return true;
  return from < to ? (mins >= from && mins < to) : (mins >= from || mins < to);
}

function prettyTime(hm: string): string {
  const [h, m] = hm.split(':').map(Number);
  const suffix = h < 12 ? 'am' : 'pm';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return hour + (m ? ':' + String(m).padStart(2, '0') : '') + ' ' + suffix;
}

function scheduleText(): string {
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const days = dayList(workHours().days);
  if (days.length === 7) return 'every day';
  if (days.length === 5 && days.join(',') === '1,2,3,4,5') return 'Monday to Friday';
  if (days.length === 0) return 'no days yet';
  return days.map((d) => names[d]).join(', ');
}

/** The one page a visitor sees when the business is shut. Self-contained on purpose:
 *  no assets to fetch, so it works even while everything else is closed. */
function closedPage(): string {
  const h = workHours();
  const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
  const note = h.note ? `<p class="note">${esc(h.note)}</p>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Closed \u00b7 Peach Assist</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font: 15px/1.5 -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    background: radial-gradient(120% 120% at 50% 0%, #eff4fd 0%, #e2e9f5 100%);
    color: #22303f;
  }
  .card {
    position: relative; max-width: 440px; width: 100%; text-align: center;
    background: #fff; border: 1px solid #e2e8f0; border-radius: 20px;
    padding: 30px 26px 24px; box-shadow: 0 10px 30px rgba(28, 45, 66, .12);
  }
  .badge {
    width: 52px; height: 52px; margin: 0 auto 14px; border-radius: 16px;
    display: grid; place-items: center; font-weight: 800; font-size: 22px; color: #fff;
    background: linear-gradient(180deg, #df8f7f, #c96f5d);
  }
  h1 { font-size: 22px; margin: 0 0 6px; }
  .lead { margin: 0 0 14px; color: #47546a; }
  .hours { margin: 0; font-size: 15px; }
  .hours strong { color: #22303f; }
  .note {
    margin: 16px 0 0; padding: 12px 14px; border-radius: 12px; text-align: left;
    background: #f7f9fc; border: 1px solid #e2e8f0; color: #3a4759; font-size: 14px;
  }
  .foot { margin: 18px 0 0; font-size: 12.5px; color: #7b8794; }
  a { color: #2f6fe4; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style></head>
<body><main class="card">
  <div class="badge">M</div>
  <h1>Thanks for coming</h1>
  <p class="lead">We're closed at the moment.</p>
  <p class="hours">We're open <strong>${esc(scheduleText())}</strong>,
    ${esc(prettyTime(h.from))} to ${esc(prettyTime(h.to))}.</p>
  ${note}
  <p class="foot">Anything you send will be waiting when we open.</p>
  <p class="foot"><a href="/admin">Administrators</a></p>
</main></body></html>`;
}

/* ---------- call relay (Cloudflare TURN) ---------- */
let turnCache: { at: number; servers: any[] } | null = null;

function turnConfigured(): boolean {
  return !!getSetting('turn_key_id', '') && !!getSetting('turn_api_token', '');
}

/**
 * Short-lived TURN credentials, minted here so the long-lived key never reaches a
 * browser. Without a relay, calls only connect when both sides can reach each
 * other directly, which mobile networks rarely allow.
 */
async function turnIceServers(): Promise<any[]> {
  if (!turnConfigured()) return [];
  if (turnCache && Date.now() - turnCache.at < 30 * 60 * 1000) return turnCache.servers;
  const keyId = getSetting('turn_key_id', '');
  const token = getSetting('turn_api_token', '');
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 3600 }),
      signal: AbortSignal.timeout(7000),
    },
  );
  if (!res.ok) throw new Error('TURN ' + res.status);
  const data: any = await res.json();
  // Current API returns a list of servers; older deployments return one object.
  const raw: any[] = Array.isArray(data?.iceServers)
    ? data.iceServers
    : data?.iceServers ? [data.iceServers] : [];
  const servers = raw.map((s) => {
    // Port 53 is blocked by browsers and would only stall the call.
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls])
      .filter((u: string) => !!u && !/:53(\D|$)/.test(u));
    return s.username ? { urls, username: s.username, credential: s.credential } : { urls };
  }).filter((s) => s.urls.length);
  turnCache = { at: Date.now(), servers };
  return servers;
}

/** What still answers while the business is closed. Admin sign-in is kept open so
 *  the hours themselves can be changed from outside them. */
function allowedWhileClosed(p: string): boolean {
  if (p === '/api/app-state' || p === '/closed' || p === '/favicon.ico') return true;
  if (p === '/login' || p === '/api/login' || p === '/api/logout' || p === '/api/me') return true;
  if (p === '/admin' || p.startsWith('/admin/') || p.startsWith('/api/admin')) return true;
  if (p === '/style.css' || p === '/theme.js' || p.startsWith('/vendor/')) return true;
  return false;
}

/**
 * The same feature, described for the household or for the office.
 * Anything not listed here keeps its own label.
 */
const AUDIENCE_WORDING: Record<Audience, Record<string, { label?: string; hint?: string }>> = {
  business: {
    leave: { label: 'Time off', hint: 'Leave requests, who is off and public holidays.' },
    calendar: { label: 'Calendar', hint: 'Meetings, the calendar grid and the iCal feed.' },
    tasks: { label: 'Tasks', hint: 'Assignable to-do items with due dates.' },
    helpdesk: { label: 'Helpdesk', hint: 'Support tickets, shown to administrators only.' },
    wall: { label: 'Peach Wall', hint: 'A shared wall: posts, replies and likes.' },
    mail: { label: 'Mail', hint: 'Internal mail with attachments.' },
  },
  personal: {
    leave: { label: 'Away days', hint: 'Mark days someone is away, and see the holidays.' },
    calendar: { label: 'Plans', hint: 'Dates and plans, with a feed other calendars can follow.' },
    tasks: { label: 'To-dos', hint: 'Little jobs, each with a day attached.' },
    helpdesk: { label: 'Requests', hint: 'Ask whoever runs this server for a hand.' },
    wall: { label: 'The wall', hint: 'A noticeboard: posts, replies and likes.' },
    mail: { label: 'Letters', hint: 'Longer messages, kept like mail.' },
    drive: { label: 'Shared files', hint: 'Photos and documents, with versions and sharing.' },
  },
};

function wordingFor(a: Audience, id: string): { label: string; hint: string } {
  const base = MODULES.find((m) => m.id === id);
  const over = AUDIENCE_WORDING[a][id] || {};
  return { label: over.label || base?.label || id, hint: over.hint || base?.hint || '' };
}

function moduleWording(id: string): { label: string; hint: string } {
  return wordingFor(audience(), id);
}

type Preset = {
  id: string;
  audience: Audience;
  label: string;
  hint: string;
  /** Modules this purpose does not need. */
  off: string[];
  theme?: string;
};

const PRESETS: Preset[] = [
  { id: 'family', audience: 'personal', label: 'Family and friends',
    hint: 'Chat, photos, plans and a noticeboard. Nothing office-shaped.',
    off: ['leave', 'helpdesk', 'mail'], theme: 'sunset' },
  { id: 'household', audience: 'personal', label: 'Housemates',
    hint: 'Who is away, what needs doing, and where the documents live.',
    off: ['helpdesk', 'mail'], theme: 'forest' },
  { id: 'club', audience: 'personal', label: 'Club or hobby group',
    hint: 'Dates, notices, shared files and votes.',
    off: ['leave', 'helpdesk', 'mail', 'tasks'], theme: 'violet' },
  { id: 'office', audience: 'business', label: 'General office',
    hint: 'Chat, mail, files, tasks, meetings and time off.',
    off: [], theme: 'blue' },
  { id: 'support', audience: 'business', label: 'Support desk',
    hint: 'Tickets first: helpdesk, quick replies, clients and files.',
    off: ['leave', 'calendar', 'wall'], theme: 'forest' },
  { id: 'coding', audience: 'business', label: 'Group coding',
    hint: 'Rooms, shared files, tasks and a wall for decisions.',
    off: ['leave', 'helpdesk', 'mail'], theme: 'violet' },
  { id: 'clients', audience: 'business', label: 'Client work',
    hint: 'Client threads, files, meetings and mail in one place.',
    off: ['leave', 'wall'], theme: 'blue' },
];

/**
 * Existing installs predate this wizard, so they are never dragged through it:
 * anything with real people or messages in it counts as already set up.
 */
/**
 * True while there is still nobody who can sign in. A fresh server seeds an
 * operator row with no password, so "exists" is not the same as "can log in"
 * — and the wizard's last step is the thing that sets that password.
 */
function noOperatorYet(): boolean {
  // 'account_ready' is set only when somebody has chosen a password through the
  // wizard. A seeded row with a random password printed to a console nobody can
  // see is not a working account, and must not be treated as one.
  if (getSetting('account_ready', '') !== '1') return true;
  const op = db.prepare("SELECT password_hash FROM users WHERE is_operator = 1 LIMIT 1").get() as any;
  return !op || !String(op.password_hash || '').trim();
}

function setupDone(): boolean {
  // Asked for by a server that got stuck half-configured; it lasts only until
  // somebody actually sets a password.
  if (getSetting('reopen_setup', '') === '1' && noOperatorYet()) return false;
  if (getSetting('setup_done', '') === '1') return true;
  try {
    const users = Number((db.prepare('SELECT COUNT(*) AS n FROM users').get() as any)?.n) || 0;
    const msgs = Number((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as any)?.n) || 0;
    return users > 1 || msgs > 0;
  } catch {
    return true;
  }
}

function modulesState(): Record<string, boolean> {
  const off = disabledModules();
  const out: Record<string, boolean> = {};
  for (const m of MODULES) out[m.id] = !off.has(m.id);
  return out;
}

function moduleEnabled(id: string): boolean {
  return !disabledModules().has(id);
}

/* ------------------------------------------------------------------ */
/* typed commands: never advertised; only the panel lists them         */
/* ------------------------------------------------------------------ */

type CommandDef = { id: string; usage: string; hint: string; adminOnly?: boolean };

const COMMANDS: CommandDef[] = [
  { id: 'nick', usage: '/nick new name', hint: 'Change your own display name.' },
  { id: 'join', usage: '/join room name', hint: 'Open a shared room, creating it if it does not exist.' },
  { id: 'list', usage: '/list', hint: 'List the shared rooms and your groups.' },
  { id: 'msg', usage: '/msg name message', hint: 'Open a direct chat and send a message.' },
  { id: 'me', usage: '/me action', hint: 'Send an action line to the chat you have open.' },
  { id: 'whois', usage: '/whois name', hint: 'Show a colleague\u2019s department, presence and status.' },
  { id: 'invite', usage: '/invite name', hint: 'Add a colleague to the group you have open.' },
  { id: 'topic', usage: '/topic new topic', hint: 'Rename the shared room you have open.', adminOnly: true },
  { id: 'part', usage: '/part', hint: 'Leave the group you have open.' },
  { id: 'help', usage: '/help', hint: 'List the commands that are switched on.', adminOnly: true },
];

function disabledCommands(): Set<string> {
  return new Set(getSetting('irc_off', '').split(',').map((s) => s.trim()).filter(Boolean));
}

function commandState(): Record<string, boolean> {
  const off = disabledCommands();
  const out: Record<string, boolean> = {};
  for (const c of COMMANDS) out[c.id] = !off.has(c.id);
  return out;
}

function commandOn(id: string): boolean {
  return !disabledCommands().has(id);
}

/** Which module owns a request path, so an unloaded one can answer as absent. */
function moduleFor(p: string): ModuleDef | null {
  for (const m of MODULES) {
    for (const r of m.routes) {
      if (p === r || p.startsWith(r + '/') || p.startsWith(r + '.')) return m;
    }
    if (m.suffix && p.endsWith(m.suffix)) return m;
  }
  return null;
}

/** Every non-internal IPv4 address, so a phone on the same network can reach us. */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

// A public origin (tunnel or domain) wins; otherwise prefer a LAN address over
// localhost, because a link containing localhost is useless on another device.
let MAPPED_URL = '';
let MAPPING: MappingResult | null = null;
let VPN_MAPPING: { gateway: string; external: number } | null = null;

let BASE_URL =
  process.env.PUBLIC_URL ||
  process.env.BASE_URL ||
  `http://${lanAddresses()[0] || 'localhost'}:${PORT}`;

/** Public origin once the router mapping succeeded, else the configured base. */
/**
 * ProtonVPN hands out a different forwarded port each session, so a stored link
 * must never dictate the port: the live mapping always wins.
 */
function withLivePort(url: string): string {
  if (!url || !VPN_MAPPING || !VPN_MAPPING.external) return url;
  try {
    const u = new URL(url);
    const live = String(VPN_MAPPING.external);
    if (u.port === live) return url;
    u.port = live;
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

function publicBase(): string {
  const custom = getSetting('public_url', '');
  if (custom) return withLivePort(custom);
  const named = ddnsLink();
  if (named) return withLivePort(named);
  return MAPPED_URL || BASE_URL;
}

/** Link and URL origin for a request: whatever host the browser actually used. */
function originOf(req: any): string {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : publicBase();
}
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

const SESS_COOKIE = 'om_sess';
const CLIENT_COOKIE = 'om_client';
const SESSION_TTL = 1000 * 60 * 60 * 24 * 14;

/* Sign-ins are recorded silently: who, from which address, and the name that
   address resolves to. Nothing is shown to the person signing in. */
db.exec(`CREATE TABLE IF NOT EXISTS signin_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  user_name TEXT,
  ip TEXT,
  host TEXT,
  agent TEXT,
  created_at INTEGER NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS ix_signin_at ON signin_log(created_at DESC)');

/* Blocks: a name, an address, a DNS name, or any combination of the three.
   Only the fields given have to match, so a name alone refuses that account
   everywhere and a name plus address refuses it from that address only. */
db.exec(`CREATE TABLE IF NOT EXISTS signin_blocks (
  id TEXT PRIMARY KEY,
  ip TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
)`);

type BlockRow = { id: string; ip: string; host: string; name: string; note: string; created_by: string; created_at: number };
let blockCache: { at: number; rows: BlockRow[] } | null = null;

function blockList(): BlockRow[] {
  if (blockCache && Date.now() - blockCache.at < 5000) return blockCache.rows;
  const rows = db.prepare('SELECT id, ip, host, name, note, created_by, created_at FROM signin_blocks').all() as BlockRow[];
  blockCache = { at: Date.now(), rows };
  return rows;
}

function blockForIp(ip: string): BlockRow | null {
  return blockList().find((b) => b.ip && b.ip.split(',').map((x) => x.trim()).includes(ip)) || null;
}

function blockForName(...names: (string | null | undefined)[]): BlockRow | null {
  const wanted = names.map((n) => String(n || '').trim().toLowerCase()).filter(Boolean);
  if (!wanted.length) return null;
  return blockList().find((b) => b.name && wanted.includes(b.name.trim().toLowerCase())) || null;
}

function blockForHost(host: string): BlockRow | null {
  if (!host) return null;
  return blockList().find((b) => b.host && b.host.trim().toLowerCase() === host) || null;
}

const hostCache = new Map<string, { name: string; at: number }>();
async function reverseNameFor(ip: string): Promise<string> {
  const hit = hostCache.get(ip);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.name;
  let name = '';
  try {
    const names = await reverseDns(ip);
    name = names && names.length ? String(names[0]).toLowerCase() : '';
  } catch { /* no name */ }
  hostCache.set(ip, { name, at: Date.now() });
  return name;
}
for (const [col, type] of [['handle', "TEXT NOT NULL DEFAULT ''"], ['ok', 'INTEGER NOT NULL DEFAULT 1'], ['note', "TEXT NOT NULL DEFAULT ''"]]) {
  try { db.exec(`ALTER TABLE signin_log ADD COLUMN ${col} ${type}`); } catch { /* already there */ }
}

type SigninEntry = { userId?: string; userName?: string; handle?: string; ok: boolean; note?: string };

function recordSignin(req: any, e: SigninEntry): void {
  const ip = clientIp(req);
  const agent = String(req.headers['user-agent'] || '').slice(0, 240);
  const rowId = id();
  try {
    db.prepare(`INSERT INTO signin_log(id, user_id, user_name, handle, ip, host, agent, ok, note, created_at)
                VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      rowId, e.userId || '', e.userName || '', e.handle || '', ip, '', agent,
      e.ok ? 1 : 0, e.note || '', now());
  } catch { return; }
  // Reverse DNS answers late or not at all; the row is filled in when it does.
  reverseDns(ip).then((names) => {
    if (names && names.length) {
      db.prepare('UPDATE signin_log SET host=? WHERE id=?').run(String(names[0]).slice(0, 200), rowId);
    }
  }).catch(() => { /* no reverse name for that address */ });
}

const seeded = seed();

// A router address typed in the panel beats anything we can infer, and on a
// phone inference is exactly what is hardest.
{
  const saved = getSetting('gateway_ip', '').trim();
  if (saved) process.env.GATEWAY = saved;

  // The port the world knocks on, when it should differ from the one we listen
  // on (3000 is often already claimed by something else in the house).
  const savedPort = Number(getSetting('external_port', '0')) || 0;
  if (savedPort) process.env.EXTERNAL_PORT = String(savedPort);
}

// A build that ships with a usable operator — the phone app — must not depend on
// a password printed to a console. Applied once, and only while nobody has set
// their own, so a changed password is never silently put back.
if (process.env.DEFAULT_ADMIN === '1' && (noOperatorYet() || getSetting('default_admin_applied', '') !== '1')) {
  const op = db.prepare('SELECT id FROM users WHERE is_operator = 1 LIMIT 1').get() as any;
  if (op) {
    const wanted = process.env.OP_USERNAME || 'admin';
    const clash = db.prepare('SELECT id FROM users WHERE lower(username) = ? AND id <> ?').get(wanted, op.id) as any;
    db.prepare('UPDATE users SET display_name = ?, username = ?, password_hash = ?, disabled = 0 WHERE id = ?')
      .run('Admin', clash ? null : wanted, scryptHash(process.env.OP_PASSWORD || 'peach123'), op.id);
    setSetting('account_ready', '1');
    setSetting('setup_done', '1');
    setSetting('reopen_setup', '0');
    setSetting('default_admin_applied', '1');
    console.log('  Default operator ready: ' + (clash ? '(username taken)' : wanted) + ' / the build password.');
  }
}

// A phone has no console to read a generated password from, so a half-finished
// setup there is unrecoverable without this: reopen the wizard instead of
// leaving a server that refuses every sign-in.
if (onAndroid && setupDone() && noOperatorYet()) {
  setSetting('setup_done', '0');
  setSetting('reopen_setup', '1');
  console.log('  Setup was incomplete and no administrator could sign in; reopening the setup wizard.');
}

if (seeded.generatedPassword) {
  console.log('='.repeat(64));
  console.log('First run. Operator sign-in password:');
  console.log('  ' + seeded.generatedPassword);
  console.log('Set OP_PASSWORD in the environment to choose your own.');
  console.log('='.repeat(64));
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

type Auth =
  | { kind: 'operator'; userId: string; name: string; admin: boolean; role: string; needs2fa?: boolean }
  | { kind: 'client'; clientId: string; spaceId: string; name: string | null }
  | null;

function signedSession(sid: string): string {
  return sid + '.' + hmac(SECRET, sid);
}

function resolveAuth(req: any): Auth {
  const cookies = parseCookies(req.headers?.cookie);

  const sess = cookies[SESS_COOKIE];
  if (sess) {
    const i = sess.lastIndexOf('.');
    if (i > 0) {
      const sid = sess.slice(0, i);
      const sig = sess.slice(i + 1);
      if (safeEqual(sig, hmac(SECRET, sid))) {
        const row = db.prepare(
          `SELECT s.id, s.user_id, s.expires_at, s.needs_2fa, u.display_name, u.is_operator, u.role, u.disabled
             FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`
        ).get(sid) as any;
        if (row && row.expires_at > now() && !row.disabled) {
          return {
            kind: 'operator',
            userId: row.user_id,
            name: row.display_name,
            admin: Number(row.is_operator) === 1,
            role: row.is_operator ? 'admin' : (row.role || 'member'),
            needs2fa: Number(row.needs_2fa) === 1,
          };
        }
      }
    }
  }

  const tok = cookies[CLIENT_COOKIE];
  if (tok) {
    const hash = sha256(tok);
    const row = db.prepare(
      `SELECT id, space_id, display_name, revoked_at FROM clients WHERE link_token_hash = ?`
    ).get(hash) as any;
    if (row && !row.revoked_at) {
      return { kind: 'client', clientId: row.id, spaceId: row.space_id, name: row.display_name };
    }
  }
  return null;
}

/** Any signed-in colleague. */
function requireUser(req: any, res: any): Auth {
  const a = resolveAuth(req);
  if (a && a.kind === 'operator' && a.needs2fa) {
    json(res, 403, { error: 'two-factor setup required', code: '2fa_setup' });
    return null;
  }
  if (!a || a.kind !== 'operator') {
    json(res, 401, { error: 'unauthorized' });
    return null;
  }
  return a;
}

/** Administration only: accounts, clients, destructive maintenance, settings. */
function requireAdmin(req: any, res: any): Auth {
  const a = requireUser(req, res);
  if (!a) return null;
  if (a.kind !== 'operator' || !a.admin) {
    json(res, 403, { error: 'admin only' });
    return null;
  }
  return a;
}

/** The one conversation a client owns. Created on demand, always in their space. */
function conversationForClient(clientId: string): any {
  let conv = db.prepare(
    `SELECT c.* FROM conversations c WHERE c.client_id = ? AND c.kind='direct' LIMIT 1`
  ).get(clientId) as any;
  if (conv) return conv;

  const client = db.prepare(`SELECT * FROM clients WHERE id=?`).get(clientId) as any;
  if (!client) return null;
  conv = { id: id(), space_id: client.space_id, client_id: client.id, created_at: now() };
  db.prepare(
    `INSERT INTO conversations(id, space_id, client_id, kind, title, created_at)
     VALUES(?,?,?,'direct',NULL,?)`
  ).run(conv.id, conv.space_id, client.id, conv.created_at);

  const op = db.prepare(`SELECT id FROM users WHERE is_operator=1 LIMIT 1`).get() as any;
  db.prepare(
    `INSERT INTO participants(conversation_id, participant_type, participant_id, last_read_seq, joined_at)
     VALUES(?, 'client', ?, 0, ?)`
  ).run(conv.id, client.id, now());
  if (op) {
    db.prepare(
      `INSERT INTO participants(conversation_id, participant_type, participant_id, last_read_seq, joined_at)
       VALUES(?, 'operator', ?, 0, ?)`
    ).run(conv.id, op.id, now());
  }
  return conv;
}

/** Is this colleague a named member of the conversation? */
function isMember(conversationId: string, userId: string): boolean {
  const row = db.prepare(
    `SELECT 1 AS ok FROM participants WHERE conversation_id=? AND participant_type='operator' AND participant_id=?`
  ).get(conversationId, userId) as any;
  return !!row;
}

/** Business space only; admins reach every conversation, others their own. */
function conversationAccess(auth: Auth, conversationId: string): any | null {
  if (!auth) return null;
  const conv = db.prepare(`SELECT * FROM conversations WHERE id=?`).get(conversationId) as any;
  if (!conv) return null;
  if (auth.kind === 'operator') {
    const space = db.prepare(`SELECT type FROM spaces WHERE id=?`).get(conv.space_id) as any;
    if (!space || space.type !== 'business') return null;
    if (auth.admin) return conv;
    // Open rooms are shared with the whole team; client threads are shared too.
    if (conv.kind === 'room' && conv.visibility !== 'members') return conv;
    if (conv.client_id) return conv;
    return isMember(conv.id, auth.userId) ? conv : null;
  }
  if (conv.client_id !== auth.clientId) return null;
  if (conv.space_id !== auth.spaceId) return null;
  return conv;
}

/** Participants of a conversation, as user ids. Guests are not listed here. */
function memberIds(conversationId: string): string[] {
  const rows = db.prepare(
    `SELECT participant_id FROM participants WHERE conversation_id=? AND participant_type='operator'`
  ).all(conversationId) as any[];
  return rows.map((r) => r.participant_id);
}

/** Find or create the 1:1 conversation between two colleagues. */
function directConversation(a: string, b: string): any {
  const rows = db.prepare(
    `SELECT c.* FROM conversations c
      WHERE c.kind='direct' AND c.client_id IS NULL
        AND EXISTS (SELECT 1 FROM participants p WHERE p.conversation_id=c.id AND p.participant_type='operator' AND p.participant_id=?)
        AND EXISTS (SELECT 1 FROM participants p WHERE p.conversation_id=c.id AND p.participant_type='operator' AND p.participant_id=?)
        AND (SELECT COUNT(*) FROM participants p WHERE p.conversation_id=c.id)=2
      LIMIT 1`
  ).all(a, b) as any[];
  if (rows.length) return rows[0];

  const conv = { id: id(), space_id: businessSpaceId(), client_id: null, created_at: now() };
  db.prepare(
    `INSERT INTO conversations(id, space_id, client_id, kind, title, archived_at, created_at, visibility)
     VALUES(?,?,NULL,'direct',NULL,NULL,?,'members')`
  ).run(conv.id, conv.space_id, conv.created_at);
  for (const uid of [a, b]) {
    db.prepare(
      `INSERT INTO participants(conversation_id, participant_type, participant_id, last_read_seq, joined_at)
       VALUES(?, 'operator', ?, 0, ?)`
    ).run(conv.id, uid, now());
  }
  return conv;
}

/* ------------------------------------------------------------------ */
/* rate limiting                                                       */
/* ------------------------------------------------------------------ */

const buckets = new Map<string, { tokens: number; last: number }>();

function allow(key: string, ratePerMin: number): boolean {
  const capacity = Math.max(3, Math.ceil(ratePerMin / 3));
  const b = buckets.get(key) || { tokens: capacity, last: Date.now() };
  const elapsed = (Date.now() - b.last) / 60000;
  b.tokens = Math.min(capacity, b.tokens + elapsed * ratePerMin);
  b.last = Date.now();
  if (b.tokens < 1) {
    buckets.set(key, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}

/* ------------------------------------------------------------------ */
/* presence + websocket fan-out                                        */
/* ------------------------------------------------------------------ */

const sockets = new Set<{ ws: WebSocket; auth: Auth }>();
const presence = new Map<string, number>();

function onlineKey(auth: Auth): string {
  if (!auth) return '';
  return auth.kind === 'operator' ? 'u:' + auth.userId : 'client:' + auth.clientId;
}

function isOnlineClient(clientId: string): boolean {
  return (presence.get('client:' + clientId) || 0) > 0;
}

function isUserOnline(userId: string): boolean {
  return (presence.get('u:' + userId) || 0) > 0;
}

function isOperatorOnline(): boolean {
  for (const k of presence.keys()) if (k.startsWith('u:')) return true;
  return false;
}

function sendTo(auth: Auth, payload: any): void {
  if (!auth) return;
  const key = onlineKey(auth);
  for (const s of sockets) {
    if (s.ws.readyState === WebSocket.OPEN && onlineKey(s.auth) === key) {
      s.ws.send(JSON.stringify(payload));
    }
  }
}

/** Everyone signed in, used for presence and directory changes. */
function sendToStaff(payload: any): void {
  for (const s of sockets) {
    if (s.ws.readyState === WebSocket.OPEN && s.auth?.kind === 'operator') {
      s.ws.send(JSON.stringify(payload));
    }
  }
}

function sendToConversation(conversationId: string, payload: any): void {
  const conv = db.prepare(`SELECT * FROM conversations WHERE id=?`).get(conversationId) as any;
  if (!conv) return;
  const members = new Set(memberIds(conv.id));
  // Shared inbox threads and open rooms are visible to the whole team; private
  // chats and groups only reach their members (admins may monitor).
  const shared = !!conv.client_id || (conv.kind === 'room' && conv.visibility !== 'members');
  for (const s of sockets) {
    if (s.ws.readyState !== WebSocket.OPEN) continue;
    if (s.auth?.kind === 'operator') {
      if (shared || s.auth.admin || members.has(s.auth.userId)) s.ws.send(JSON.stringify(payload));
    } else if (s.auth?.kind === 'client' && conv.client_id === s.auth.clientId) {
      s.ws.send(JSON.stringify(payload));
    }
  }
}

/**
 * Everybody who should hear about a call in this conversation: the people it
 * belongs to, plus whoever can see it at all. Open rooms are visible to the
 * whole team but store almost nobody in participants, so a room call used to
 * ring only the person who started it.
 */
function conversationAudience(conversationId: string): string[] {
  const conv = db.prepare(`SELECT * FROM conversations WHERE id=?`).get(conversationId) as any;
  if (!conv) return [];
  const members = new Set(memberIds(conv.id));
  const shared = !!conv.client_id || (conv.kind === 'room' && conv.visibility !== 'members');
  const seen = new Set<string>();
  for (const s of sockets) {
    if (s.ws.readyState !== WebSocket.OPEN) continue;
    if (s.auth?.kind !== 'operator') continue;
    if (shared || s.auth.admin || members.has(s.auth.userId)) seen.add(s.auth.userId);
  }
  return [...new Set([...members, ...seen])];
}

/* ------------------------------------------------------------------ */
/* messages                                                            */
/* ------------------------------------------------------------------ */

type Sender = { type: 'operator' | 'client'; id: string; name: string };

function senderFrom(auth: Auth): Sender | null {
  if (!auth) return null;
  if (auth.kind === 'operator') return { type: 'operator', id: auth.userId, name: auth.name || 'Operator' };
  const c = db.prepare(`SELECT display_name FROM clients WHERE id=?`).get(auth.clientId) as any;
  if (!c) return null;
  return { type: 'client', id: auth.clientId, name: c.display_name || 'Client' };
}

function pollPayload(pollId: string): any {
  const poll = db.prepare(`SELECT * FROM polls WHERE id=?`).get(pollId) as any;
  if (!poll) return null;
  const options = db.prepare(`SELECT * FROM poll_options WHERE poll_id=? ORDER BY position`).all(pollId) as any[];
  const votes = db.prepare(
    `SELECT v.option_id, v.user_id, u.display_name FROM poll_votes v
       LEFT JOIN users u ON u.id = v.user_id WHERE v.poll_id=?`
  ).all(pollId) as any[];
  return {
    id: poll.id,
    messageId: poll.message_id,
    question: poll.question,
    multi: !!poll.multi,
    closed: !!poll.closed_at,
    createdBy: poll.created_by,
    createdAt: poll.created_at,
    voters: new Set(votes.map((v) => v.user_id)).size,
    options: options.map((o) => ({
      id: o.id,
      label: o.label,
      votes: votes.filter((v) => v.option_id === o.id).length,
      voters: votes.filter((v) => v.option_id === o.id)
        .map((v) => ({ userId: v.user_id, name: v.display_name || 'Member' })),
    })),
  };
}

function pollForMessage(messageId: string): any {
  const row = db.prepare(`SELECT id FROM polls WHERE message_id=?`).get(messageId) as any;
  return row ? pollPayload(row.id) : null;
}

function acksFor(messageId: string): any[] {
  const rows = db.prepare(
    `SELECT a.user_id, a.created_at, u.display_name FROM acks a
       LEFT JOIN users u ON u.id = a.user_id WHERE a.message_id=? ORDER BY a.created_at`
  ).all(messageId) as any[];
  return rows.map((r) => ({ userId: r.user_id, name: r.display_name || 'Member', at: r.created_at }));
}

/** Sockets of one colleague, on every device they are signed in on. */
function sendToUserId(userId: string, payload: any): void {
  for (const s of sockets) {
    if (s.ws.readyState === WebSocket.OPEN && s.auth?.kind === 'operator' && s.auth.userId === userId) {
      s.ws.send(JSON.stringify(payload));
    }
  }
}

/** The team-wide announcements thread, created on first use. */
function announcementConversation(): any {
  let conv = db.prepare(
    `SELECT * FROM conversations WHERE announce_only=1 AND space_id=? LIMIT 1`
  ).get(businessSpaceId()) as any;
  if (!conv) {
    conv = { id: id() };
    db.prepare(
      `INSERT INTO conversations(id, space_id, client_id, kind, title, archived_at, created_at, visibility, announce_only)
       VALUES(?,?,NULL,'room','Announcements',NULL,?,'members',1)`
    ).run(conv.id, businessSpaceId(), now());
  }
  // Everybody on the team follows announcements, including people added later.
  const staff = db.prepare(`SELECT id FROM users WHERE disabled=0`).all() as any[];
  for (const u of staff) {
    db.prepare(
      `INSERT INTO participants(conversation_id, participant_type, participant_id, last_read_seq, joined_at)
       VALUES(?, 'operator', ?, 0, ?) ON CONFLICT DO NOTHING`
    ).run(conv.id, u.id, now());
  }
  return conv;
}

function messagePayload(conversationId: string, messageId: string): any {
  const m = db.prepare(`SELECT * FROM messages WHERE id=?`).get(messageId) as any;
  if (!m) return null;
  const att = db.prepare(`SELECT id, filename, mime, bytes, duration_ms FROM attachments WHERE message_id=? LIMIT 1`).get(m.id) as any;
  return {
    id: m.id,
    conversationId,
    seq: m.seq,
    senderType: m.sender_type,
    senderId: m.sender_id,
    senderName: m.sender_name,
    body: m.body,
    kind: m.kind || 'text',
    createdAt: m.created_at,
    poll: m.kind === 'poll' ? pollForMessage(m.id) : null,
    acks: m.kind === 'ack' ? acksFor(m.id) : null,
    attachment: att
      ? {
        id: att.id, filename: att.filename, mime: att.mime, bytes: att.bytes,
        durationMs: att.duration_ms || null, url: signedFileUrl(att.id),
      }
      : null,
  };
}

/** Idempotent insert. A repeat of the same client_msg_id returns the original row. */
function insertMessage(
  conv: any,
  sender: Sender,
  body: string,
  clientMsgId: string | null,
  kind = 'text'
): { message: any; duplicate: boolean } {
  if (clientMsgId) {
    const existing = db.prepare(
      `SELECT * FROM messages WHERE conversation_id=? AND sender_id=? AND client_msg_id=?`
    ).get(conv.id, sender.id, clientMsgId) as any;
    if (existing) {
      return { message: messagePayload(conv.id, existing.id), duplicate: true };
    }
  }

  const maxRow = db.prepare(`SELECT COALESCE(MAX(seq),0) AS m FROM messages WHERE conversation_id=?`).get(conv.id) as any;
  const seq = Number(maxRow.m) + 1;
  const msgId = id();
  const ts = now();

  db.prepare(
    `INSERT INTO messages(id, conversation_id, space_id, seq, sender_type, sender_id, sender_name,
       body, edited_at, deleted_at, client_msg_id, created_at, kind)
     VALUES(?,?,?,?,?,?,?,?,NULL,NULL,?,?,?)`
  ).run(msgId, conv.id, conv.space_id, seq, sender.type, sender.id, sender.name, body, clientMsgId, ts, kind);

  // sender has read their own message
  db.prepare(
    `UPDATE participants SET last_read_seq=? WHERE conversation_id=? AND participant_type=? AND participant_id=?`
  ).run(seq, conv.id, sender.type, sender.id);

  return { message: messagePayload(conv.id, msgId), duplicate: false };
}

/** Leave one automatic reply per hour when a colleague has set one. */function sendAutoReply(conv: any, sender: Sender): void {
  const peerId = memberIds(conv.id).find((uid) => uid !== sender.id);
  if (!peerId) return;
  const peer = db.prepare(`SELECT id, display_name, auto_reply FROM users WHERE id=?`).get(peerId) as any;
  if (!peer?.auto_reply) return;
  const last = db.prepare(
    `SELECT created_at FROM messages WHERE conversation_id=? AND sender_id=? AND kind='auto'
      ORDER BY seq DESC LIMIT 1`
  ).get(conv.id, peer.id) as any;
  if (last && now() - last.created_at < 60 * 60 * 1000) return;
  const { message } = insertMessage(
    conv, { type: 'operator', id: peer.id, name: peer.display_name },
    peer.auto_reply.slice(0, 300), null, 'auto'
  );
  sendToConversation(conv.id, { t: 'message', ...message });
}

/** Delete a conversation's messages, files, poll votes and acknowledgements. */
function purgeMessages(conversationId: string): number {
  const atts = db.prepare(
    `SELECT a.storage_key FROM attachments a JOIN messages m ON m.id = a.message_id
      WHERE m.conversation_id = ?`
  ).all(conversationId) as any[];
  for (const att of atts) {
    const file = path.join(UPLOAD_DIR, att.storage_key);
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch { /* ignore */ }
  }
  db.prepare(`DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?)`)
    .run(conversationId);
  db.prepare(`DELETE FROM acks WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?)`)
    .run(conversationId);
  db.prepare(`DELETE FROM poll_votes WHERE poll_id IN (SELECT id FROM polls WHERE conversation_id=?)`)
    .run(conversationId);
  db.prepare(`DELETE FROM poll_options WHERE poll_id IN (SELECT id FROM polls WHERE conversation_id=?)`)
    .run(conversationId);
  db.prepare(`DELETE FROM polls WHERE conversation_id=?`).run(conversationId);
  db.prepare(`UPDATE reminders SET message_id=NULL WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?)`)
    .run(conversationId);
  db.prepare(`DELETE FROM messages WHERE conversation_id=?`).run(conversationId);
  return atts.length;
}

/** Newest message in a conversation, for previews and ordering. */
function lastMessageOf(conversationId: string): any | null {
  return db.prepare(
    `SELECT body, kind, created_at, sender_name FROM messages
      WHERE conversation_id=? AND deleted_at IS NULL ORDER BY seq DESC LIMIT 1`
  ).get(conversationId) as any;
}

function unreadFor(conversationId: string, userId: string, onlyClients = false): number {
  const me = db.prepare(
    `SELECT last_read_seq FROM participants
      WHERE conversation_id=? AND participant_type='operator' AND participant_id=?`
  ).get(conversationId, userId) as any;
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM messages
      WHERE conversation_id=? AND seq > ? AND deleted_at IS NULL${onlyClients ? " AND sender_type='client'" : ''}`
  ).get(conversationId, Number(me?.last_read_seq || 0)) as any;
  return Number(row?.c || 0);
}

function conversationSummary(conversationId: string, userId: string, onlyClients = false): any {
  const last = lastMessageOf(conversationId);
  return {
    lastMessage: last
      ? (last.kind === 'text' || last.kind === 'ack' || last.kind === 'announcement'
        || last.kind === 'auto' || last.kind === 'call'
        ? last.body
        : last.kind === 'poll' ? 'Poll: ' + last.body
          : last.kind === 'voice' ? 'Voice message'
            : '[' + last.kind + '] ' + (last.body || ''))
      : '',
    lastAt: last ? last.created_at : 0,
    unread: unreadFor(conversationId, userId, onlyClients),
  };
}

/* ------------------------------------------------------------------ */
/* Work management: tasks, meetings, leave, work hours                 */
/* ------------------------------------------------------------------ */

function userBrief(userId: string | null | undefined): { id: string; name: string } | null {
  if (!userId) return null;
  const row = db.prepare(`SELECT id, display_name FROM users WHERE id=?`).get(userId) as any;
  return row ? { id: row.id, name: row.display_name } : null;
}

/** A group chat with a fixed member list, used for tasks and meetings. */
function roomWith(title: string, userIds: string[]): string {
  const gid = id();
  db.prepare(
    `INSERT INTO conversations(id, space_id, client_id, kind, title, archived_at, created_at, visibility)
     VALUES(?,?,NULL,'room',?,NULL,?,'members')`
  ).run(gid, businessSpaceId(), title.slice(0, 60), now());
  for (const uid of new Set(userIds)) {
    const u = db.prepare(`SELECT id FROM users WHERE id=? AND disabled=0`).get(uid) as any;
    if (!u) continue;
    db.prepare(
      `INSERT OR IGNORE INTO participants(conversation_id, participant_type, participant_id, last_read_seq, joined_at)
       VALUES(?,'operator',?,0,?)`
    ).run(gid, uid, now());
  }
  return gid;
}

function statePeople(userId: string): { id: string; name: string }[] {
  return (db.prepare(
    `SELECT id, display_name FROM users WHERE id<>? AND disabled=0 ORDER BY display_name COLLATE NOCASE`
  ).all(userId) as any[]).map((u) => ({ id: u.id, name: u.display_name }));
}

function leavePayload(r: any): any {
  return {
    id: r.id,
    userId: r.user_id,
    kind: r.kind,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    days: r.days,
    reason: r.reason || '',
    status: r.status,
    decidedAt: r.decided_at,
    note: r.decision_note || '',
    createdAt: r.created_at,
  };
}

function taskPayload(t: any): any {
  return {
    id: t.id,
    title: t.title,
    notes: t.notes || '',
    scope: t.scope,
    assigneeId: t.assignee_id,
    assignee: t.assignee_name || null,
    createdBy: t.created_by,
    creator: t.creator_name || null,
    conversationId: t.conversation_id,
    conversationTitle: t.conv_title || null,
    dueAt: t.due_at,
    priority: t.priority,
    done: !!t.done_at,
    doneAt: t.done_at,
    createdAt: t.created_at,
  };
}

const TASK_SELECT = `SELECT t.*, a.display_name AS assignee_name, c.display_name AS creator_name,
    conv.title AS conv_title
  FROM tasks t
  LEFT JOIN users a ON a.id=t.assignee_id
  LEFT JOIN users c ON c.id=t.created_by
  LEFT JOIN conversations conv ON conv.id=t.conversation_id`;

/** Tasks you made, tasks assigned to you, and tasks posted in a chat you are in. */
function tasksVisibleTo(userId: string): any[] {
  return db.prepare(
    `${TASK_SELECT}
      WHERE t.created_by=? OR t.assignee_id=?
        OR (t.conversation_id IS NOT NULL AND EXISTS(
              SELECT 1 FROM participants p WHERE p.conversation_id=t.conversation_id
                AND p.participant_type='operator' AND p.participant_id=?))
      ORDER BY (t.done_at IS NOT NULL), COALESCE(t.due_at, 9223372036854775807), t.created_at DESC
      LIMIT 300`
  ).all(userId, userId, userId).map(taskPayload);
}

function taskAccess(userId: string, taskId: string): any | null {
  const t = db.prepare(`${TASK_SELECT} WHERE t.id=?`).get(taskId) as any;
  if (!t) return null;
  if (t.created_by === userId || t.assignee_id === userId) return t;
  if (t.conversation_id && isMember(t.conversation_id, userId)) return t;
  return null;
}

function eventAttendees(eventId: string): any[] {
  return (db.prepare(
    `SELECT i.user_id, i.status, u.display_name FROM event_invites i
       JOIN users u ON u.id=i.user_id WHERE i.event_id=? ORDER BY u.display_name COLLATE NOCASE`
  ).all(eventId) as any[]).map((r) => ({ userId: r.user_id, name: r.display_name, status: r.status }));
}

function eventPayload(e: any, meId: string): any {
  const attendees = eventAttendees(e.id);
  const mine = attendees.find((a) => a.userId === meId);
  return {
    id: e.id,
    title: e.title,
    notes: e.notes || '',
    location: e.location || '',
    startsAt: e.starts_at,
    endsAt: e.ends_at,
    allDay: !!e.all_day,
    createdBy: e.created_by,
    creator: userBrief(e.created_by)?.name || null,
    conversationId: e.conversation_id,
    cancelled: !!e.cancelled_at,
    myStatus: mine ? mine.status : null,
    mine: e.created_by === meId,
    attendees,
  };
}

function eventsVisibleTo(userId: string, from: number, to: number): any[] {
  const rows = db.prepare(
    `SELECT e.* FROM events e
      WHERE e.starts_at < ? AND e.ends_at > ?
        AND (e.created_by=? OR EXISTS(SELECT 1 FROM event_invites i WHERE i.event_id=e.id AND i.user_id=?))
      ORDER BY e.starts_at ASC LIMIT 400`
  ).all(to, from, userId, userId) as any[];
  return rows.map((e) => eventPayload(e, userId));
}

function eventAccess(userId: string, eventId: string): any | null {
  const e = db.prepare(`SELECT * FROM events WHERE id=?`).get(eventId) as any;
  if (!e) return null;
  if (e.created_by === userId) return e;
  const inv = db.prepare(`SELECT 1 AS ok FROM event_invites WHERE event_id=? AND user_id=?`).get(eventId, userId) as any;
  return inv ? e : null;
}

/** Presence is the record of work time: open on the first device, close on the last. */
function openWorkSession(userId: string): void {
  const open = db.prepare(
    `SELECT id FROM work_sessions WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`
  ).get(userId) as any;
  if (!open) {
    db.prepare(`INSERT INTO work_sessions(id, user_id, started_at, source) VALUES(?,?,?,'presence')`)
      .run(id(), userId, now());
  }
}

function closeWorkSession(userId: string): void {
  db.prepare(`UPDATE work_sessions SET ended_at=? WHERE user_id=? AND ended_at IS NULL`).run(now(), userId);
}

/** Minutes on the clock between two instants. */
function minutesWorked(userId: string, from: number, to: number): number {
  const rows = db.prepare(
    `SELECT started_at, ended_at FROM work_sessions WHERE user_id=? AND started_at < ? AND (ended_at IS NULL OR ended_at > ?)`
  ).all(userId, to, from) as any[];
  let ms = 0;
  for (const r of rows) {
    const start = Math.max(Number(r.started_at), from);
    // A browser left open overnight should not read as sixteen hours of work.
    const cap = Number(r.started_at) + 16 * 3600000;
    const end = Math.min(r.ended_at ? Number(r.ended_at) : now(), to, cap);
    if (end > start) ms += end - start;
  }
  return Math.round(ms / 60000);
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function parseDayKey(s: string): number {
  const d = new Date(`${s}T00:00:00`);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

/** Working days between two calendar dates, skipping weekends and holidays. */
function leaveDays(from: string, to: string): number {
  const holidays = new Set((db.prepare(`SELECT day FROM holidays`).all() as any[]).map((h) => h.day));
  let d = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  if (isNaN(d.getTime()) || isNaN(end.getTime())) return 0;
  let count = 0;
  while (d <= end && count < 400) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6 && !holidays.has(key)) count++;
    d = new Date(d.getTime() + 86400000);
  }
  return count;
}

/* iCalendar: enough of RFC 5545 to subscribe from Google Calendar and to
   import an existing calendar back in. */

function icsStamp(ts: number): string {
  return new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function icsText(s: string): string {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Long lines are folded with a leading space, as clients expect. */
function icsFold(line: string): string {
  if (line.length <= 74) return line;
  const parts: string[] = [];
  let rest = line;
  parts.push(rest.slice(0, 74));
  rest = rest.slice(74);
  while (rest.length) {
    parts.push(' ' + rest.slice(0, 73));
    rest = rest.slice(73);
  }
  return parts.join('\r\n');
}

function buildIcs(userId: string): string {
  const rows = db.prepare(
    `SELECT e.* FROM events e
      WHERE e.created_by=? OR EXISTS(SELECT 1 FROM event_invites i WHERE i.event_id=e.id AND i.user_id=?)
      ORDER BY e.starts_at ASC LIMIT 1000`
  ).all(userId, userId) as any[];
  const lines: string[] = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Messenger//Work calendar//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Messenger meetings',
  ];
  for (const e of rows) {
    const mine = e.created_by === userId;
    const inv = db.prepare(`SELECT status FROM event_invites WHERE event_id=? AND user_id=?`).get(e.id, userId) as any;
    if (!mine && inv && inv.status === 'declined') continue;
    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + e.ical_uid);
    lines.push('DTSTAMP:' + icsStamp(e.updated_at || e.created_at));
    if (e.all_day) {
      lines.push('DTSTART;VALUE=DATE:' + dayKey(e.starts_at).replace(/-/g, ''));
      lines.push('DTEND;VALUE=DATE:' + dayKey(e.ends_at || e.starts_at + 86400000).replace(/-/g, ''));
    } else {
      lines.push('DTSTART:' + icsStamp(e.starts_at));
      lines.push('DTEND:' + icsStamp(e.ends_at));
    }
    lines.push('SUMMARY:' + icsText(e.title));
    if (e.notes) lines.push('DESCRIPTION:' + icsText(e.notes));
    if (e.location) lines.push('LOCATION:' + icsText(e.location));
    lines.push('SEQUENCE:' + Number(e.ical_seq || 0));
    lines.push('STATUS:' + (e.cancelled_at ? 'CANCELLED' : (inv && inv.status === 'accepted') || mine ? 'CONFIRMED' : 'TENTATIVE'));
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

function icsUnfold(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function icsParseDate(value: string): { ts: number; allDay: boolean } | null {
  const v = value.trim().replace(/^.*:/, '');
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    const ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    return isNaN(ts) ? null : { ts, allDay: true };
  }
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (m) {
    const ts = m[7]
      ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
      : new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
    return isNaN(ts) ? null : { ts, allDay: false };
  }
  return null;
}

function icsUnescape(s: string): string {
  return s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function signedFileUrl(attachmentId: string): string {
  const exp = Date.now() + 1000 * 60 * 10;
  const sig = hmac(SECRET, attachmentId + '|' + exp);
  return `/files/${attachmentId}?exp=${exp}&sig=${encodeURIComponent(sig)}`;
}

/* ------------------------------------------------------------------ */
/* Phase 5 helpers: drive, mail, helpdesk, API keys                    */
/* ------------------------------------------------------------------ */

const UPLOAD_MAX = 10 * 1024 * 1024;
const UPLOAD_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf', 'text/plain', 'text/csv', 'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword', 'application/vnd.ms-excel',
]);

/** null when the file is acceptable, otherwise a message for the user. */
function uploadRefusal(filename: string, mime: string): string | null {
  const ext = path.extname(filename).toLowerCase();
  if (['.exe', '.bat', '.cmd', '.com', '.scr', '.msi', '.ps1', '.sh', '.js'].includes(ext)) {
    return 'file type refused';
  }
  if (!UPLOAD_MIMES.has(mime)) return 'file type not allowed';
  return null;
}

function driveQuotaBytes(): number {
  const mb = Number(getSetting('drive_quota_mb', '1024'));
  return Math.max(50, Number.isFinite(mb) ? mb : 1024) * 1024 * 1024;
}

function driveUsedBytes(ownerId: string): number {
  return Number((db.prepare(
    `SELECT COALESCE(SUM(bytes),0) AS b FROM drive_items WHERE owner_id=? AND kind='file'`
  ).get(ownerId) as any)?.b || 0);
}

/** A room drive belongs to the room; only people in that room can open it. */
function driveRoom(auth: Auth, conversationId: string): any | null {
  if (!auth || auth.kind !== 'operator' || !conversationId) return null;
  const conv = conversationAccess(auth, conversationId);
  if (!conv || conv.kind !== 'room' || conv.client_id) return null;
  return conv;
}

function driveItem(auth: Auth, itemId: string): any | null {
  if (!auth || auth.kind !== 'operator' || !itemId) return null;
  const item = db.prepare(`SELECT * FROM drive_items WHERE id=?`).get(itemId) as any;
  if (!item) return null;
  if (auth.admin) return item;
  if (item.owner_id && item.owner_id === auth.userId) return item;
  if (db.prepare(`SELECT 1 AS ok FROM drive_shares WHERE item_id=? AND user_id=?`)
    .get(item.id, auth.userId)) return item;
  if (item.conversation_id && driveRoom(auth, item.conversation_id)) return item;
  return null;
}

/** A file shared with you is reachable, and so is anything below a shared folder. */
function driveAncestorShared(item: any, userId: string): boolean {
  let parent = item.parent_id;
  let guard = 0;
  while (parent && guard++ < 50) {
    if (db.prepare(`SELECT 1 AS ok FROM drive_shares WHERE item_id=? AND user_id=?`).get(parent, userId)) return true;
    const row = db.prepare(`SELECT parent_id FROM drive_items WHERE id=?`).get(parent) as any;
    parent = row?.parent_id || null;
  }
  return false;
}

function driveCanOpen(auth: Auth, itemId: string): any | null {
  const direct = driveItem(auth, itemId);
  if (direct) return direct;
  if (!auth || auth.kind !== 'operator') return null;
  const item = db.prepare(`SELECT * FROM drive_items WHERE id=?`).get(itemId) as any;
  if (item && driveAncestorShared(item, auth.userId)) return item;
  return null;
}

function driveIsSharedWith(itemId: string, userId: string): boolean {
  if (db.prepare(`SELECT 1 AS ok FROM drive_shares WHERE item_id=? AND user_id=?`).get(itemId, userId)) return true;
  const item = db.prepare(`SELECT * FROM drive_items WHERE id=?`).get(itemId) as any;
  return item ? driveAncestorShared(item, userId) : false;
}

function driveCrumbs(item: any | null): { id: string | null; name: string }[] {
  const out: { id: string | null; name: string }[] = [];
  let cur = item;
  let guard = 0;
  while (cur && guard++ < 50) {
    out.unshift({ id: cur.id, name: cur.name });
    cur = cur.parent_id ? db.prepare(`SELECT * FROM drive_items WHERE id=?`).get(cur.parent_id) : null;
  }
  return out;
}

function driveItemPayload(it: any, meId: string): any {
  const shared = it.owner_id === meId
    ? (db.prepare(`SELECT COUNT(*) AS c FROM drive_shares WHERE item_id=?`).get(it.id) as any).c
    : null;
  return {
    id: it.id,
    name: it.name,
    kind: it.kind,
    mime: it.mime,
    bytes: it.bytes,
    version: it.version,
    parentId: it.parent_id,
    ownerId: it.owner_id,
    conversationId: it.conversation_id,
    updatedAt: it.updated_at,
    sharedWithMe: it.owner_id !== meId && !it.conversation_id,
    shareCount: shared === null ? null : Number(shared || 0),
  };
}

function mailRecipients(row: any): string[] {
  try {
    const parsed = JSON.parse(row.to_ids || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
}

function mailPayload(row: any, meId: string): any {
  const atts = db.prepare(
    `SELECT a.id, a.item_id, d.name, d.mime, d.bytes FROM mail_attachments a
       JOIN drive_items d ON d.id = a.item_id WHERE a.mail_id=? ORDER BY a.created_at`
  ).all(row.id) as any[];
  return {
    id: row.id,
    threadId: row.thread_id,
    fromId: row.from_id,
    fromName: userBrief(row.from_id)?.name || 'Someone',
    toIds: mailRecipients(row),
    toNames: mailRecipients(row).map((u) => userBrief(u)?.name || 'Someone'),
    subject: row.subject,
    body: row.body,
    priority: row.priority,
    createdAt: row.created_at,
    mine: row.from_id === meId,
    attachments: atts.map((a) => ({ id: a.id, itemId: a.item_id, name: a.name, mime: a.mime, bytes: a.bytes })),
  };
}

/** Threads a person can see, newest activity first. */
function mailThreads(userId: string, folder: 'inbox' | 'sent'): any[] {
  const rows = db.prepare(`SELECT * FROM mail ORDER BY created_at ASC`).all() as any[];
  const deleted = new Set((db.prepare(`SELECT thread_id FROM mail_deleted WHERE user_id=?`).all(userId) as any[])
    .map((r) => r.thread_id));
  const reads = new Set((db.prepare(`SELECT thread_id FROM mail_reads WHERE user_id=?`).all(userId) as any[])
    .map((r) => r.thread_id));
  const threads = new Map<string, any>();
  for (const row of rows) {
    const to = mailRecipients(row);
    const involved = row.from_id === userId || to.includes(userId);
    if (!involved || deleted.has(row.thread_id)) continue;
    if (folder === 'inbox' && row.from_id === userId) continue;
    if (folder === 'sent' && row.from_id !== userId) continue;
    const t = threads.get(row.thread_id) || {
      threadId: row.thread_id,
      subject: row.subject,
      fromId: row.from_id,
      fromName: row.from_id === userId ? 'Me' : (userBrief(row.from_id)?.name || 'Someone'),
      toNames: to.map((u) => u === userId ? 'Me' : (userBrief(u)?.name || 'Someone')),
      priority: row.priority,
      count: 0,
      unread: 0,
      lastAt: row.created_at,
      lastBody: row.body,
    };
    t.count += 1;
    t.lastAt = row.created_at;
    t.lastBody = row.body;
    if (row.from_id !== userId && !reads.has(row.thread_id)) t.unread = 1;
    if (row.priority === 'high') t.priority = 'high';
    threads.set(row.thread_id, t);
  }
  return [...threads.values()].sort((a, b) => b.lastAt - a.lastAt);
}

function mailUnread(userId: string): number {
  return mailThreads(userId, 'inbox').filter((t) => t.unread).length;
}

function ticketPayload(row: any): any {
  const client = db.prepare(`SELECT display_name, email FROM clients WHERE id=?`).get(row.client_id) as any;
  const last = db.prepare(
    `SELECT body, kind, sender_type, created_at FROM messages WHERE conversation_id=? ORDER BY seq DESC LIMIT 1`
  ).get(row.conversation_id) as any;
  return {
    id: row.id,
    clientId: row.client_id,
    conversationId: row.conversation_id,
    clientName: client?.display_name || 'Unnamed client',
    email: client?.email || null,
    subject: row.subject,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_id ? (userBrief(row.assignee_id)?.name || 'Someone') : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at || null,
    lastBody: last ? (last.kind === 'file' ? '[file] ' + (last.body || '') : last.body) : '',
    lastAt: last ? last.created_at : row.created_at,
    waiting: last ? last.sender_type === 'client' : false,
    online: isOnlineClient(row.client_id),
  };
}

/** A customer or agent wrote in a customer thread: keep its ticket in step. */
function noteTicketActivity(conv: any, sender: Sender): void {
  if (!conv.client_id) return;
  const t = db.prepare(`SELECT * FROM tickets WHERE conversation_id=?`).get(conv.id) as any;
  if (!t) { ensureTickets(); return; }
  if (sender.type === 'client') {
    const count = Number((db.prepare(
      `SELECT COUNT(*) AS c FROM messages WHERE conversation_id=? AND sender_type='client'`
    ).get(conv.id) as any)?.c || 0);
    const subject = count <= 1 && t.subject === 'Customer enquiry'
      ? db.prepare(`SELECT body FROM messages WHERE conversation_id=? AND sender_type='client' ORDER BY seq LIMIT 1`).get(conv.id) as any
      : null;
    const nextSubject = subject?.body ? String(subject.body).replace(/\s+/g, ' ').slice(0, 80) : t.subject;
    db.prepare(`UPDATE tickets SET status='open', subject=?, updated_at=?, closed_at=NULL WHERE id=?`)
      .run(nextSubject, now(), t.id);
    if (t.assignee_id) sendToUserId(t.assignee_id, { t: 'ticket', ticketId: t.id });
    else sendToStaff({ t: 'ticket', ticketId: t.id });
    return;
  }
  db.prepare(`UPDATE tickets SET updated_at=? WHERE id=?`).run(now(), t.id);
}

/** Every customer thread has a ticket; this fills in threads that predate tickets. */
function ensureTickets(): void {
  const missing = db.prepare(
    `SELECT c.id, c.client_id, c.space_id, c.created_at FROM conversations c
      WHERE c.client_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.conversation_id = c.id)`
  ).all() as any[];
  for (const row of missing) {
    db.prepare(
      `INSERT INTO tickets(id, space_id, client_id, conversation_id, subject, status, priority, assignee_id, created_at, updated_at, closed_at)
       VALUES(?,?,?,?,?,'open','normal',NULL,?,?,NULL)`
    ).run(id(), row.space_id, row.client_id, row.id, 'Customer enquiry', row.created_at, row.created_at);
  }
}

/** One clean name for a stored file, safe for a download header. */
function downloadName(name: string): string {
  return String(name || 'file').replace(/[^\w.\- ]/g, '_').slice(0, 120) || 'file';
}

type ApiAuth = { userId: string; name: string; admin: boolean; role: string; tokenId: string; scopes: string[] };

/** Bearer-token auth for the public REST API. The key acts as the person who made it. */
function apiAuth(req: any): ApiAuth | null {
  const header = String(req.headers['authorization'] || '');
  const m = header.match(/^Bearer\s+([A-Za-z0-9_\-]{10,200})$/i);
  if (!m) return null;
  const row = db.prepare(`SELECT * FROM api_tokens WHERE token_hash=? AND revoked_at IS NULL`)
    .get(sha256(m[1])) as any;
  if (!row) return null;
  const user = db.prepare(`SELECT id, display_name, role, is_operator, disabled FROM users WHERE id=?`)
    .get(row.created_by) as any;
  if (!user || user.disabled || !user.is_operator) return null;
  db.prepare(`UPDATE api_tokens SET last_used_at=? WHERE id=?`).run(now(), row.id);
  return {
    userId: user.id,
    name: user.display_name,
    admin: user.role === 'admin' || !!user.is_operator,
    role: user.role,
    tokenId: row.id,
    scopes: String(row.scopes || '').split(',').filter(Boolean),
  };
}

/* ------------------------------------------------------------------ */
/* Phase 6 helpers: two-factor, switches, retention, backup             */
/* ------------------------------------------------------------------ */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text: string): Buffer {
  const clean = String(text || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The six digits a code generator shows for a given 30-second step. */
function totpAt(secret: string, step: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(step / 4294967296), 0);
  buf.writeUInt32BE(step % 4294967296, 4);
  const digest = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const code = (((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3]) % 1000000;
  return String(code).padStart(6, '0');
}

/** A minute of clock drift either way is tolerated. */
function totpVerify(secret: string, code: string): boolean {
  const clean = String(code || '').replace(/\D/g, '');
  if (!secret || clean.length !== 6) return false;
  const step = Math.floor(Date.now() / 30000);
  for (const drift of [-1, 0, 1]) {
    if (safeEqual(totpAt(secret, step + drift), clean)) return true;
  }
  return false;
}

function newTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/** Begin a signed-in session. A session can still owe the second factor. */
function startSession(res: any, userId: string, needs2fa = false): string {
  const sid = id(24);
  db.prepare(
    `INSERT INTO sessions(id, user_id, expires_at, created_at, needs_2fa) VALUES(?,?,?,?,?)`
  ).run(sid, userId, now() + SESSION_TTL, now(), needs2fa ? 1 : 0);
  setCookie(res, SESS_COOKIE, signedSession(sid), SESSION_TTL / 1000);
  return sid;
}

function otpauthUrl(secret: string, name: string): string {
  const issuer = 'Messenger';
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(name)}` +
    `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/** All four switches on for administrators; whatever is stored for everyone else. */
function userFlags(userId: string): { files: boolean; otr: boolean; drive: boolean } {
  const row = db.prepare(
    `SELECT role, is_operator, allow_files, allow_calls, allow_otr, allow_drive FROM users WHERE id=?`
  ).get(userId) as any;
  if (!row || row.is_operator) return { files: true, otr: true, drive: true };
  return {
    files: row.allow_files !== 0,
    otr: row.allow_otr !== 0,
    drive: row.allow_drive !== 0,
  };
}

/** null when this person may open a private chat with that person. */
function directChatRefusal(auth: Auth, targetId: string): string | null {
  if (!auth || auth.kind !== 'operator' || auth.admin) return null;
  const policy = getSetting('message_policy', 'everyone');
  if (policy === 'admins') return 'Only administrators can start new private chats';
  if (policy === 'department') {
    const me = db.prepare(`SELECT department_id FROM users WHERE id=?`).get(auth.userId) as any;
    const them = db.prepare(`SELECT department_id FROM users WHERE id=?`).get(targetId) as any;
    if (!me?.department_id || me.department_id !== them?.department_id) {
      return 'Private chats are limited to your own department';
    }
  }
  return null;
}

/** Delete old messages and their files. Customer threads are kept as records. */
function runRetention(): number {
  const days = Number(getSetting('retention_days', '0'));
  if (!Number.isFinite(days) || days <= 0) return 0;
  const cutoff = now() - days * 86400000;
  const convs = db.prepare(`SELECT id FROM conversations WHERE client_id IS NULL`).all() as any[];
  let removed = 0;
  for (const conv of convs) {
    const old = db.prepare(
      `SELECT id FROM messages WHERE conversation_id=? AND created_at<?`
    ).all(conv.id, cutoff) as any[];
    for (let i = 0; i < old.length; i += 200) {
      const ids = old.slice(i, i + 200).map((r) => r.id);
      const marks = ids.map(() => '?').join(',');
      const files = db.prepare(
        `SELECT storage_key FROM attachments WHERE message_id IN (${marks})`
      ).all(...ids) as any[];
      for (const f of files) {
        try { fs.unlinkSync(path.join(UPLOAD_DIR, f.storage_key)); } catch { /* already gone */ }
      }
      db.prepare(`DELETE FROM attachments WHERE message_id IN (${marks})`).run(...ids);
      db.prepare(`DELETE FROM acks WHERE message_id IN (${marks})`).run(...ids);
      db.prepare(`DELETE FROM poll_votes WHERE poll_id IN (SELECT id FROM polls WHERE message_id IN (${marks}))`).run(...ids);
      db.prepare(`DELETE FROM poll_options WHERE poll_id IN (SELECT id FROM polls WHERE message_id IN (${marks}))`).run(...ids);
      db.prepare(`DELETE FROM polls WHERE message_id IN (${marks})`).run(...ids);
      db.prepare(`UPDATE reminders SET message_id=NULL WHERE message_id IN (${marks})`).run(...ids);
      db.prepare(`DELETE FROM messages WHERE id IN (${marks})`).run(...ids);
      removed += ids.length;
    }
  }
  if (removed) setSetting('retention_last_run', String(now()));
  return removed;
}

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

function makeBackup(tag = 'manual'): { file: string; name: string; bytes: number } {
  const name = `${tag}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
  const file = path.join(BACKUP_DIR, name);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return { file, name, bytes: fs.statSync(file).size };
}

function listBackups(): { name: string; bytes: number; at: number }[] {
  return fs.readdirSync(BACKUP_DIR)
    .filter((n) => n.endsWith('.db'))
    .map((n) => {
      const st = fs.statSync(path.join(BACKUP_DIR, n));
      return { name: n, bytes: st.size, at: st.mtimeMs };
    })
    .sort((a, b) => b.at - a.at);
}

// Tables a restore may write, parents first. Anything not in both files is skipped.
const RESTORE_TABLES = [
  'spaces', 'departments', 'users', 'clients', 'conversations', 'participants',
  'messages', 'attachments', 'room_guests', 'notes', 'sessions', 'canned',
  'suppression', 'login_tokens', 'audit_log', 'settings', 'polls', 'poll_options',
  'poll_votes', 'acks', 'sticky_notes', 'reminders', 'calls', 'tasks', 'events',
  'event_invites', 'leave_requests', 'holidays', 'work_sessions', 'drive_items',
  'drive_versions', 'drive_shares', 'mail', 'mail_reads', 'mail_deleted',
  'mail_attachments', 'tickets', 'api_tokens', 'twofa_tickets',
];

/** Copy a backup file over the live database, one table at a time. */
function restoreDatabase(file: string): { tables: number; rows: number } {
  const quoted = file.replace(/'/g, "''");
  db.exec(`ATTACH DATABASE '${quoted}' AS incoming`);
  try {
    const integrity = db.prepare(`PRAGMA incoming.integrity_check`).all() as any[];
    if (integrity.length !== 1 || String(integrity[0].integrity_check) !== 'ok') {
      throw new Error('that file is not a healthy database');
    }
    const present = new Set((db.prepare(
      `SELECT name FROM incoming.sqlite_master WHERE type='table'`
    ).all() as any[]).map((r) => r.name));
    for (const needed of ['users', 'conversations', 'messages', 'spaces']) {
      if (!present.has(needed)) throw new Error('that file is not a Messenger backup');
    }

    const counts: Record<string, number> = {};
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      // Clear the tables that are about to be replaced, children first.
      for (const table of [...RESTORE_TABLES].reverse()) {
        if (!present.has(table)) continue;
        db.exec(`DELETE FROM main.${table}`);
      }
      let tables = 0;
      let rows = 0;
      for (const table of RESTORE_TABLES) {
        if (!present.has(table)) continue;
        const mainCols = (db.prepare(`PRAGMA main.table_info(${table})`).all() as any[]).map((c) => c.name);
        const inCols = new Set((db.prepare(`PRAGMA incoming.table_info(${table})`).all() as any[]).map((c) => c.name));
        const cols = mainCols.filter((c) => inCols.has(c));
        if (!cols.length) continue;
        const list = cols.map((c) => `"${c}"`).join(',');
        db.exec(`INSERT INTO main.${table} (${list}) SELECT ${list} FROM incoming.${table}`);
        rows += Number((db.prepare(`SELECT COUNT(*) AS c FROM incoming.${table}`).get() as any)?.c || 0);
        counts[table] = Number((db.prepare(`SELECT COUNT(*) AS c FROM incoming.${table}`).get() as any)?.c || 0);
        tables += 1;
      }
      db.exec('COMMIT');
      return { tables, rows };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  } finally {
    db.exec('DETACH DATABASE incoming');
  }
}

/** Minimal CSV reader: quoted fields, doubled quotes, CRLF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (ch === '\r') continue;
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

/* ------------------------------------------------------------------ */
/* static files                                                        */
/* ------------------------------------------------------------------ */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
};

function serveStatic(res: any, rel: string): boolean {
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  // App code and markup must never come from a stale cache; this app is edited live.
  const fresh = ['.html', '.js', '.css'].includes(ext);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': fresh ? 'no-store, must-revalidate' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(fs.readFileSync(file));
  return true;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

const handleRequest = async (req: any, res: any) => {
  const url = new URL(req.url || '/', BASE_URL);
  const p = url.pathname;

  // A blocked address reaches no page and no API; the health check stays open so
  // an operator can still see that the server is alive.
  if (p !== '/health') {
    const ipNow = clientIp(req);
    if (blockForIp(ipNow)) { json(res, 403, { error: 'this address is blocked' }); return; }
    if (blockList().some((b) => b.host)) {
      const reverse = await reverseNameFor(ipNow);
      if (blockForHost(reverse)) { json(res, 403, { error: 'this address is blocked' }); return; }
    }
  }

  // Work hours come before anything else: outside them the door is shut, with a
  // polite note instead of an app, and 503s instead of data.
  if (!workOpen() && !allowedWhileClosed(p)) {
    if (p.startsWith('/api/')) {
      json(res, 503, { error: 'closed', open: false, hours: workHours() });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(closedPage());
    return;
  }

  // A feature the administrator unloaded behaves as if it were not installed.
  const unloaded = moduleFor(p);
  if (unloaded && !moduleEnabled(unloaded.id)) {
    json(res, 404, { error: 'that feature is not loaded' });
    return;
  }

  try {
    if (p === '/health') {
      json(res, 200, { ok: true, time: new Date().toISOString() });
      return;
    }

    // Read by the Android service to decide whether the phone may sleep.
    if (p === '/api/app-state') {
      const state: any = { open: workOpen(), hours: workHours() };
      json(res, 200, state);
      return;
    }

    // Relay servers for a call. Credentials are minted per request and cached by
    // this process; the browser never sees the long-lived TURN key.
    if (p === '/api/turn' && req.method === 'GET') {
      const a = resolveAuth(req);
      if (!a || a.kind !== 'operator') { json(res, 401, { error: 'unauthorized' }); return; }
      if (!turnConfigured()) { json(res, 200, { configured: false, iceServers: [] }); return; }
      try {
        json(res, 200, { configured: true, iceServers: await turnIceServers() });
      } catch (e: any) {
        json(res, 502, { configured: true, error: 'relay unavailable', message: String(e?.message || e) });
      }
      return;
    }

    // Build fingerprint for support. Deliberately unadvertised: no link, no menu
    // entry, nothing in the UI pointing here. It returns only the version and the
    // aggregate hashes from the attestation the supervisor keeps OUTSIDE this
    // folder - never the file list, never the signing key, never anything secret.
    // If there is no attestation it says so rather than inventing a value.
    if (p === '/__build') {
      const out: Record<string, unknown> = { app: 'peach-messenger' };
      try {
        const stamp = path.join(os.homedir(), '.config', 'peachmessenger', '7f3a9c2.oop');
        const text = fs.readFileSync(stamp, 'utf8');
        const pick = (key: string) => {
          const m = text.match(new RegExp('^' + key + ':\s*(.+)$', 'm'));
          return m ? String(m[1]).trim() : null;
        };
        out.version = pick('version');
        out.source = pick('source-sha');
        out.dist = pick('dist-sha');
        out.recorded = pick('recorded');
        out.signed = /^signature:/m.test(text);
        out.attested = true;
      } catch {
        out.attested = false;
        out.note = 'no attestation on this machine';
      }
      json(res, 200, out);
      return;
    }

    // Diagnostics for reachability: what the router agreed to, and any VPN.
    if (p === '/api/net') {
      if (!requireAdmin(req, res)) return;
      const vpn = await detectVpn();
      json(res, 200, {
        port: PORT,
        lan: lanAddresses().map((ip) => `http://${ip}:${PORT}`),
        mapped: MAPPING,
        publicUrl: MAPPED_URL || null,
        linksUse: publicBase(),
        // The name the DDNS updater keeps pointed here, if one is set. The manual
        // panel shows it so nobody has to remember which hostname they bought.
        name: getSetting('ddns_host', ''),
        publicPath: publicPath(),
        publicPathOptions: ['vpn', 'upnp', 'manual'],
        // What the panel offers as "router address": what you typed, else our guess.
        gateway: getSetting('gateway_ip', '') || process.env.GATEWAY || '',
        externalPort: Number(getSetting('external_port', '0')) || 0,
        gatewayGuess: (await gatewayCandidates()).slice(0, 3),
        // Never assume a number: the VPN hands out its port fresh each session,
        // so it is reported as "known right now" or not at all.
        configuredPort: Number(getSetting('manual_port', '0')) || 3000,
        vpnPort: VPN_MAPPING ? VPN_MAPPING.external : null,
        vpn,
        // What the panel should say about this machine: a phone cannot do
        // everything a desktop can, and pretending otherwise hides the reason.
        machine: platformLabel,
        machineNote: platformNote()
      });
      return;
    }

    /* ---------- public REST API (bearer key) ---------- */

    if (p === '/api/v1' || p.startsWith('/api/v1/')) {
      const token = apiAuth(req);
      if (!token) { json(res, 401, { error: 'invalid or missing API key' }); return; }
      if (!allow('api:' + token.tokenId, 120)) { json(res, 429, { error: 'slow down' }); return; }
      const canRead = !token.scopes.length || token.scopes.includes('read');
      const canWrite = token.scopes.includes('write');
      const asAuth: Auth = { kind: 'operator', userId: token.userId, name: token.name, admin: token.admin, role: token.role };
      const chatAccess = (conversationId: string) => {
        const conv = conversationAccess(asAuth, conversationId);
        if (!conv || conv.client_id) return null;
        return conv;
      };

      if (p === '/api/v1/me' && req.method === 'GET') {
        json(res, 200, { id: token.userId, name: token.name, role: token.role, admin: token.admin });
        return;
      }

      if (p === '/api/v1/users' && req.method === 'GET') {
        if (!canRead) { json(res, 403, { error: 'this key cannot read' }); return; }
        const people = db.prepare(
          `SELECT id, display_name, username, role, status, status_text, department_id, last_seen
             FROM users WHERE disabled=0 ORDER BY display_name`
        ).all() as any[];
        json(res, 200, {
          users: people.map((u) => ({
            id: u.id, name: u.display_name, username: u.username, role: u.role,
            status: u.status, statusText: u.status_text || '',
            departmentId: u.department_id || null, lastSeen: u.last_seen,
          })),
        });
        return;
      }

      if (p === '/api/v1/chats' && req.method === 'GET') {
        if (!canRead) { json(res, 403, { error: 'this key cannot read' }); return; }
        const rows = db.prepare(
          `SELECT * FROM conversations WHERE space_id=? AND client_id IS NULL ORDER BY created_at ASC`
        ).all(businessSpaceId()) as any[];
        const chats = rows.filter((r) => chatAccess(r.id)).map((r) => {
          const summary = conversationSummary(r.id, token.userId);
          const peer = r.kind === 'direct'
            ? memberIds(r.id).filter((u) => u !== token.userId)
              .map((u) => userBrief(u)?.name).filter(Boolean)[0]
            : null;
          return {
            id: r.id,
            kind: r.kind === 'room' ? 'room' : 'direct',
            name: r.title || peer || (r.kind === 'room' ? 'Room' : 'Direct chat'),
            archived: !!r.archived_at,
            unread: summary.unread,
            lastMessage: summary.lastMessage || '',
            lastAt: summary.lastAt || r.created_at,
          };
        });
        json(res, 200, { chats });
        return;
      }

      const chatMsg = p.match(/^\/api\/v1\/chats\/([^/]+)\/messages$/);
      if (chatMsg) {
        const conv = chatAccess(chatMsg[1]);
        if (!conv) { json(res, 404, { error: 'no such chat' }); return; }
        if (req.method === 'GET') {
          if (!canRead) { json(res, 403, { error: 'this key cannot read' }); return; }
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)));
          const ids = db.prepare(
            `SELECT id FROM messages WHERE conversation_id=? AND deleted_at IS NULL ORDER BY seq DESC LIMIT ?`
          ).all(conv.id, limit) as any[];
          json(res, 200, { chatId: conv.id, messages: ids.reverse().map((r) => messagePayload(conv.id, r.id)) });
          return;
        }
        if (req.method === 'POST') {
          if (!canWrite) { json(res, 403, { error: 'this key cannot send' }); return; }
          if (conv.announce_only && !token.admin) { json(res, 403, { error: 'admins only here' }); return; }
          const body = await readJson(req);
          const text = String(body?.text || body?.body || '').trim().slice(0, 4000);
          if (!text) { json(res, 400, { error: 'text required' }); return; }
          const { message } = insertMessage(
            conv, { type: 'operator', id: token.userId, name: token.name }, text, null
          );
          sendToConversation(conv.id, { t: 'message', ...message });
          json(res, 200, { ok: true, message });
          return;
        }
      }

      json(res, 404, { error: 'no such endpoint' });
      return;
    }

    /* ---------- auth ---------- */

    if (p === '/' ) {
      if (!setupDone()) { res.writeHead(302, { Location: '/setup' }); res.end(); return; }
      const a = resolveAuth(req);
      if (!a) { res.writeHead(302, { Location: '/login' }); res.end(); return; }
      res.writeHead(302, { Location: a.kind === 'operator' ? '/app' : '/thread' });
      res.end();
      return;
    }

    if (p === '/login') {
      if (!setupDone()) { res.writeHead(302, { Location: '/setup' }); res.end(); return; }
      if (!allow('ip:' + clientIp(req), 20)) { json(res, 429, { error: 'too many requests' }); return; }
      serveStatic(res, 'login.html');
      return;
    }

    /* ---------- first run ---------- */

    if (p === '/setup') {
      // Allowed at any time so an administrator can revisit the choices, but the
      // save is only open to a signed-in operator once the wizard has been run.
      serveStatic(res, 'setup.html');
      return;
    }

    if (p === '/api/setup') {
      if (req.method === 'GET') {
        json(res, 200, {
          done: setupDone(),
          audience: audience(),
          reach: getSetting('reach', ''),
          reachAck: getSetting('reach_ack', '') === '1',
          // A fresh server should never make somebody go hunting a console window
          // for the password that lets them in.
          needAccount: !setupDone(),
          theme: getSetting('theme_default', ''),
          presets: PRESETS.map((x) => ({ id: x.id, audience: x.audience, label: x.label, hint: x.hint, off: x.off })),
          // Both wordings travel so the wizard can re-label the checkboxes the
          // moment the audience is chosen, before anything is saved.
          modules: MODULES.map((m) => ({
            id: m.id,
            on: moduleEnabled(m.id),
            labels: { personal: wordingFor('personal', m.id), business: wordingFor('business', m.id) },
          })),
        });
        return;
      }
      if (req.method === 'POST') {
        // A server with no usable operator password cannot be signed into, so it
        // must be allowed to finish its own setup. Without this the wizard marks
        // setup done and then locks itself out of the very next step.
        if (setupDone() && !noOperatorYet()) {
          const who = requireAdmin(req, res);
          if (!who || who.kind !== 'operator') return;
        } else {
          // A brand-new server may already be on a public port, so the very first
          // run may only be completed from the machine or its own network.
          const ip = clientIp(req);
          const nearby = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
            || ip.startsWith('10.') || ip.startsWith('192.168.')
            || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
          if (!nearby) { json(res, 403, { error: 'first-run setup must be done from this machine or its network' }); return; }
        }
        const body = await readJson(req);
        const aud: Audience = String(body?.audience) === 'personal' ? 'personal' : 'business';
        const preset = PRESETS.find((x) => x.id === String(body?.preset || '') && x.audience === aud) || null;
        const chosen = Array.isArray(body?.modules) ? body.modules.map((m: any) => String(m)) : null;

        // How this server is reachable decides whether we ever ask the router for a
        // port, so it is a first-run choice rather than a preference to be found later.
        // Two release shapes and the no-internet case. 'guided' is still accepted so
        // a server configured before the rename keeps its answer.
        const reach = ['lan', 'noip', 'guided', 'manual'].includes(String(body?.reach)) ? String(body.reach) : '';
        if (reach) {
          setSetting('reach', reach);
          setSetting('reach_ack', reach === 'manual' && body?.ack === true ? '1' : '0');
          audit('system', 'setup', 'setup.reach', reach);
        }

        setSetting('audience', aud);
        const off = chosen
          ? MODULES.filter((m) => !chosen.includes(m.id)).map((m) => m.id)
          : (preset ? preset.off : []);
        setSetting('modules_off', off.join(','));

        // A personal install starts warmer; the choice is only a default and can
        // be changed per account afterwards.
        const theme = preset?.theme || '';
        if (theme) {
          setSetting('theme_default', theme);
          const operators = db.prepare("SELECT id FROM users WHERE is_operator = 1 OR role = 'admin'").all() as any[];
          for (const op of operators) setSetting('theme:' + op.id, theme);
        }

        setSetting('setup_done', '1');
        audit('system', 'setup', 'setup.finish', aud + (preset ? ' / ' + preset.id : '') + ' / off: ' + (off.join(',') || 'none'));
        json(res, 200, { ok: true, audience: aud, off, theme });
        return;
      }
    }

    /* ---------- network readiness: the five lights ---------- */

    // The same five things, in the same order and the same words as the manual.
    // Each one names its own cause, because "something went wrong" is what makes
    // people give up and ring somebody.
    if (p === '/api/network/check' && req.method === 'GET') {
      if (setupDone()) {
        const who = requireAdmin(req, res);
        if (!who || who.kind !== 'operator') return;
      } else {
        const ip = clientIp(req);
        const nearby = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
          || ip.startsWith('10.') || ip.startsWith('192.168.')
          || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
        if (!nearby) { json(res, 403, { error: 'network checks can only be run from this machine or its network' }); return; }
      }

      const checks: { id: string; label: string; state: 'ok' | 'warn' | 'fail'; detail: string }[] = [];
      const isPrivate = (ip: string) =>
        /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
        || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
      let routerIp = (MAPPING && MAPPING.publicIp) || '';
      const outsideIp = await publicIPv4().catch(() => '');

      // Facts about this network, so somebody can see their own situation instead
      // of being told to go and learn networking. Nothing here changes anything.
      const gateway = await defaultGateway().catch(() => null);
      const probe = await upnpProbe().catch(() => ({ answered: false, localIp: '', externalIp: undefined as string | undefined }));
      if (!routerIp && probe.externalIp) routerIp = probe.externalIp;
      const cgnat = !!routerIp && isPrivate(routerIp);

      if (!outsideIp) {
        checks.push({ id: 'public', label: 'A public address', state: 'fail',
          detail: 'Could not reach the internet to ask what address the world sees. Check the connection, then press Check again.' });
      } else if (routerIp && isPrivate(routerIp)) {
        checks.push({ id: 'public', label: 'A public address', state: 'fail',
          detail: 'The router reports ' + routerIp + ', which is a private address, so the internet cannot route to it. That is carrier-grade NAT: this connection cannot host a server. LAN-only mode works, and so does a different connection.' });
      } else if (routerIp && routerIp !== outsideIp) {
        checks.push({ id: 'public', label: 'A public address', state: 'warn',
          detail: 'The router reports ' + routerIp + ' but the internet sees ' + outsideIp + '. Usually a second router in the chain, or NAT in front of the first one. Forwarding can still work if only one layer is doing it.' });
      } else {
        checks.push({ id: 'public', label: 'A public address', state: 'ok',
          detail: 'The internet sees ' + outsideIp + (routerIp ? ', and the router agrees.' : '.') });
      }

      if (MAPPING && MAPPING.ok) {
        checks.push({ id: 'port', label: 'The port is open', state: 'ok',
          detail: 'Port ' + (MAPPING.externalPort || PORT) + ' is forwarded to this computer over '
            + (MAPPING.method === 'natpmp' ? 'NAT-PMP' : 'UPnP') + '.' });
      } else {
        const why = (MAPPING && MAPPING.error) || 'nothing has asked the router for a port yet';
        checks.push({ id: 'port', label: 'The port is open', state: 'fail',
          detail: 'Not forwarded: ' + why + '. If UPnP is switched off on the router, switch it on and press Check again. If the router will not forward, this is outside the supported setup.' });
      }

      const name = getSetting('ddns_host', '').trim();
      if (!name) {
        checks.push({ id: 'name', label: 'The name points here', state: 'warn',
          detail: 'No name is set. The server still works by address, but a household address changes, and a free name from No-IP or another dynamic-DNS provider is what keeps a link working \u2014 No-IP also secures it with SSL, so the address is protected as well as permanent.' });
      } else {
        // What matters is where the name actually points, not what the updater
        // remembers sending. Ask the resolver, the same way a visitor would.
        const { resolve4 } = await import('node:dns/promises');
        const resolved = await resolve4(name).catch(() => [] as string[]);
        if (!resolved.length) {
          const said = getSetting('ddns_detail', '');
          checks.push({ id: 'name', label: 'The name points here', state: 'fail',
            detail: name + ' does not resolve to any address' + (said ? ' (the updater last said: ' + said + ')' : '') + '.' });
        } else if (outsideIp && !resolved.includes(outsideIp)) {
          checks.push({ id: 'name', label: 'The name points here', state: 'warn',
            detail: name + ' resolves to ' + resolved.join(', ') + ', but the internet sees ' + outsideIp
              + '. A link through the name goes to the wrong place until it catches up.' });
        } else {
          checks.push({ id: 'name', label: 'The name points here', state: 'ok',
            detail: name + ' resolves to ' + resolved.join(', ')
              + (outsideIp ? ', which is the address the internet sees.' : '.') });
        }
      }

      // Try the address the app itself builds links with first: it is the one the
      // certificate is issued for, so a wider name would fail TLS and look broken.
      const probeHosts: string[] = [];
      try {
        const base = new URL(publicBase());
        if (base.hostname) probeHosts.push(base.hostname);
      } catch { /* ignore a malformed setting */ }
      if (name && !probeHosts.includes(name)) probeHosts.push(name);
      if (outsideIp && !probeHosts.includes(outsideIp)) probeHosts.push(outsideIp);
      const scheme = TLS_PAIR ? 'https' : 'http';
      if (MAPPING && MAPPING.ok && probeHosts.length) {
        let answered = '';
        let lastWhy = '';
        for (const host of probeHosts) {
          try {
            const r = await fetch(`${scheme}://${host}:${PORT}/health`, { signal: AbortSignal.timeout(8000) });
            const text = await r.text();
            if (r.ok && text.includes('"ok"')) { answered = host; break; }
            lastWhy = 'answered, but not as this messenger';
          } catch (err: any) {
            lastWhy = String((err && err.message) || err).slice(0, 100);
          }
        }
        if (answered) {
          checks.push({ id: 'reachable', label: 'Reachable from outside', state: 'ok',
            detail: 'A request to ' + answered + ':' + PORT + ' came back as this messenger.' });
        } else if (outsideIp && MAPPING.publicIp === outsideIp) {
          // The rule is registered and the router agrees with the address the
          // world sees. The only thing failing is the loop back from inside,
          // which is the router's limitation, not a fault in the install.
          checks.push({ id: 'reachable', label: 'Reachable from outside', state: 'warn',
            detail: 'The router holds the rule and reports the same public address the internet sees ('
              + outsideIp + ':' + PORT + '). This machine cannot loop back to its own public address, which is normal \u2014 '
              + 'confirm from a phone on mobile data. A name the certificate was not issued for will fail there and in a browser too.' });
        } else {
          checks.push({ id: 'reachable', label: 'Reachable from outside', state: 'warn',
            detail: 'Could not confirm from this machine (' + (lastWhy || 'no answer')
              + '). Many routers cannot loop back to their own public address, so test from a phone on mobile data. A name the certificate was not issued for will fail here and in a browser too.' });
        }
      } else {
        checks.push({ id: 'reachable', label: 'Reachable from outside', state: 'fail',
          detail: !outsideIp ? 'There is no public address to test.'
            : 'Nothing is forwarded, so nothing outside this network can reach it.' });
      }

      if (TLS_PAIR) {
        checks.push({ id: 'certificate', label: 'A trusted certificate', state: 'ok',
          detail: 'HTTPS is on' + (getSetting('tls_name', '') ? ' for ' + getSetting('tls_name', '') : '') + '.' });
      } else {
        checks.push({ id: 'certificate', label: 'A trusted certificate', state: 'warn',
          detail: 'This server speaks plain HTTP. Over the internet that means passwords cross in clear text, so use LAN-only mode or finish the certificate before inviting anyone. A free No-IP account gives you both the name and the SSL that secures it; another dynamic-DNS provider can serve the same purpose.' });
      }

      const state = checks.some((c) => c.state === 'fail') ? 'fail'
        : checks.some((c) => c.state === 'warn') ? 'warn' : 'ok';
      json(res, 200, {
        state,
        reach: getSetting('reach', ''),
        reachAck: getSetting('reach_ack', '') === '1',
        port: PORT,
        publicIp: outsideIp,
        routerIp,
        name,
        network: {
          lan: probe.localIp || lanAddresses()[0] || '',
          gateway: gateway || '',
          routerWan: routerIp,
          outsideIp,
          cgnat,
          upnp: probe.answered ? 'yes' : 'no',
        },
        checks,
        checkedAt: now(),
      });
      return;
    }

    /* ---------- first run: the administrator account ---------- */

    // The seeded operator exists from the first start, but its password may have
    // been printed to a console nobody was watching. This lets the person doing
    // the setup choose their own before they are ever asked to sign in.
    if (p === '/api/setup/account' && req.method === 'POST') {
      // Same rule as the wizard's save: until somebody can actually sign in, the
      // creation of that first account has to be reachable from this network.
      if (setupDone() && !noOperatorYet()) {
        const who = requireAdmin(req, res);
        if (!who || who.kind !== 'operator') return;
      } else {
        const ip = clientIp(req);
        const nearby = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
          || ip.startsWith('10.') || ip.startsWith('192.168.')
          || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
        if (!nearby) { json(res, 403, { error: 'this can only be done from this machine or its network' }); return; }
      }

      const body = await readJson(req);
      const name = String(body?.name || '').trim().slice(0, 80);
      const username = String(body?.username || '').trim().toLowerCase().slice(0, 60);
      const password = String(body?.password || '');

      if (!name) { json(res, 400, { error: 'a name is required' }); return; }
      if (username && !/^[a-z0-9][a-z0-9._-]{1,59}$/.test(username)) {
        json(res, 400, { error: 'a username may use letters, numbers, dots, dashes and underscores' }); return;
      }
      if (password.length < 8) { json(res, 400, { error: 'the password needs at least eight characters' }); return; }

      const op = db.prepare("SELECT * FROM users WHERE is_operator = 1 LIMIT 1").get() as any;
      if (!op) { json(res, 400, { error: 'this server has no administrator to set up' }); return; }
      if (username) {
        const taken = db.prepare("SELECT id FROM users WHERE lower(username) = ? AND id <> ?").get(username, op.id) as any;
        if (taken) { json(res, 409, { error: 'that username is already taken' }); return; }
      }

      db.prepare("UPDATE users SET display_name = ?, username = ?, password_hash = ? WHERE id = ?")
        .run(name, username || null, scryptHash(password), op.id);
      setSetting('account_ready', '1');
      setSetting('reopen_setup', '0');
      audit('system', 'setup', 'setup.account', name + (username ? ' (' + username + ')' : ''));
      // Sign them in on the spot: the account they just created is the one they
      // would otherwise be asked for on the next screen, for no good reason.
      startSession(res, op.id, getSetting('require_2fa', '0') === '1');
      json(res, 200, { ok: true, name, username });
      return;
    }

    if (p === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req);
      // An office shares one address, so the per-address allowance is generous;
      // guessing is stopped per account instead.
      if (!allow('login:ip:' + ip, 40)) {
        recordSignin(req, { ok: false, note: 'too many attempts from this address' });
        json(res, 429, { error: 'too many attempts' }); return;
      }
      const body = await readJson(req);
      const password = String(body?.password || '');
      const handle = String(body?.username || body?.email || '').trim().toLowerCase();
      if (handle && !allow('login:user:' + handle, 8)) {
        recordSignin(req, { handle, ok: false, note: 'too many attempts for this account' });
        json(res, 429, { error: 'too many attempts' }); return;
      }
      // Any team account signs in with its username or email address.
      let user: any = null;
      if (handle) {
        user = db.prepare(
          `SELECT * FROM users WHERE lower(email)=? OR lower(username)=? LIMIT 1`
        ).get(handle, handle) as any;
        // The seeded administrator also answers to "admin" and "operator".
        if (!user && (handle === 'admin' || handle === 'operator')) {
          user = db.prepare(`SELECT * FROM users WHERE is_operator=1 LIMIT 1`).get() as any;
        }
      }
      const named = blockForName(handle, user && user.username, user && user.email, user && user.display_name);
      if (named) {
        recordSignin(req, {
          userId: user ? user.id : '', userName: user ? user.display_name : '',
          handle, ok: false, note: 'blocked',
        });
        json(res, 403, { error: 'this account is blocked' });
        return;
      }
      if (!user || user.disabled || !scryptVerify(password, user.password_hash)) {
        recordSignin(req, {
          userId: user ? user.id : '',
          userName: user ? user.display_name : '',
          handle,
          ok: false,
          note: !user ? 'no such account' : user.disabled ? 'account disabled' : 'wrong password',
        });
        json(res, 401, { error: 'invalid credentials' });
        return;
      }
      db.prepare(`UPDATE users SET last_seen=? WHERE id=?`).run(now(), user.id);
      if (Number(user.totp_enabled) === 1) {
        const ticket = newToken();
        db.prepare(`INSERT INTO twofa_tickets(token_hash, user_id, expires_at) VALUES(?,?,?)`)
          .run(sha256(ticket), user.id, now() + 5 * 60 * 1000);
        json(res, 200, { ok: false, twoFactor: true, ticket });
        return;
      }
      recordSignin(req, { userId: user.id, userName: user.display_name, handle, ok: true, note: 'password' });
      startSession(res, user.id, getSetting('require_2fa', '0') === '1');
      json(res, 200, { ok: true });
      return;
    }

    if (p === '/api/login/2fa' && req.method === 'POST') {
      const ip = clientIp(req);
      if (!allow('login2fa:' + ip, 12)) { json(res, 429, { error: 'too many attempts' }); return; }
      const body = await readJson(req);
      const ticket = String(body?.ticket || '');
      const code = String(body?.code || '');
      const row = ticket
        ? db.prepare(`SELECT * FROM twofa_tickets WHERE token_hash=?`).get(sha256(ticket)) as any
        : null;
      if (!row || row.expires_at < now()) {
        recordSignin(req, { ok: false, note: 'two-factor sign-in timed out' });
        json(res, 401, { error: 'that sign-in timed out, start again' }); return;
      }
      const user = db.prepare(`SELECT * FROM users WHERE id=?`).get(row.user_id) as any;
      if (!user || Number(user.totp_enabled) !== 1) { json(res, 401, { error: 'invalid code' }); return; }
      if (!totpVerify(user.totp_secret, code)) { json(res, 401, { error: 'That code is not right' }); return; }
      db.prepare(`DELETE FROM twofa_tickets WHERE token_hash=?`).run(row.token_hash);
      db.prepare(`UPDATE users SET last_seen=? WHERE id=?`).run(now(), user.id);
      recordSignin(req, { userId: user.id, userName: user.display_name, handle: (user.username || user.email || ''), ok: true, note: 'two-factor' });
      startSession(res, user.id, false);
      json(res, 200, { ok: true });
      return;
    }

    if (p === '/api/magic' && req.method === 'POST') {
      const ip = clientIp(req);
      if (!allow('magic:' + ip, 5)) { json(res, 429, { error: 'too many requests' }); return; }
      const body = await readJson(req);
      const email = String(body?.email || '').trim().toLowerCase();
      const user = db.prepare(`SELECT * FROM users WHERE is_operator=1 LIMIT 1`).get() as any;
      // Always answer the same way so the endpoint cannot confirm an address.
      if (user && email && email === (user.email || '').toLowerCase()) {
        const token = newToken();
        db.prepare(`INSERT INTO login_tokens(token_hash, user_id, expires_at) VALUES(?,?,?)`)
          .run(sha256(token), user.id, now() + 1000 * 60 * 15);
        await sendMail(user.email, 'Your sign-in link',
          `Open this link to sign in:\n${publicBase()}/magic/${token}\n\nIt expires in 15 minutes.`);
      }
      json(res, 200, { ok: true });
      return;
    }

    if (p.startsWith('/magic/')) {
      const token = p.slice('/magic/'.length);
      const row = db.prepare(`SELECT * FROM login_tokens WHERE token_hash=?`).get(sha256(token)) as any;
      if (!row || row.expires_at < now()) { json(res, 400, { error: 'link expired' }); return; }
      db.prepare(`DELETE FROM login_tokens WHERE token_hash=?`).run(row.token_hash);
      const linkUser = db.prepare(`SELECT totp_enabled FROM users WHERE id=?`).get(row.user_id) as any;
      startSession(res, row.user_id,
        getSetting('require_2fa', '0') === '1' && !Number(linkUser?.totp_enabled));
      res.writeHead(302, { Location: '/app' });
      res.end();
      return;
    }

    if (p === '/api/logout' && req.method === 'POST') {
      const cookies = parseCookies(req.headers.cookie);
      const sess = cookies[SESS_COOKIE];
      if (sess) {
        const i = sess.lastIndexOf('.');
        if (i > 0) db.prepare(`DELETE FROM sessions WHERE id=?`).run(sess.slice(0, i));
      }
      clearCookie(res, SESS_COOKIE);
      json(res, 200, { ok: true });
      return;
    }

    if (p === '/signup') {
      serveStatic(res, 'signup.html');
      return;
    }

    if (p === '/app') {
      const a = resolveAuth(req);
      if (!a || a.kind !== 'operator') { res.writeHead(302, { Location: '/login' }); res.end(); return; }
      serveStatic(res, 'app.html');
      return;
    }

    // The administration panel is a separate page, reachable only by admins.
    if (p === '/admin') {
      const a = resolveAuth(req);
      if (!a || a.kind !== 'operator') { res.writeHead(302, { Location: '/login' }); res.end(); return; }
      if (!a.admin) { res.writeHead(302, { Location: '/app' }); res.end(); return; }
      serveStatic(res, 'admin.html');
      return;
    }

    /* ---------- invite links ---------- */

    if (p.startsWith('/j/')) {
      if (!allow('join:' + clientIp(req), 30)) { json(res, 429, { error: 'too many requests' }); return; }
      const token = decodeURIComponent(p.slice(3));
      const hash = sha256(token);
      const client = db.prepare(`SELECT * FROM clients WHERE link_token_hash=?`).get(hash) as any;
      if (!client || client.revoked_at) {
        // No distinction between unknown and revoked, and no names leak here.
        serveStatic(res, 'invalid.html');
        return;
      }
      setCookie(res, CLIENT_COOKIE, token, 60 * 60 * 24 * 180);
      conversationForClient(client.id);
      res.writeHead(302, { Location: '/thread' });
      res.end();
      return;
    }

    if (p === '/thread') {
      const a = resolveAuth(req);
      if (!a || a.kind !== 'client') { res.writeHead(302, { Location: '/login' }); res.end(); return; }
      serveStatic(res, 'client.html');
      return;
    }

    if (p.startsWith('/stop/')) {
      const token = p.slice('/stop/'.length);
      const client = db.prepare(`SELECT * FROM clients WHERE link_token_hash=?`).get(token) as any;
      if (client?.email) suppress(client.email);
      serveStatic(res, 'invalid.html');
      return;
    }

    /* ---------- client identity ---------- */

    if (p === '/api/client/notifications/stop' && req.method === 'POST') {
      const a = resolveAuth(req);
      if (!a || a.kind !== 'client') { json(res, 401, { error: 'unauthorized' }); return; }
      const client = db.prepare(`SELECT email FROM clients WHERE id=?`).get(a.clientId) as any;
      if (client?.email) suppress(client.email);
      json(res, 200, { ok: true });
      return;
    }

    if (p === '/api/client/identify' && req.method === 'POST') {
      const a = resolveAuth(req);
      if (!a || a.kind !== 'client') { json(res, 401, { error: 'unauthorized' }); return; }
      const body = await readJson(req);
      const name = String(body?.name || '').trim().slice(0, 40);
      const email = String(body?.email || '').trim().toLowerCase().slice(0, 120);
      if (!name) { json(res, 400, { error: 'name required' }); return; }
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { json(res, 400, { error: 'invalid email' }); return; }
      db.prepare(`UPDATE clients SET display_name=?, email=? WHERE id=?`).run(name, email || null, a.clientId);
      const conv = conversationForClient(a.clientId);
      json(res, 200, { ok: true, conversationId: conv.id });
      return;
    }

    /* ---------- bootstrap ---------- */

    if (p === '/api/bootstrap') {
      const a = resolveAuth(req);
      if (!a) { json(res, 401, { error: 'unauthorized' }); return; }

      if (a.kind === 'client') {
        const client = db.prepare(`SELECT * FROM clients WHERE id=?`).get(a.clientId) as any;
        const conv = conversationForClient(a.clientId);
        json(res, 200, {
          kind: 'client',
          me: {
            name: client.display_name,
            email: client.email,
            clientId: client.id,
            conversationId: conv?.id || null,
            spaceId: client.space_id,
          },
          operatorOnline: isOperatorOnline(),
        });
        return;
      }

      // Colleagues: everyone else active, with their presence and 1:1 thread.
      const people = (db.prepare(
        `SELECT id, display_name, status, status_text, department_id FROM users
          WHERE id<>? AND disabled=0 ORDER BY display_name COLLATE NOCASE`
      ).all(a.userId) as any[]).map((u) => {
        const dm = db.prepare(
          `SELECT c.id FROM conversations c
            WHERE c.kind='direct' AND c.client_id IS NULL
              AND EXISTS(SELECT 1 FROM participants p WHERE p.conversation_id=c.id AND p.participant_type='operator' AND p.participant_id=?)
              AND EXISTS(SELECT 1 FROM participants p WHERE p.conversation_id=c.id AND p.participant_type='operator' AND p.participant_id=?)
              AND (SELECT COUNT(*) FROM participants p WHERE p.conversation_id=c.id)=2
            LIMIT 1`
        ).get(a.userId, u.id) as any;
        const dept = u.department_id
          ? db.prepare(`SELECT name FROM departments WHERE id=?`).get(u.department_id) as any
          : null;
        const summary = dm ? conversationSummary(dm.id, a.userId) : { lastMessage: '', lastAt: 0, unread: 0 };
        const online = isUserOnline(u.id);
        const manual = u.status || 'Online';
        return {
          userId: u.id,
          name: u.display_name,
          dmId: dm?.id || null,
          online,
          status: online ? (manual === 'Offline' ? 'Online' : manual) : 'Offline',
          statusText: u.status_text || '',
          department: dept?.name || null,
          ...summary,
        };
      });

      // Groups with a fixed member list that I belong to.
      const groups = (db.prepare(
        `SELECT c.* FROM conversations c
           JOIN participants p ON p.conversation_id=c.id
          WHERE c.kind='room' AND c.visibility='members' AND c.announce_only=0 AND c.space_id=?
            AND p.participant_type='operator' AND p.participant_id=?
          ORDER BY c.created_at ASC`
      ).all(businessSpaceId(), a.userId) as any[]).map((g) => {
        const count = db.prepare(
          `SELECT COUNT(*) AS c FROM participants WHERE conversation_id=? AND participant_type='operator'`
        ).get(g.id) as any;
        return {
          conversationId: g.id,
          kind: 'group',
          name: g.title || 'Group',
          members: Number(count?.c || 0),
          ...conversationSummary(g.id, a.userId),
        };
      });

      // Admin-only: the client threads that live in this space.
      const clients = a.admin
        ? db.prepare(`SELECT * FROM clients WHERE space_id=? ORDER BY created_at DESC`)
            .all(businessSpaceId()) as any[]
        : [];

      const contacts = clients.map((c) => {
        const conv = conversationForClient(c.id);
        const last = db.prepare(
          `SELECT m.body, m.created_at, m.sender_type, m.kind FROM messages m
            WHERE m.conversation_id=? ORDER BY m.seq DESC LIMIT 1`
        ).get(conv.id) as any;
        const convRow = db.prepare(`SELECT archived_at FROM conversations WHERE id=?`).get(conv.id) as any;
        return {
          clientId: c.id,
          conversationId: conv.id,
          name: c.display_name || 'Unnamed client',
          email: c.email || null,
          status: c.display_name ? (isOnlineClient(c.id) ? 'Online' : 'Offline') : 'Invited',
          unread: unreadFor(conv.id, a.userId, true),
          archived: !!convRow?.archived_at,
          lastMessage: last ? (last.kind === 'file' ? '[file] ' + (last.body || '') : last.body) : '',
          lastAt: last ? last.created_at : conv.created_at,
        };
      });

      const roomRows = db.prepare(
        `SELECT * FROM conversations WHERE kind='room' AND visibility<>'members' AND space_id=? ORDER BY created_at ASC`
      ).all(businessSpaceId()) as any[];
      const rooms = roomRows.map((r) => {
        const guests = db.prepare(
          `SELECT COUNT(*) AS c FROM room_guests WHERE conversation_id=?`
        ).get(r.id) as any;
        const staff = db.prepare(
          `SELECT COUNT(*) AS c FROM participants WHERE conversation_id=? AND participant_type='operator'`
        ).get(r.id) as any;
        return {
          conversationId: r.id,
          kind: 'room',
          name: r.title || 'Room',
          members: Number(guests?.c || 0) + Number(staff?.c || 0),
          ...conversationSummary(r.id, a.userId),
        };
      });

      // Team-wide announcements thread, plus my own pending reminders.
      const annConv = announcementConversation();
      const announcements = {
        conversationId: annConv.id,
        name: annConv.title || 'Announcements',
        canPost: a.admin,
        ...conversationSummary(annConv.id, a.userId),
      };
      const remindersDue = Number((db.prepare(
        `SELECT COUNT(*) AS c FROM reminders WHERE user_id=? AND done=0 AND due_at<=?`
      ).get(a.userId, now()) as any)?.c || 0);

      const me = db.prepare(`SELECT * FROM users WHERE id=?`).get(a.userId) as any;
      const myDept = me.department_id
        ? db.prepare(`SELECT id, name FROM departments WHERE id=?`).get(me.department_id) as any
        : null;
      json(res, 200, {
        kind: 'operator',
        me: {
          id: me.id,
          name: me.display_name,
          email: me.email,
          role: a.role,
          admin: a.admin,
          // A stored "Offline" only means no device was connected last time.
          status: !me.status || me.status === 'Offline' ? 'Online' : me.status,
          statusMessage: me.status_text || '',
          autoReply: me.auto_reply || '',
          departmentId: myDept?.id || null,
          department: myDept?.name || null,
          flags: userFlags(me.id),
          needs2fa: !!a.needs2fa,
          twoFactor: Number(me.totp_enabled) === 1,
        },
        announcements,
        remindersDue,
        mailUnread: mailUnread(a.userId),
        ticketsOpen: a.admin
          ? Number((db.prepare(`SELECT COUNT(*) AS c FROM tickets WHERE status<>'resolved'`).get() as any)?.c || 0)
          : 0,
                  modules: modulesState(),
          theme: getSetting('theme:' + me.id, ''),
          settings: { otrAllowed: getSetting('otr_allowed', '1') === '1' },
        people,
        groups,
        contacts,
        rooms,
        canned: db.prepare(`SELECT shortcut, body FROM canned ORDER BY shortcut`).all(),
        departments: db.prepare(`SELECT id, name FROM departments ORDER BY name`).all(),
        spaces: db.prepare(`SELECT id, type, name FROM spaces ORDER BY type`).all(),
        accessUrls: [...(MAPPED_URL ? [MAPPED_URL] : []), `http://localhost:${PORT}`, ...lanAddresses().map((ip) => `http://${ip}:${PORT}`)],
        publicUrl: MAPPED_URL || null,
      });
      return;
    }

    /* ---------- team: direct chats, groups ---------- */

    if (p === '/api/dm' && req.method === 'POST') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const body = await readJson(req);
      const target = db.prepare(
        `SELECT id, display_name FROM users WHERE id=? AND disabled=0`
      ).get(String(body?.userId || '')) as any;
      if (!target) { json(res, 404, { error: 'no such person' }); return; }
      if (target.id === a.userId) { json(res, 400, { error: 'that is you' }); return; }
      const refusal = directChatRefusal(a, target.id);
      if (refusal) { json(res, 403, { error: refusal }); return; }
      const conv = directConversation(a.userId, target.id);
      json(res, 200, { ok: true, conversationId: conv.id, name: target.display_name });
      return;
    }

    if (p === '/api/groups' && req.method === 'POST') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const body = await readJson(req);
      const title = String(body?.title || '').trim().slice(0, 60);
      if (!title) { json(res, 400, { error: 'Group name is required.' }); return; }
      const wanted = Array.isArray(body?.memberIds) ? body.memberIds.map(String) : [];
      const memberSet = new Set<string>([a.userId]);
      for (const uid of wanted) {
        const row = db.prepare(`SELECT id FROM users WHERE id=? AND disabled=0`).get(uid) as any;
        if (row) memberSet.add(row.id);
      }

      const gid = id();
      db.prepare(
        `INSERT INTO conversations(id, space_id, client_id, kind, title, archived_at, created_at, visibility)
         VALUES(?,?,NULL,'room',?,NULL,?,'members')`
      ).run(gid, businessSpaceId(), title, now());
      for (const uid of memberSet) {
        db.prepare(
          `INSERT INTO participants(conversation_id, participant_type, participant_id, last_read_seq, joined_at)
           VALUES(?, 'operator', ?, 0, ?)`
        ).run(gid, uid, now());
      }
      sendToStaff({ t: 'refresh' });
      json(res, 200, { ok: true, id: gid, title, members: [...memberSet] });
      return;
    }

    let gm: RegExpMatchArray | null;

    if ((gm = p.match(/^\/api\/groups\/([^/]+)\/members$/)) && req.method === 'GET') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const conv = conversationAccess(a, gm[1]);
      if (!conv) { json(res, 404, { error: 'not found' }); return; }
      const rows = db.prepare(
        `SELECT u.id, u.display_name, u.status, u.status_text FROM participants p
           JOIN users u ON u.id = p.participant_id
          WHERE p.conversation_id=? AND p.participant_type='operator' ORDER BY u.display_name COLLATE NOCASE`
      ).all(conv.id) as any[];
      json(res, 200, rows.map((u) => ({
        userId: u.id,
        name: u.display_name,
        status: isUserOnline(u.id) ? (u.status || 'Online') : 'Offline',
        statusText: u.status_text || '',
      })));
      return;
    }

    if ((gm = p.match(/^\/api\/groups\/([^/]+)\/members$/)) && req.method === 'POST') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const conv = conversationAccess(a, gm[1]);
      if (!conv) { json(res, 404, { error: 'not found' }); return; }
      if (conv.visibility !== 'members') { json(res, 400, { error: 'not a group' }); return; }
      const body = await readJson(req);
      const add = Array.isArray(body?.add) ? body.add.map(String) : [];
      const remove = Array.isArray(body?.remove) ? body.remove.map(String) : [];
      for (const uid of add) {
        const u = db.prepare(`SELECT id FROM users WHERE id=? AND disabled=0`).get(uid) as any;
        if (!u) continue;
        db.prepare(
          `INSERT INTO participants(conversation_id, participant_type, participant_id, last_read_seq, joined_at)
           VALUES(?, 'operator', ?, 0, ?) ON CONFLICT DO NOTHING`
        ).run(conv.id, uid, now());
      }
      for (const uid of remove) {
        if (uid === a.userId) { json(res, 400, { error: 'Leave from the menu instead.' }); return; }
        db.prepare(
          `DELETE FROM participants WHERE conversation_id=? AND participant_type='operator' AND participant_id=?`
        ).run(conv.id, uid);
      }
      sendToStaff({ t: 'refresh' });
      json(res, 200, { ok: true });
      return;
    }

    if ((gm = p.match(/^\/api\/groups\/([^/]+)\/leave$/)) && req.method === 'POST') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const conv = conversationAccess(a, gm[1]);
      if (!conv || conv.visibility !== 'members') { json(res, 404, { error: 'not found' }); return; }
      db.prepare(
        `DELETE FROM participants WHERE conversation_id=? AND participant_type='operator' AND participant_id=?`
      ).run(conv.id, a.userId);
      sendToStaff({ t: 'refresh' });
      json(res, 200, { ok: true });
      return;
    }

    /* ---------- administration ---------- */

    if (p === '/api/admin/users' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      const rows = db.prepare(
        `SELECT u.id, u.display_name, u.email, u.username, u.role, u.is_operator, u.disabled,
                u.status, u.status_text, u.department_id, u.last_seen, u.created_at,
                u.totp_enabled, u.allow_files, u.allow_calls, u.allow_otr, u.allow_drive,
                d.name AS department
           FROM users u LEFT JOIN departments d ON d.id = u.department_id
          ORDER BY u.is_operator DESC, u.display_name COLLATE NOCASE`
      ).all() as any[];
      json(res, 200, rows.map((u) => ({
        id: u.id,
        name: u.display_name,
        email: u.email,
        username: u.username,
        role: u.is_operator ? 'admin' : (u.role || 'member'),
        disabled: !!u.disabled,
        online: isUserOnline(u.id),
        status: u.status || 'Online',
        statusText: u.status_text || '',
        departmentId: u.department_id,
        department: u.department || null,
        lastSeen: u.last_seen || 0,
        createdAt: u.created_at,
        twoFactor: Number(u.totp_enabled) === 1,
        flags: {
          files: Number(u.allow_files) !== 0,
          calls: Number(u.allow_calls) !== 0,
          otr: Number(u.allow_otr) !== 0,
          drive: Number(u.allow_drive) !== 0,
        },
      })));
      return;
    }

    // Self sign-up. The whole path is gated by the 'signup' module above, so
    // when it is switched off this answers 404 exactly like an absent feature.
    if (p === '/api/signup') {
      if (req.method === 'GET') {
        json(res, 200, { open: true });
        return;
      }
      if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return; }
      if (!allow('signup:' + clientIp(req), 5)) {
        json(res, 429, { error: 'Too many attempts. Try again in a few minutes.' }); return;
      }
      const body = await readJson(req);
      const name = String(body?.name || '').trim().slice(0, 60);
      const email = String(body?.email || '').trim().toLowerCase().slice(0, 120);
      const password = String(body?.password || '');
      if (name.length < 2) { json(res, 400, { error: 'Enter your name.' }); return; }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        json(res, 400, { error: 'Enter a valid email address.' }); return;
      }
      if (password.length < 8) {
        json(res, 400, { error: 'Choose a password of at least 8 characters.' }); return;
      }
      if (db.prepare(`SELECT 1 AS x FROM users WHERE lower(email)=?`).get(email)) {
        json(res, 409, { error: 'That email already has an account.' }); return;
      }
      const uid = id();
      db.prepare(
        `INSERT INTO users(id, email, username, display_name, password_hash, role, is_operator,
           department_id, disabled, status, status_text, created_at,
           allow_files, allow_calls, allow_otr, allow_drive)
         VALUES(?,?,NULL,?,?,'member',0,NULL,0,'Online','',?,1,1,1,1)`
      ).run(uid, email, name, scryptHash(password), now());
      audit(uid, name, 'user.signup', `${name} (${email}) created their own account`);
      json(res, 200, { ok: true, email });
      return;
    }

    if (p === '/api/admin/users' && req.method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      const body = await readJson(req);
      const name = String(body?.name || '').trim().slice(0, 60);
      const email = String(body?.email || '').trim().toLowerCase().slice(0, 120);
      const username = String(body?.username || '').trim().toLowerCase().slice(0, 40);
      const password = String(body?.password || '');
      const role = String(body?.role || 'member');
      const departmentId = body?.departmentId ? String(body.departmentId) : null;

      if (!name) { json(res, 400, { error: 'Name is required.' }); return; }
      if (password.length < 6) { json(res, 400, { error: 'Password must be at least 6 characters.' }); return; }
      if (!username && !email) { json(res, 400, { error: 'A username or email is required.' }); return; }
      if (!['manager', 'member'].includes(role)) { json(res, 400, { error: 'Choose manager or member.' }); return; }
      if (username && db.prepare(`SELECT 1 AS x FROM users WHERE lower(username)=?`).get(username)) {
        json(res, 409, { error: 'That username is taken.' }); return;
      }
      if (email && db.prepare(`SELECT 1 AS x FROM users WHERE lower(email)=?`).get(email)) {
        json(res, 409, { error: 'That email is already in use.' }); return;
      }

      const uid = id();
      const f = (body?.flags && typeof body.flags === 'object') ? body.flags : {};
      db.prepare(
        `INSERT INTO users(id, email, username, display_name, password_hash, role, is_operator,
           department_id, disabled, status, status_text, created_at,
           allow_files, allow_calls, allow_otr, allow_drive)
         VALUES(?,?,?,?,?,?,0,?,0,'Online','',?,?,?,?,?)`
      ).run(uid, email || null, username || null, name, scryptHash(password), role, departmentId, now(),
        f.files === false ? 0 : 1, f.calls === false ? 0 : 1, f.otr === false ? 0 : 1, f.drive === false ? 0 : 1);
      audit(admin.userId, admin.name, 'user.create', `${name} (${username || email}) as ${role}`);
      json(res, 200, { ok: true, id: uid });
      return;
    }

    let um: RegExpMatchArray | null;

    if ((um = p.match(/^\/api\/admin\/users\/([^/]+)$/)) && req.method === 'PATCH') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      const user = db.prepare(`SELECT * FROM users WHERE id=?`).get(um[1]) as any;
      if (!user) { json(res, 404, { error: 'not found' }); return; }
      const body = await readJson(req);
      const changes: any[] = [];
      const sets: string[] = [];

      if (body?.name !== undefined) {
        const name = String(body.name).trim().slice(0, 60);
        if (!name) { json(res, 400, { error: 'Name cannot be empty.' }); return; }
        sets.push('display_name=?'); changes.push(name);
      }
      if (body?.email !== undefined) {
        const email = String(body.email).trim().toLowerCase().slice(0, 120);
        if (email && db.prepare(`SELECT 1 AS x FROM users WHERE lower(email)=? AND id<>?`).get(email, user.id)) {
          json(res, 409, { error: 'That email is already in use.' }); return;
        }
        sets.push('email=?'); changes.push(email || null);
      }
      if (body?.username !== undefined) {
        const username = String(body.username).trim().toLowerCase().slice(0, 40);
        if (username && db.prepare(`SELECT 1 AS x FROM users WHERE lower(username)=? AND id<>?`).get(username, user.id)) {
          json(res, 409, { error: 'That username is taken.' }); return;
        }
        sets.push('username=?'); changes.push(username || null);
      }
      if (body?.departmentId !== undefined) {
        sets.push('department_id=?'); changes.push(body.departmentId ? String(body.departmentId) : null);
      }
      if (body?.disabled !== undefined) {
        if (Number(user.is_operator) === 1 && body.disabled) {
          json(res, 400, { error: 'The administrator account cannot be disabled.' }); return;
        }
        sets.push('disabled=?'); changes.push(body.disabled ? 1 : 0);
      }
      if (body?.password !== undefined) {
        const password = String(body.password);
        if (password.length < 6) { json(res, 400, { error: 'Password must be at least 6 characters.' }); return; }
        sets.push('password_hash=?'); changes.push(scryptHash(password));
      }
      if (body?.flags && typeof body.flags === 'object') {
        for (const [key, column] of [
          ['files', 'allow_files'],
          ['otr', 'allow_otr'], ['drive', 'allow_drive'],
        ] as [string, string][]) {
          if (body.flags[key] === undefined) continue;
          sets.push(`${column}=?`);
          changes.push(body.flags[key] ? 1 : 0);
        }
      }
      if (body?.role !== undefined) {
        const role = String(body.role);
        if (role === 'admin') {
          if (Number(user.is_operator) === 1) { /* already admin */ }
          sets.push('is_operator=?'); changes.push(1);
        } else if (['manager', 'member'].includes(role)) {
          if (Number(user.is_operator) === 1) {
            json(res, 400, { error: 'The primary administrator stays an admin.' }); return;
          }
          sets.push('role=?'); changes.push(role);
        } else {
          json(res, 400, { error: 'Unknown role.' }); return;
        }
      }

      if (!sets.length) { json(res, 400, { error: 'nothing to change' }); return; }
      changes.push(user.id);
      db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id=?`).run(...changes);
      if (body?.disabled) db.prepare(`DELETE FROM sessions WHERE user_id=?`).run(user.id);
      audit(admin.userId, admin.name, 'user.update', `${user.display_name}: ${sets.join(', ')}`);
      sendToStaff({ t: 'refresh' });
      json(res, 200, { ok: true });
      return;
    }

    if ((um = p.match(/^\/api\/admin\/users\/([^/]+)\/2fa$/)) && req.method === 'DELETE') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      const user = db.prepare(`SELECT id, display_name FROM users WHERE id=?`).get(um[1]) as any;
      if (!user) { json(res, 404, { error: 'not found' }); return; }
      db.prepare(`UPDATE users SET totp_secret=NULL, totp_enabled=0 WHERE id=?`).run(user.id);
      db.prepare(`DELETE FROM sessions WHERE user_id=?`).run(user.id);
      audit(admin.userId, admin.name, '2fa.reset', user.display_name);
      json(res, 200, { ok: true });
      return;
    }

    if ((um = p.match(/^\/api\/admin\/users\/([^/]+)$/)) && req.method === 'DELETE') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      const user = db.prepare(`SELECT * FROM users WHERE id=?`).get(um[1]) as any;
      if (!user) { json(res, 404, { error: 'not found' }); return; }
      if (user.id === admin.userId) { json(res, 400, { error: 'You cannot delete your own account.' }); return; }
      if (Number(user.is_operator) === 1) { json(res, 400, { error: 'The administrator cannot be deleted here.' }); return; }
      db.prepare(`DELETE FROM sessions WHERE user_id=?`).run(user.id);
      db.prepare(`DELETE FROM login_tokens WHERE user_id=?`).run(user.id);
      const convs = db.prepare(
        `SELECT DISTINCT conversation_id FROM participants WHERE participant_type='operator' AND participant_id=?`
      ).all(user.id) as any[];
      db.prepare(`DELETE FROM participants WHERE participant_type='operator' AND participant_id=?`).run(user.id);
      for (const c of convs) {
        const left = db.prepare(`SELECT COUNT(*) AS c FROM participants WHERE conversation_id=?`).get(c.conversation_id) as any;
        if (Number(left?.c)) continue;
        // Nobody is left in it, so the thread and its files go too.
        purgeMessages(c.conversation_id);
        db.prepare(`DELETE FROM participants WHERE conversation_id=?`).run(c.conversation_id);
        db.prepare(`DELETE FROM conversations WHERE id=?`).run(c.conversation_id);
      }
      db.prepare(`DELETE FROM users WHERE id=?`).run(user.id);
      audit(admin.userId, admin.name, 'user.delete', user.display_name);
      sendToStaff({ t: 'refresh' });
      json(res, 200, { ok: true });
      return;
    }

    if (p === '/api/admin/departments' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      const rows = db.prepare(
        `SELECT d.id, d.name, (SELECT COUNT(*) FROM users u WHERE u.department_id=d.id) AS people
           FROM departments d ORDER BY d.name`
      ).all() as any[];
      json(res, 200, rows.map((r) => ({ id: r.id, name: r.name, people: Number(r.people) })));
      return;
    }

    if (p === '/api/admin/departments' && req.method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const body = await readJson(req);
      const name = String(body?.name || '').trim().slice(0, 60);
      if (!name) { json(res, 400, { error: 'Name is required.' }); return; }
      if (db.prepare(`SELECT 1 AS x FROM departments WHERE lower(name)=lower(?)`).get(name)) {
        json(res, 409, { error: 'That department already exists.' }); return;
      }
      const did = id();
      db.prepare(`INSERT INTO departments(id, name, created_at) VALUES(?,?,?)`).run(did, name, now());
      if (admin.kind === 'operator') audit(admin.userId, admin.name, 'department.create', name);
      json(res, 200, { ok: true, id: did, name });
      return;
    }

    if ((um = p.match(/^\/api\/admin\/departments\/([^/]+)$/)) && req.method === 'DELETE') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const row = db.prepare(`SELECT name FROM departments WHERE id=?`).get(um[1]) as any;
      db.prepare(`UPDATE users SET department_id=NULL WHERE department_id=?`).run(um[1]);
      db.prepare(`DELETE FROM departments WHERE id=?`).run(um[1]);
      if (row && admin.kind === 'operator') audit(admin.userId, admin.name, 'department.delete', row.name);
      json(res, 200, { ok: true });
      return;
    }

    if (p === '/api/admin/audit' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      const rows = db.prepare(
        `SELECT id, user_name, action, detail, created_at FROM audit_log ORDER BY created_at DESC LIMIT 300`
      ).all() as any[];
      json(res, 200, rows.map((r) => ({
        id: r.id, who: r.user_name || 'system', action: r.action, detail: r.detail || '', at: r.created_at,
      })));
      return;
    }

    if (p === '/api/admin/overview' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      const count = (sql: string) => Number((db.prepare(sql).get() as any)?.c || 0);
      json(res, 200, {
        users: count(`SELECT COUNT(*) AS c FROM users`),
        activeUsers: count(`SELECT COUNT(*) AS c FROM users WHERE disabled=0`),
        online: [...presence.keys()].filter((k) => k.startsWith('u:')).length,
        departments: count(`SELECT COUNT(*) AS c FROM departments`),
        clients: count(`SELECT COUNT(*) AS c FROM clients WHERE revoked_at IS NULL`),
        rooms: count(`SELECT COUNT(*) AS c FROM conversations WHERE kind='room'`),
        messages: count(`SELECT COUNT(*) AS c FROM messages`),
        files: count(`SELECT COUNT(*) AS c FROM attachments`),
        storedBytes: Number((db.prepare(`SELECT COALESCE(SUM(bytes),0) AS c FROM attachments`).get() as any)?.c || 0),
        port: PORT,
        lan: lanAddresses().map((ip) => `http://${ip}:${PORT}`),
        linksUse: publicBase(),
        mapped: MAPPING,
      });
      return;
    }

    /* ---------- rooms ---------- */

    let rm: RegExpMatchArray | null;

    if (p === '/api/operator/rooms' && req.method === 'POST') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') { json(res, 401, { error: 'unauthorized' }); return; }
      const body = await readJson(req);
      const title = String(body?.title || '').trim().slice(0, 60);
      if (!title) { json(res, 400, { error: 'title required' }); return; }
      const rid = id();
      db.prepare(`INSERT INTO conversations(id, space_id, client_id, kind, title, archived_at, created_at)
                  VALUES(?,?,?,'room',?,NULL,?)`).run(rid, businessSpaceId(), null, title, now());
      db.prepare(`INSERT INTO participants(conversation_id, participant_type, participant_id, last_read_seq, joined_at)
                  VALUES(?,'operator',?,0,?)`).run(rid, a.userId, now());
      // A room appearing or vanishing used to leave no trace at all, which made
      // "my room disappeared" impossible to answer. Both are recorded now.
      audit(a.userId, a.name, 'room.create', title);
      json(res, 200, { ok: true, id: rid, title, link: `${originOf(req)}/r/${rid}` });
      return;
    }

    if ((rm = p.match(/^\/api\/operator\/rooms\/([^/]+)$/)) && req.method === 'DELETE') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') { json(res, 401, { error: 'unauthorized' }); return; }
      const conv = db.prepare(`SELECT * FROM conversations WHERE id=? AND kind='room'`).get(rm[1]) as any;
      if (!conv) { json(res, 404, { error: 'not found' }); return; }
      // Deleting a room was irreversible and unrecorded. Take a copy first so the
      // Maintenance page can restore it, and say who did it in the audit log.
      let safety: { name: string };
      try {
        safety = makeBackup('room-deleted-' + String(conv.title || 'room').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 30));
      } catch (err: any) {
        json(res, 500, { error: 'could not take a safety backup: ' + (err?.message || err) });
        return;
      }
      audit(a.userId, a.name, 'room.delete', (conv.title || conv.id) + ' (backup ' + safety.name + ')');
      db.prepare(`DELETE FROM messages WHERE conversation_id=?`).run(conv.id);
      db.prepare(`DELETE FROM participants WHERE conversation_id=?`).run(conv.id);
      db.prepare(`DELETE FROM room_guests WHERE conversation_id=?`).run(conv.id);
      db.prepare(`DELETE FROM conversations WHERE id=?`).run(conv.id);
      json(res, 200, { ok: true });
      return;
    }

    if (p === '/help' || p === '/manual') {
      serveStatic(res, 'help.html');
      return;
    }

    if ((rm = p.match(/^\/r\/([^/]+)$/))) {
      const conv = db.prepare(`SELECT id FROM conversations WHERE id=? AND kind='room'`).get(rm[1]);
      if (!conv) { serveStatic(res, 'invalid.html'); return; }
      serveStatic(res, 'room.html');
      return;
    }

    function roomGuest(req: any, convId: string): { id: string; name: string } | null {
      const raw = parseCookies(req.headers?.cookie)['om_guest'];
      if (!raw) return null;
      const i = raw.lastIndexOf('.');
      if (i < 0) return null;
      const payload = raw.slice(0, i);
      if (!safeEqual(raw.slice(i + 1), hmac(SECRET, payload))) return null;
      const [cid, gid] = payload.split(':');
      if (cid !== convId) return null;
      const g = db.prepare(`SELECT id, name FROM room_guests WHERE id=? AND conversation_id=?`).get(gid, convId) as any;
      return g ? { id: g.id, name: g.name } : null;
    }

    if ((rm = p.match(/^\/api\/rooms\/([^/]+)\/join$/)) && req.method === 'POST') {
      if (!moduleEnabled('invite')) { json(res, 404, { error: 'that feature is not loaded' }); return; }
      if (!allow('join:' + clientIp(req), 20)) { json(res, 429, { error: 'slow down' }); return; }
      const conv = db.prepare(`SELECT * FROM conversations WHERE id=? AND kind='room'`).get(rm[1]) as any;
      if (!conv) { json(res, 404, { error: 'room not found' }); return; }
      const body = await readJson(req);
      const name = String(body?.name || '').trim().slice(0, 32);
      if (name.length < 2) { json(res, 400, { error: 'Enter a name of at least 2 characters.' }); return; }
      let gid = roomGuest(req, conv.id)?.id;
      if (gid) {
        db.prepare(`UPDATE room_guests SET name=? WHERE id=?`).run(name, gid);
      } else {
        gid = id();
        db.prepare(`INSERT INTO room_guests(id, conversation_id, name, joined_at) VALUES(?,?,?,?)`)
          .run(gid, conv.id, name, now());
        db.prepare(`INSERT INTO participants(conversation_id, participant_type, participant_id, last_read_seq, joined_at)
                    VALUES(?,'member',?,0,?)`).run(conv.id, gid, now());
      }
      setCookie(res, 'om_guest', `${conv.id}:${gid}.` + hmac(SECRET, `${conv.id}:${gid}`), 60 * 60 * 24 * 30);
      json(res, 200, { ok: true, name, conversationId: conv.id, title: conv.title || 'Room' });
      return;
    }

    if ((rm = p.match(/^\/api\/rooms\/([^/]+)\/messages$/)) && req.method === 'GET') {
      const conv = db.prepare(`SELECT * FROM conversations WHERE id=? AND kind='room'`).get(rm[1]) as any;
      if (!conv) { json(res, 404, { error: 'room not found' }); return; }
      const guest = roomGuest(req, conv.id);
      if (!guest) { json(res, 401, { error: 'join required' }); return; }
      const since = Number(url.searchParams.get('since') || 0);
      const rows = db.prepare(
        `SELECT id FROM messages WHERE conversation_id=? AND seq > ? AND deleted_at IS NULL
          ORDER BY seq ASC LIMIT 300`
      ).all(conv.id, since) as any[];
      json(res, 200, {
        conversationId: conv.id,
        title: conv.title || 'Room',
        me: guest.name,
        messages: rows.map((r) => messagePayload(conv.id, r.id)),
      });
      return;
    }

    if ((rm = p.match(/^\/api\/rooms\/([^/]+)\/send$/)) && req.method === 'POST') {
      const conv = db.prepare(`SELECT * FROM conversations WHERE id=? AND kind='room'`).get(rm[1]) as any;
      if (!conv) { json(res, 404, { error: 'room not found' }); return; }
      const guest = roomGuest(req, conv.id);
      if (!guest) { json(res, 401, { error: 'join required' }); return; }
      if (!allow('room:send:' + guest.id, 20)) { json(res, 429, { error: 'slow down' }); return; }
      const body = await readJson(req);
      const text = String(body?.body || '').slice(0, 4000);
      if (!text.trim()) { json(res, 400, { error: 'empty message' }); return; }
      const clientMsgId = body?.clientMsgId ? String(body.clientMsgId).slice(0, 64) : null;
      const { message, duplicate } = insertMessage(
        conv,
        { type: 'client', id: guest.id, name: guest.name },
        text,
        clientMsgId
      );
      sendToConversation(conv.id, { t: 'message', ...message, clientMsgId, duplicate });
      json(res, 200, { ok: true, message });
      return;
    }

    /* ---------- operator: clients and links ---------- */

    if (p === '/api/operator/clients' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const body = await readJson(req);
      const name = String(body?.display_name || '').trim().slice(0, 40);
      const email = String(body?.email || '').trim().toLowerCase().slice(0, 120);
      if (!name) { json(res, 400, { error: 'display_name required' }); return; }
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { json(res, 400, { error: 'invalid email' }); return; }

      const token = newToken();
      const clientId = id();
      db.prepare(
        `INSERT INTO clients(id, space_id, display_name, email, link_token_hash, revoked_at, created_at)
         VALUES(?,?,?,?,?,NULL,?)`
      ).run(clientId, businessSpaceId(), name, email || null, sha256(token), now());
      const conv = conversationForClient(clientId);
      db.prepare(
        `INSERT INTO tickets(id, space_id, client_id, conversation_id, subject, status, priority, assignee_id, created_at, updated_at, closed_at)
         VALUES(?,?,?,?,?,'open','normal',?,?,?,NULL)`
      ).run(id(), conv.space_id, clientId, conv.id, 'Customer enquiry', null, now(), now());
      json(res, 200, { ok: true, clientId, link: `${originOf(req)}/j/${token}` });
      return;
    }

    let m: RegExpMatchArray | null;

    if ((m = p.match(/^\/api\/operator\/clients\/([^/]+)\/link$/)) && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const client = db.prepare(`SELECT * FROM clients WHERE id=?`).get(m[1]) as any;
      if (!client) { json(res, 404, { error: 'not found' }); return; }
      const token = newToken();
      db.prepare(`UPDATE clients SET link_token_hash=?, revoked_at=NULL WHERE id=?`).run(sha256(token), client.id);
      json(res, 200, { ok: true, link: `${originOf(req)}/j/${token}` });
      return;
    }

    if ((m = p.match(/^\/api\/operator\/clients\/([^/]+)\/revoke$/)) && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      db.prepare(`UPDATE clients SET revoked_at=? WHERE id=?`).run(now(), m[1]);
      json(res, 200, { ok: true });
      return;
    }

    if ((m = p.match(/^\/api\/operator\/clients\/([^/]+)\/note$/))) {
      const a = requireUser(req, res);
      if (!a) return;
      const clientId = m[1];
      if (req.method === 'GET') {
        const row = db.prepare(`SELECT body, updated_at FROM notes WHERE client_id=?`).get(clientId) as any;
        json(res, 200, { body: row?.body || '', updatedAt: row?.updated_at || 0 });
        return;
      }
      if (req.method === 'PUT') {
        const body = await readJson(req);
        const text = String(body?.body || '').slice(0, 20000);
        const existing = db.prepare(`SELECT id FROM notes WHERE client_id=?`).get(clientId) as any;
        if (existing) {
          db.prepare(`UPDATE notes SET body=?, updated_at=? WHERE id=?`).run(text, now(), existing.id);
        } else {
          db.prepare(`INSERT INTO notes(id, space_id, client_id, body, updated_at) VALUES(?,?,?,?,?)`)
            .run(id(), businessSpaceId(), clientId, text, now());
        }
        json(res, 200, { ok: true });
        return;
      }
    }

    if ((m = p.match(/^\/api\/operator\/conversations\/([^/]+)$/)) && req.method === 'DELETE') {
      const a = requireAdmin(req, res);
      if (!a) return;
      const conv = conversationAccess(a, m[1]);
      if (!conv) { json(res, 404, { error: 'not found' }); return; }
      const body = await readJson(req);
      if (body?.confirm !== true) { json(res, 400, { error: 'confirm required' }); return; }

      // Real delete: rows and stored files go, not a hidden flag.
      const purged = purgeMessages(conv.id);
      db.prepare(`DELETE FROM participants WHERE conversation_id=?`).run(conv.id);
      db.prepare(`DELETE FROM conversations WHERE id=?`).run(conv.id);
      if (conv.client_id) {
        db.prepare(`DELETE FROM notes WHERE client_id=?`).run(conv.client_id);
        db.prepare(`DELETE FROM clients WHERE id=?`).run(conv.client_id);
      }
      json(res, 200, { ok: true, purged });
      return;
    }

    // Clear the thread: messages and their files really go, the client and link stay.
    if ((m = p.match(/^\/api\/operator\/conversations\/([^/]+)\/messages$/)) && req.method === 'DELETE') {
      const a = requireAdmin(req, res);
      if (!a) return;
      const conv = conversationAccess(a, m[1]);
      if (!conv) { json(res, 404, { error: 'not found' }); return; }
      const body = await readJson(req);
      if (body?.confirm !== true) { json(res, 400, { error: 'confirm required' }); return; }

      const removed = purgeMessages(conv.id);
      sendToConversation(conv.id, { t: 'cleared', conversationId: conv.id });
      json(res, 200, { ok: true, removed });
      return;
    }

    if ((m = p.match(/^\/api\/operator\/conversations\/([^/]+)\/archive$/)) && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const body = await readJson(req);
      const archived = body?.archived ? now() : null;
      db.prepare(`UPDATE conversations SET archived_at=? WHERE id=?`).run(archived, m[1]);
      json(res, 200, { ok: true });
      return;
    }

    /* ---------- canned replies ---------- */

          // Colour theme, kept on the account so it survives a new port or browser.
      if (p === '/api/theme') {
        const a = requireUser(req, res);
        if (!a || a.kind !== 'operator') return;
        if (req.method === 'POST') {
          const body = await readJson(req);
          const theme = String(body?.theme || '');
          if (!['blue', 'forest', 'violet', 'sunset', 'rose'].includes(theme)) {
            json(res, 400, { error: 'unknown theme' }); return;
          }
          setSetting('theme:' + a.userId, theme);
          json(res, 200, { ok: true, theme });
          return;
        }
        json(res, 200, { theme: getSetting('theme:' + a.userId, '') });
        return;
      }

      if (p === '/api/canned') {
      if (!requireUser(req, res)) return;
      if (req.method === 'GET') {
        json(res, 200, db.prepare(`SELECT shortcut, body FROM canned ORDER BY shortcut`).all());
        return;
      }
      if (req.method === 'POST') {
        if (!requireAdmin(req, res)) return;
        const body = await readJson(req);
        const shortcut = String(body?.shortcut || '').trim().slice(0, 32);
        const text = String(body?.body || '').trim().slice(0, 2000);
        if (!shortcut || !text) { json(res, 400, { error: 'shortcut and body required' }); return; }
        db.prepare(`INSERT INTO canned(id, shortcut, body) VALUES(?,?,?)
                    ON CONFLICT(shortcut) DO UPDATE SET body=excluded.body`)
          .run(id(), shortcut.startsWith('/') ? shortcut : '/' + shortcut, text);
        json(res, 200, { ok: true });
        return;
      }
    }

    /* ---------- status ---------- */

    if (p === '/api/status' && req.method === 'POST') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const body = await readJson(req);
      const status = String(body?.status || 'Online').slice(0, 20);
      const message = String(body?.message || '').slice(0, 120);
      const autoReply = body?.autoReply !== undefined ? String(body.autoReply || '').slice(0, 300) : null;
      if (autoReply === null) {
        db.prepare(`UPDATE users SET status=?, status_text=? WHERE id=?`).run(status, message, a.userId);
      } else {
        db.prepare(`UPDATE users SET status=?, status_text=?, auto_reply=? WHERE id=?`)
          .run(status, message, autoReply, a.userId);
      }
      sendToStaff({ t: 'presence', userId: a.userId, online: isUserOnline(a.userId), status, statusText: message });
      // Client links still show the shared mailbox availability.
      if (a.admin) {
        setSetting('op_status', status);
        setSetting('op_status_message', message);
        sendToConversationAll({ t: 'operator_status', status, message });
      }
      json(res, 200, { ok: true });
      return;
    }

    /* ---------- messages ---------- */

    if ((m = p.match(/^\/api\/conversations\/([^/]+)\/messages$/)) && req.method === 'GET') {
      const a = resolveAuth(req);
      const conv = conversationAccess(a, m[1]);
      if (!conv) { json(res, 401, { error: 'unauthorized' }); return; }
      const since = Number(url.searchParams.get('since') || 0);
      const limit = Math.min(500, Number(url.searchParams.get('limit') || 200));
      const rows = db.prepare(
        `SELECT id FROM messages WHERE conversation_id=? AND seq > ? AND deleted_at IS NULL
          ORDER BY seq ASC LIMIT ?`
      ).all(conv.id, since, limit) as any[];

      const peerType = a!.kind === 'operator' ? 'client' : 'operator';
      const peer = db.prepare(
        `SELECT last_read_seq FROM participants WHERE conversation_id=? AND participant_type=?`
      ).get(conv.id, peerType) as any;

      // Who has read up to which message, so receipts work in groups too.
      const readers = (db.prepare(
        `SELECT p.participant_id, p.last_read_seq, u.display_name FROM participants p
           LEFT JOIN users u ON u.id = p.participant_id
          WHERE p.conversation_id=? AND p.participant_type='operator'`
      ).all(conv.id) as any[]).map((r) => ({
        userId: r.participant_id,
        name: r.display_name || 'Member',
        seq: Number(r.last_read_seq || 0),
      }));

      json(res, 200, {
        conversationId: conv.id,
        peerReadSeq: Number(peer?.last_read_seq || 0),
        readers,
        messages: rows.map((r) => messagePayload(conv.id, r.id)),
      });
      return;
    }

    if ((m = p.match(/^\/api\/conversations\/([^/]+)\/send$/)) && req.method === 'POST') {
      const a = resolveAuth(req);
      const conv = conversationAccess(a, m[1]);
      if (!conv) { json(res, 401, { error: 'unauthorized' }); return; }
      const sender = senderFrom(a);
      if (!sender) { json(res, 401, { error: 'unauthorized' }); return; }

      const rlKey = a!.kind === 'client' ? 'send:client:' + a!.clientId : 'send:u:' + a!.userId;
      if (!allow(rlKey, 30)) { json(res, 429, { error: 'slow down' }); return; }
      if (!allow('send:ip:' + clientIp(req), 90)) { json(res, 429, { error: 'slow down' }); return; }

      const body = await readJson(req);
      const text = String(body?.body || '').slice(0, 4000);
      const clientMsgId = body?.clientMsgId ? String(body.clientMsgId).slice(0, 64) : null;
      if (!text.trim()) { json(res, 400, { error: 'empty message' }); return; }

      // The announcements thread is a one-way channel for administrators.
      if (conv.announce_only && !(a!.kind === 'operator' && a!.admin)) {
        json(res, 403, { error: 'Only administrators can post announcements.' });
        return;
      }

      let kind = body?.requireAck === true ? 'ack' : 'text';
      if (conv.announce_only) kind = 'announcement';
      else if (body?.announce === true && a!.kind === 'operator' && a!.admin) kind = 'announcement';

      const { message, duplicate } = insertMessage(conv, sender, text, clientMsgId, kind);
      sendToConversation(conv.id, { t: 'message', ...message, clientMsgId, duplicate });
      if (sender.type === 'operator' && !conv.client_id && conv.kind === 'direct' && !conv.announce_only) {
        sendAutoReply(conv, sender);
      }
      if (conv.client_id && !duplicate) noteTicketActivity(conv, sender);
      json(res, 200, { ok: true, message });

      // Email the client when they are not present. Subject and link only.
      if (sender.type === 'operator' && !isOnlineClient(conv.client_id)) {
        const client = db.prepare(`SELECT email, link_token_hash FROM clients WHERE id=?`).get(conv.client_id) as any;
        if (client?.email) {
          // No raw link is recoverable from a hash, so point at the thread page.
          void sendReplyNotification(client.email, `${publicBase()}/thread`);
        }
      }
      return;
    }

    if ((m = p.match(/^\/api\/conversations\/([^/]+)\/read$/)) && req.method === 'POST') {
      const a = resolveAuth(req);
      const conv = conversationAccess(a, m[1]);
      if (!conv) { json(res, 401, { error: 'unauthorized' }); return; }
      const sender = senderFrom(a);
      if (!sender) { json(res, 401, { error: 'unauthorized' }); return; }
      const body = await readJson(req);
      const seq = Number(body?.seq || 0);
      db.prepare(
        `UPDATE participants SET last_read_seq=MAX(last_read_seq, ?)
          WHERE conversation_id=? AND participant_type=? AND participant_id=?`
      ).run(seq, conv.id, sender.type, sender.id);
      sendToConversation(conv.id, { t: 'read', conversationId: conv.id, seq, by: sender.type, userId: sender.id, name: sender.name });
      json(res, 200, { ok: true });
      return;
    }

    if ((m = p.match(/^\/api\/conversations\/([^/]+)\/typing$/)) && req.method === 'POST') {
      const a = resolveAuth(req);
      const conv = conversationAccess(a, m[1]);
      if (!conv) { json(res, 401, { error: 'unauthorized' }); return; }
      const sender = senderFrom(a);
      if (!sender) { json(res, 401, { error: 'unauthorized' }); return; }
      if (!allow('typing:' + sender.type + ':' + sender.id, 120)) { json(res, 429, { error: 'slow down' }); return; }
      sendToConversation(conv.id, {
        t: 'typing', conversationId: conv.id, by: sender.type, userId: sender.id, name: sender.name,
      });
      json(res, 200, { ok: true });
      return;
    }

    /* ---------- polls ---------- */

    if ((m = p.match(/^\/api\/conversations\/([^/]+)\/polls$/)) && req.method === 'POST') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const conv = conversationAccess(a, m[1]);
      if (!conv) { json(res, 401, { error: 'unauthorized' }); return; }
      const body = await readJson(req);
      const question = String(body?.question || '').trim().slice(0, 200);
      const labels = (Array.isArray(body?.options) ? body.options : [])
        .map((o: any) => String(o || '').trim().slice(0, 80))
        .filter(Boolean);
      if (!question) { json(res, 400, { error: 'A poll needs a question.' }); return; }
      if (labels.length < 2) { json(res, 400, { error: 'Give the poll at least two options.' }); return; }
      if (labels.length > 8) { json(res, 400, { error: 'Eight options is the maximum.' }); return; }

      const sender = senderFrom(a);
      if (!sender) { json(res, 401, { error: 'unauthorized' }); return; }
      const { message } = insertMessage(conv, sender, question, null, 'poll');
      const pollId = id();
      db.prepare(
        `INSERT INTO polls(id, message_id, conversation_id, question, multi, closed_at, created_by, created_at)
         VALUES(?,?,?,?,?,NULL,?,?)`
      ).run(pollId, message.id, conv.id, question, body?.multi ? 1 : 0, sender.id, now());
      labels.forEach((label: string, i: number) => {
        db.prepare(`INSERT INTO poll_options(id, poll_id, label, position) VALUES(?,?,?,?)`)
          .run(id(), pollId, label, i);
      });
      const full = messagePayload(conv.id, message.id);
      sendToConversation(conv.id, { t: 'message', ...full });
      json(res, 200, { ok: true, message: full });
      return;
    }

    if ((m = p.match(/^\/api\/polls\/([^/]+)\/vote$/)) && req.method === 'POST') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const poll = db.prepare(`SELECT * FROM polls WHERE id=?`).get(m[1]) as any;
      if (!poll) { json(res, 404, { error: 'not found' }); return; }
      const conv = conversationAccess(a, poll.conversation_id);
      if (!conv) { json(res, 401, { error: 'unauthorized' }); return; }
      if (poll.closed_at) { json(res, 400, { error: 'That poll is closed.' }); return; }
      const body = await readJson(req);
      const optionId = String(body?.optionId || '');
      const option = db.prepare(`SELECT * FROM poll_options WHERE id=? AND poll_id=?`).get(optionId, poll.id) as any;
      if (!option) { json(res, 404, { error: 'not found' }); return; }

      const mine = db.prepare(`SELECT option_id FROM poll_votes WHERE poll_id=? AND user_id=?`)
        .all(poll.id, a.userId) as any[];
      const had = mine.some((v) => v.option_id === optionId);
      if (!poll.multi) {
        db.prepare(`DELETE FROM poll_votes WHERE poll_id=? AND user_id=?`).run(poll.id, a.userId);
      }
      if (had) {
        db.prepare(`DELETE FROM poll_votes WHERE poll_id=? AND option_id=? AND user_id=?`)
          .run(poll.id, optionId, a.userId);
      } else {
        db.prepare(`INSERT INTO poll_votes(poll_id, option_id, user_id, created_at) VALUES(?,?,?,?)`)
          .run(poll.id, optionId, a.userId, now());
      }
      const payload = pollPayload(poll.id);
      sendToConversation(conv.id, { t: 'poll', conversationId: conv.id, messageId: poll.message_id, poll: payload });
      json(res, 200, { ok: true, poll: payload });
      return;
    }

    if ((m = p.match(/^\/api\/polls\/([^/]+)\/close$/)) && req.method === 'POST') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const poll = db.prepare(`SELECT * FROM polls WHERE id=?`).get(m[1]) as any;
      if (!poll) { json(res, 404, { error: 'not found' }); return; }
      const conv = conversationAccess(a, poll.conversation_id);
      if (!conv) { json(res, 401, { error: 'unauthorized' }); return; }
      if (!a.admin && poll.created_by !== a.userId) {
        json(res, 403, { error: 'Only the person who asked can close it.' }); return;
      }
      db.prepare(`UPDATE polls SET closed_at=? WHERE id=?`).run(now(), poll.id);
      const payload = pollPayload(poll.id);
      sendToConversation(conv.id, { t: 'poll', conversationId: conv.id, messageId: poll.message_id, poll: payload });
      json(res, 200, { ok: true, poll: payload });
      return;
    }

    /* ---------- acknowledgements ---------- */

    if ((m = p.match(/^\/api\/messages\/([^/]+)\/ack$/)) && req.method === 'POST') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const msg = db.prepare(`SELECT * FROM messages WHERE id=?`).get(m[1]) as any;
      if (!msg) { json(res, 404, { error: 'not found' }); return; }
      const conv = conversationAccess(a, msg.conversation_id);
      if (!conv) { json(res, 401, { error: 'unauthorized' }); return; }
      if (msg.sender_id === a.userId) { json(res, 400, { error: 'That is your own message.' }); return; }
      db.prepare(`INSERT INTO acks(message_id, user_id, created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING`)
        .run(msg.id, a.userId, now());
      const acks = acksFor(msg.id);
      sendToConversation(conv.id, { t: 'ack', conversationId: conv.id, messageId: msg.id, acks });
      json(res, 200, { ok: true, acks });
      return;
    }

    /* ---------- off the record ---------- */

    if ((m = p.match(/^\/api\/conversations\/([^/]+)\/otr$/)) && req.method === 'POST') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      if (getSetting('otr_allowed', '1') !== '1') {
        json(res, 403, { error: 'Off-the-record messages are switched off by the administrator.' }); return;
      }
      if (!userFlags(a.userId).otr) {
        json(res, 403, { error: 'Off-the-record messages are switched off for your account.' }); return;
      }
      const conv = conversationAccess(a, m[1]);
      if (!conv) { json(res, 401, { error: 'unauthorized' }); return; }
      if (conv.client_id) { json(res, 400, { error: 'Client threads are always logged.' }); return; }
      if (!allow('otr:' + a.userId, 60)) { json(res, 429, { error: 'slow down' }); return; }
      const body = await readJson(req);
      const text = String(body?.body || '').slice(0, 2000);
      if (!text.trim()) { json(res, 400, { error: 'empty message' }); return; }
      const payload = {
        t: 'otr',
        conversationId: conv.id,
        id: 'otr-' + id(8),
        senderId: a.userId,
        senderName: a.name,
        body: text,
        createdAt: now(),
      };
      // Members only: never stored, and not delivered to admins who are not in it.
      const members = new Set(memberIds(conv.id));
      for (const s of sockets) {
        if (s.ws.readyState === WebSocket.OPEN && s.auth?.kind === 'operator' && members.has(s.auth.userId)) {
          s.ws.send(JSON.stringify(payload));
        }
      }
      json(res, 200, { ok: true, message: { ...payload, kind: 'otr', otr: true, senderType: 'operator' } });
      return;
    }

    /* ---------- attachments ---------- */

    if ((m = p.match(/^\/api\/conversations\/([^/]+)\/upload$/)) && req.method === 'POST') {
      const a = resolveAuth(req);
      const conv = conversationAccess(a, m[1]);
      if (!conv) { json(res, 401, { error: 'unauthorized' }); return; }
      const sender = senderFrom(a);
      if (!sender) { json(res, 401, { error: 'unauthorized' }); return; }
      if (sender.type === 'operator' && !userFlags(sender.id).files) {
        json(res, 403, { error: 'File transfer is switched off for your account' }); return;
      }
      if (!allow('upload:' + sender.type + ':' + sender.id, 10)) { json(res, 429, { error: 'slow down' }); return; }

      let rawName = String(req.headers['x-filename'] || 'file');
      try { rawName = decodeURIComponent(rawName); } catch { /* keep raw */ }
      const filename = path.basename(rawName).slice(0, 120);
      const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].toLowerCase();
      const clientMsgId = req.headers['x-client-msg-id'] ? String(req.headers['x-client-msg-id']).slice(0, 64) : null;

      const ALLOWED = new Set([
        'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
        'application/pdf', 'text/plain', 'text/csv', 'application/zip',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/msword', 'application/vnd.ms-excel',
      ]);
      const ext = path.extname(filename).toLowerCase();
      if (['.exe', '.bat', '.cmd', '.com', '.scr', '.msi', '.ps1', '.sh', '.js'].includes(ext)) {
        json(res, 415, { error: 'file type refused' }); return;
      }
      if (!ALLOWED.has(mime)) { json(res, 415, { error: 'file type not allowed' }); return; }

      const MAX = 10 * 1024 * 1024;
      const buf = await readBody(req, MAX + 1);
      if (buf.length > MAX) { json(res, 413, { error: 'file too large' }); return; }
      if (!buf.length) { json(res, 400, { error: 'empty file' }); return; }

      const storageKey = crypto.randomBytes(16).toString('hex');
      fs.writeFileSync(path.join(UPLOAD_DIR, storageKey), buf);

      const durationMs = null;
      const { message } = insertMessage(
        conv, sender, '', clientMsgId,
        mime.startsWith('image/') ? 'image' : 'file'
      );
      const msgId = message.id;
      db.prepare(
        `INSERT INTO attachments(id, message_id, space_id, storage_key, filename, mime, bytes, duration_ms, created_at)
         VALUES(?,?,?,?,?,?,?,?,?)`
      ).run(id(), msgId, conv.space_id, storageKey, filename, mime, buf.length, durationMs, now());

      const full = messagePayload(conv.id, msgId);
      sendToConversation(conv.id, { t: 'message', ...full, clientMsgId });
      json(res, 200, { ok: true, message: full });
      return;
    }

    if ((m = p.match(/^\/files\/([^/]+)$/))) {
      const attId = m[1];
      const exp = Number(url.searchParams.get('exp') || 0);
      const sig = String(url.searchParams.get('sig') || '');
      if (!exp || exp < Date.now()) { json(res, 403, { error: 'link expired' }); return; }
      if (!safeEqual(sig, hmac(SECRET, attId + '|' + exp))) { json(res, 403, { error: 'bad signature' }); return; }
      const att = db.prepare(`SELECT * FROM attachments WHERE id=?`).get(attId) as any;
      if (!att) { json(res, 404, { error: 'not found' }); return; }
      const file = path.join(UPLOAD_DIR, att.storage_key);
      if (!fs.existsSync(file)) { json(res, 404, { error: 'not found' }); return; }
      res.writeHead(200, {
        'Content-Type': att.mime,
        'Content-Length': String(att.bytes),
        'Content-Disposition': `inline; filename="${att.filename.replace(/[^\w.\- ]/g, '_')}"`,
        'Cache-Control': 'private, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(fs.readFileSync(file));
      return;
    }

    /* ---------- Peach Wall ---------- */

    if (p === '/api/wall') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      if (req.method === 'GET') {
        const rows = db.prepare(
          `SELECT w.id, w.author_id, w.body, w.created_at, u.display_name, d.name AS department,
                  (SELECT COUNT(*) FROM wall_likes l WHERE l.post_id = w.id) AS likes,
                  (SELECT COUNT(*) FROM wall_likes l WHERE l.post_id = w.id AND l.user_id = ?) AS mine
             FROM wall_posts w LEFT JOIN users u ON u.id = w.author_id
                  LEFT JOIN departments d ON d.id = u.department_id
            ORDER BY w.created_at DESC LIMIT 60`
        ).all(a.userId) as any[];
        const comments = db.prepare(
          `SELECT c.id, c.post_id, c.author_id, c.body, c.created_at, u.display_name
             FROM wall_comments c LEFT JOIN users u ON u.id = c.author_id
            ORDER BY c.created_at ASC LIMIT 500`
        ).all() as any[];
        const byPost = new Map<string, any[]>();
        for (const c of comments) {
          const list = byPost.get(c.post_id) || [];
          list.push({
            id: c.id, authorId: c.author_id, author: c.display_name || 'Colleague',
            body: c.body, createdAt: c.created_at, mine: c.author_id === a.userId,
          });
          byPost.set(c.post_id, list);
        }
        json(res, 200, {
          admin: !!a.admin,
          posts: rows.map((r) => ({
            id: r.id, authorId: r.author_id, author: r.display_name || 'Colleague',
            department: r.department || '', body: r.body, createdAt: r.created_at,
            likes: Number(r.likes || 0), liked: Number(r.mine || 0) > 0,
            mine: r.author_id === a.userId,
            comments: byPost.get(r.id) || [],
          })),
        });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        const text = String(body?.body || '').trim().slice(0, 2000);
        if (!text) { json(res, 400, { error: 'Write something first.' }); return; }
        const pid = id();
        db.prepare(`INSERT INTO wall_posts(id, author_id, body, created_at) VALUES(?,?,?,?)`)
          .run(pid, a.userId, text, now());
        sendToStaff({ t: 'wall' });
        json(res, 200, { ok: true, id: pid });
        return;
      }
    }

    if (p === '/api/wall/like' && req.method === 'POST') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const body = await readJson(req);
      const pid = String(body?.id || '');
      const post = db.prepare(`SELECT id FROM wall_posts WHERE id=?`).get(pid);
      if (!post) { json(res, 404, { error: 'not found' }); return; }
      const had = db.prepare(`SELECT 1 AS x FROM wall_likes WHERE post_id=? AND user_id=?`).get(pid, a.userId);
      if (had) db.prepare(`DELETE FROM wall_likes WHERE post_id=? AND user_id=?`).run(pid, a.userId);
      else db.prepare(`INSERT INTO wall_likes(post_id, user_id, created_at) VALUES(?,?,?)`).run(pid, a.userId, now());
      sendToStaff({ t: 'wall' });
      json(res, 200, { ok: true, liked: !had });
      return;
    }

    if (p === '/api/wall/comment' && req.method === 'POST') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const body = await readJson(req);
      const pid = String(body?.id || '');
      const text = String(body?.body || '').trim().slice(0, 1000);
      if (!text) { json(res, 400, { error: 'Write something first.' }); return; }
      const post = db.prepare(`SELECT id FROM wall_posts WHERE id=?`).get(pid);
      if (!post) { json(res, 404, { error: 'not found' }); return; }
      const cid = id();
      db.prepare(`INSERT INTO wall_comments(id, post_id, author_id, body, created_at) VALUES(?,?,?,?,?)`)
        .run(cid, pid, a.userId, text, now());
      sendToStaff({ t: 'wall' });
      json(res, 200, { ok: true, id: cid });
      return;
    }

    if (p === '/api/wall/remove' && req.method === 'POST') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const body = await readJson(req);
      const kind = String(body?.kind || 'post');
      const wid = String(body?.id || '');
      if (kind === 'comment') {
        const c = db.prepare(`SELECT id, author_id FROM wall_comments WHERE id=?`).get(wid) as any;
        if (!c) { json(res, 404, { error: 'not found' }); return; }
        if (c.author_id !== a.userId && !a.admin) {
          json(res, 403, { error: 'only the author or an administrator' }); return;
        }
        db.prepare(`DELETE FROM wall_comments WHERE id=?`).run(wid);
      } else {
        const w = db.prepare(`SELECT id, author_id FROM wall_posts WHERE id=?`).get(wid) as any;
        if (!w) { json(res, 404, { error: 'not found' }); return; }
        if (w.author_id !== a.userId && !a.admin) {
          json(res, 403, { error: 'only the author or an administrator' }); return;
        }
        db.prepare(`DELETE FROM wall_comments WHERE post_id=?`).run(wid);
        db.prepare(`DELETE FROM wall_likes WHERE post_id=?`).run(wid);
        db.prepare(`DELETE FROM wall_posts WHERE id=?`).run(wid);
      }
      sendToStaff({ t: 'wall' });
      json(res, 200, { ok: true });
      return;
    }

    /* ---------- sticky notes ---------- */

    if (p === '/api/notes') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      if (req.method === 'GET') {
        const rows = db.prepare(
          `SELECT id, body, colour, created_at, updated_at FROM sticky_notes
            WHERE user_id=? ORDER BY updated_at DESC`
        ).all(a.userId) as any[];
        json(res, 200, rows.map((r) => ({
          id: r.id, body: r.body, colour: r.colour, createdAt: r.created_at, updatedAt: r.updated_at,
        })));
        return;
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        const text = String(body?.body || '').trim().slice(0, 2000);
        const colour = ['amber', 'green', 'blue', 'rose'].includes(String(body?.colour))
          ? String(body.colour) : 'amber';
        if (!text) { json(res, 400, { error: 'Write something first.' }); return; }
        const nid = id();
        db.prepare(`INSERT INTO sticky_notes(id, user_id, body, colour, created_at, updated_at) VALUES(?,?,?,?,?,?)`)
          .run(nid, a.userId, text, colour, now(), now());
        json(res, 200, { ok: true, id: nid });
        return;
      }
    }

    if ((m = p.match(/^\/api\/notes\/([^/]+)$/))) {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const note = db.prepare(`SELECT * FROM sticky_notes WHERE id=? AND user_id=?`).get(m[1], a.userId) as any;
      if (!note) { json(res, 404, { error: 'not found' }); return; }
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        const text = body?.body !== undefined ? String(body.body).trim().slice(0, 2000) : note.body;
        const colour = body?.colour !== undefined ? String(body.colour) : note.colour;
        if (!text) { json(res, 400, { error: 'Write something first.' }); return; }
        db.prepare(`UPDATE sticky_notes SET body=?, colour=?, updated_at=? WHERE id=?`)
          .run(text, colour, now(), note.id);
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === 'DELETE') {
        db.prepare(`DELETE FROM sticky_notes WHERE id=?`).run(note.id);
        json(res, 200, { ok: true });
        return;
      }
    }

    /* ---------- reminders ---------- */

    if (p === '/api/reminders') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      if (req.method === 'GET') {
        const rows = db.prepare(
          `SELECT r.id, r.body, r.due_at, r.conversation_id, r.message_id, r.created_at, r.notified_at
             FROM reminders r WHERE r.user_id=? AND r.done=0 ORDER BY r.due_at ASC LIMIT 100`
        ).all(a.userId) as any[];
        json(res, 200, rows.map((r) => ({
          id: r.id, body: r.body, dueAt: r.due_at, conversationId: r.conversation_id,
          messageId: r.message_id, createdAt: r.created_at, notified: !!r.notified_at,
        })));
        return;
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        const text = String(body?.body || '').trim().slice(0, 300);
        const dueAt = Number(body?.dueAt || 0);
        if (!text) { json(res, 400, { error: 'What should I remind you about?' }); return; }
        if (!dueAt || dueAt < Date.now() - 60000) { json(res, 400, { error: 'Pick a time in the future.' }); return; }
        const rid = id();
        db.prepare(
          `INSERT INTO reminders(id, user_id, body, due_at, conversation_id, message_id, done, created_at)
           VALUES(?,?,?,?,?,?,0,?)`
        ).run(rid, a.userId, text, dueAt,
          body?.conversationId ? String(body.conversationId) : null,
          body?.messageId ? String(body.messageId) : null, now());
        json(res, 200, { ok: true, id: rid });
        return;
      }
    }

    if ((m = p.match(/^\/api\/reminders\/([^/]+)$/))) {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const row = db.prepare(`SELECT * FROM reminders WHERE id=? AND user_id=?`).get(m[1], a.userId) as any;
      if (!row) { json(res, 404, { error: 'not found' }); return; }
      if (req.method === 'POST') {
        db.prepare(`UPDATE reminders SET done=1 WHERE id=?`).run(row.id);
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === 'DELETE') {
        db.prepare(`DELETE FROM reminders WHERE id=?`).run(row.id);
        json(res, 200, { ok: true });
        return;
      }
    }

    /* ---------- tasks ---------- */

    let wm: RegExpMatchArray | null;

    if (p === '/api/tasks') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      if (req.method === 'GET') {
        json(res, 200, { tasks: tasksVisibleTo(a.userId), people: statePeople(a.userId) });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        const title = String(body?.title || '').trim().slice(0, 200);
        if (!title) { json(res, 400, { error: 'Give the task a name.' }); return; }
        const notes = String(body?.notes || '').trim().slice(0, 4000);
        const dueAt = Number(body?.dueAt || 0) || null;
        const priority = body?.priority === 'high' ? 'high' : 'normal';
        const assigneeId = body?.assigneeId ? String(body.assigneeId) : a.userId;
        const assignee = db.prepare(`SELECT id FROM users WHERE id=? AND disabled=0`).get(assigneeId) as any;
        if (!assignee) { json(res, 400, { error: 'That person is not available.' }); return; }
        const conversationId = body?.conversationId ? String(body.conversationId) : null;
        if (conversationId && !conversationAccess(a, conversationId)) {
          json(res, 404, { error: 'not found' });
          return;
        }
        const scope = conversationId ? 'room' : assigneeId === a.userId ? 'private' : 'team';
        const tid = id();
        db.prepare(
          `INSERT INTO tasks(id, space_id, conversation_id, title, notes, scope, assignee_id, created_by,
             due_at, priority, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(tid, businessSpaceId(), conversationId, title, notes, scope, assigneeId, a.userId,
          dueAt, priority, now(), now());
        const task = taskPayload(db.prepare(`${TASK_SELECT} WHERE t.id=?`).get(tid));
        for (const uid of new Set([assigneeId, a.userId])) {
          if (uid !== a.userId) sendToUserId(uid, { t: 'task', action: 'new', task });
        }
        if (conversationId) sendToConversation(conversationId, { t: 'task', action: 'new', task });
        json(res, 200, { ok: true, task });
        return;
      }
    }

    if ((wm = p.match(/^\/api\/tasks\/([^/]+)$/))) {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const task = taskAccess(a.userId, wm[1]);
      if (!task) { json(res, 404, { error: 'not found' }); return; }
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        const title = body?.title !== undefined ? String(body.title).trim().slice(0, 200) : task.title;
        if (!title) { json(res, 400, { error: 'Give the task a name.' }); return; }
        const notes = body?.notes !== undefined ? String(body.notes).trim().slice(0, 4000) : task.notes;
        const dueAt = body?.dueAt !== undefined ? (Number(body.dueAt) || null) : task.due_at;
        const priority = body?.priority !== undefined
          ? (body.priority === 'high' ? 'high' : 'normal') : task.priority;
        let assigneeId = task.assignee_id;
        if (body?.assigneeId !== undefined && String(body.assigneeId)) {
          const u = db.prepare(`SELECT id FROM users WHERE id=? AND disabled=0`).get(String(body.assigneeId)) as any;
          if (!u) { json(res, 400, { error: 'That person is not available.' }); return; }
          assigneeId = u.id;
        }
        // Completing is open to the assignee as well; everything else to the creator.
        const doneChange = body?.done !== undefined;
        if (task.created_by !== a.userId && !(doneChange && task.assignee_id === a.userId)) {
          json(res, 403, { error: 'Only the person who made it can change it.' });
          return;
        }
        const doneAt = doneChange ? (body.done ? now() : null) : task.done_at;
        db.prepare(
          `UPDATE tasks SET title=?, notes=?, due_at=?, priority=?, assignee_id=?, done_at=?, done_by=?,
             notified_at=CASE WHEN ? IS NULL THEN NULL ELSE notified_at END, updated_at=?
           WHERE id=?`
        ).run(title, notes, dueAt, priority, assigneeId, doneAt, doneAt ? a.userId : null,
          doneAt, now(), task.id);
        const updated = taskPayload(db.prepare(`${TASK_SELECT} WHERE t.id=?`).get(task.id));
        for (const uid of new Set([task.assignee_id, assigneeId, task.created_by].filter(Boolean) as string[])) {
          sendToUserId(uid, { t: 'task', action: 'update', task: updated });
        }
        if (task.conversation_id) {
          sendToConversation(task.conversation_id, { t: 'task', action: 'update', task: updated });
        }
        json(res, 200, { ok: true, task: updated });
        return;
      }
      if (req.method === 'DELETE') {
        if (task.created_by !== a.userId && !a.admin) {
          json(res, 403, { error: 'Only the person who made it can delete it.' });
          return;
        }
        db.prepare(`DELETE FROM tasks WHERE id=?`).run(task.id);
        for (const uid of new Set([task.assignee_id, task.created_by].filter(Boolean) as string[])) {
          sendToUserId(uid, { t: 'task', action: 'delete', taskId: task.id });
        }
        json(res, 200, { ok: true });
        return;
      }
    }

    // A task can get a chat of its own, so the work happens where the task lives.
    if ((wm = p.match(/^\/api\/tasks\/([^/]+)\/chat$/)) && req.method === 'POST') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const task = taskAccess(a.userId, wm[1]);
      if (!task) { json(res, 404, { error: 'not found' }); return; }
      if (!task.conversation_id) {
        const members = [task.created_by, task.assignee_id].filter(Boolean) as string[];
        const gid = roomWith('Task: ' + task.title, members);
        db.prepare(`UPDATE tasks SET conversation_id=?, scope='room', updated_at=? WHERE id=?`)
          .run(gid, now(), task.id);
        sendToStaff({ t: 'refresh' });
        json(res, 200, { ok: true, conversationId: gid, created: true });
        return;
      }
      json(res, 200, { ok: true, conversationId: task.conversation_id, created: false });
      return;
    }

    /* ---------- meetings ---------- */

    if (p === '/api/events') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      if (req.method === 'GET') {
        const from = Number(url.searchParams.get('from') || 0) || Date.now() - 86400000 * 7;
        const to = Number(url.searchParams.get('to') || 0) || Date.now() + 86400000 * 30;
        json(res, 200, { events: eventsVisibleTo(a.userId, from, to), people: statePeople(a.userId) });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        const title = String(body?.title || '').trim().slice(0, 200);
        if (!title) { json(res, 400, { error: 'Give the meeting a name.' }); return; }
        const startsAt = Number(body?.startsAt || 0);
        const endsAt = Number(body?.endsAt || 0) || startsAt + 1800000;
        if (!startsAt) { json(res, 400, { error: 'Pick a date and time.' }); return; }
        if (endsAt <= startsAt) { json(res, 400, { error: 'The meeting must end after it starts.' }); return; }
        const inviteeIds = (Array.isArray(body?.inviteeIds) ? body.inviteeIds : []).map(String)
          .filter((uid: string) => uid && uid !== a.userId);
        const eid = id();
        db.prepare(
          `INSERT INTO events(id, space_id, title, notes, location, starts_at, ends_at, all_day, created_by,
             conversation_id, ical_uid, ical_seq, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,NULL,?,0,?,?)`
        ).run(eid, businessSpaceId(), title, String(body?.notes || '').trim().slice(0, 4000),
          String(body?.location || '').trim().slice(0, 200), startsAt, endsAt,
          body?.allDay ? 1 : 0, a.userId, id() + '@messenger', now(), now());
        db.prepare(`INSERT INTO event_invites(event_id, user_id, status, responded_at) VALUES(?,?,'accepted',?)`)
          .run(eid, a.userId, now());
        for (const uid of new Set<string>(inviteeIds)) {
          const u = db.prepare(`SELECT id FROM users WHERE id=? AND disabled=0`).get(uid) as any;
          if (!u) continue;
          db.prepare(`INSERT OR IGNORE INTO event_invites(event_id, user_id, status) VALUES(?,?,'invited')`)
            .run(eid, uid);
        }
        if (body?.withChat) {
          const members = [a.userId, ...inviteeIds];
          const gid = roomWith('Meeting: ' + title, members);
          db.prepare(`UPDATE events SET conversation_id=? WHERE id=?`).run(gid, eid);
          sendToStaff({ t: 'refresh' });
        }
        const event = eventPayload(db.prepare(`SELECT * FROM events WHERE id=?`).get(eid), a.userId);
        for (const att of event.attendees) {
          if (att.userId !== a.userId) {
            sendToUserId(att.userId, { t: 'event', action: 'invite', event: eventPayload(db.prepare(`SELECT * FROM events WHERE id=?`).get(eid), att.userId) });
          }
        }
        json(res, 200, { ok: true, event });
        return;
      }
    }

    if ((wm = p.match(/^\/api\/events\/([^/]+)$/))) {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const event = eventAccess(a.userId, wm[1]);
      if (!event) { json(res, 404, { error: 'not found' }); return; }
      if (req.method === 'PATCH') {
        if (event.created_by !== a.userId) {
          json(res, 403, { error: 'Only the organiser can change the meeting.' });
          return;
        }
        const body = await readJson(req);
        const title = body?.title !== undefined ? String(body.title).trim().slice(0, 200) : event.title;
        if (!title) { json(res, 400, { error: 'Give the meeting a name.' }); return; }
        const startsAt = body?.startsAt !== undefined ? Number(body.startsAt) || event.starts_at : event.starts_at;
        const endsAt = body?.endsAt !== undefined ? Number(body.endsAt) || event.ends_at : event.ends_at;
        if (endsAt <= startsAt) { json(res, 400, { error: 'The meeting must end after it starts.' }); return; }
        db.prepare(
          `UPDATE events SET title=?, notes=?, location=?, starts_at=?, ends_at=?, all_day=?, ical_seq=ical_seq+1,
             reminded_at=NULL, updated_at=? WHERE id=?`
        ).run(title,
          body?.notes !== undefined ? String(body.notes).trim().slice(0, 4000) : event.notes,
          body?.location !== undefined ? String(body.location).trim().slice(0, 200) : event.location,
          startsAt, endsAt, body?.allDay !== undefined ? (body.allDay ? 1 : 0) : event.all_day,
          now(), event.id);
        if (Array.isArray(body?.inviteeIds)) {
          const wanted = new Set<string>(body.inviteeIds.map(String));
          const current = eventAttendees(event.id).map((x) => x.userId);
          for (const uid of current) {
            if (uid !== a.userId && !wanted.has(uid)) {
              db.prepare(`DELETE FROM event_invites WHERE event_id=? AND user_id=?`).run(event.id, uid);
              sendToUserId(uid, { t: 'event', action: 'cancel', eventId: event.id, title });
            }
          }
          for (const uid of wanted) {
            if (!uid || uid === a.userId) continue;
            const u = db.prepare(`SELECT id FROM users WHERE id=? AND disabled=0`).get(uid) as any;
            if (!u) continue;
            db.prepare(`INSERT OR IGNORE INTO event_invites(event_id, user_id, status) VALUES(?,?,'invited')`)
              .run(event.id, uid);
          }
        }
        const fresh = db.prepare(`SELECT * FROM events WHERE id=?`).get(event.id);
        for (const att of eventAttendees(event.id)) {
          sendToUserId(att.userId, { t: 'event', action: 'update', event: eventPayload(fresh, att.userId) });
        }
        json(res, 200, { ok: true, event: eventPayload(fresh, a.userId) });
        return;
      }
      if (req.method === 'DELETE') {
        if (event.created_by !== a.userId && !a.admin) {
          json(res, 403, { error: 'Only the organiser can cancel the meeting.' });
          return;
        }
        db.prepare(`UPDATE events SET cancelled_at=?, ical_seq=ical_seq+1, updated_at=? WHERE id=?`)
          .run(now(), now(), event.id);
        for (const att of eventAttendees(event.id)) {
          sendToUserId(att.userId, { t: 'event', action: 'cancel', eventId: event.id, title: event.title });
        }
        json(res, 200, { ok: true });
        return;
      }
    }

    if ((wm = p.match(/^\/api\/events\/([^/]+)\/respond$/)) && req.method === 'POST') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const event = eventAccess(a.userId, wm[1]);
      if (!event) { json(res, 404, { error: 'not found' }); return; }
      const body = await readJson(req);
      const status = ['accepted', 'declined', 'maybe'].includes(String(body?.status))
        ? String(body.status) : 'accepted';
      db.prepare(
        `INSERT INTO event_invites(event_id, user_id, status, responded_at) VALUES(?,?,?,?)
         ON CONFLICT(event_id, user_id) DO UPDATE SET status=excluded.status, responded_at=excluded.responded_at`
      ).run(event.id, a.userId, status, now());
      const fresh = db.prepare(`SELECT * FROM events WHERE id=?`).get(event.id);
      for (const uid of new Set([event.created_by, ...eventAttendees(event.id).map((x) => x.userId)])) {
        sendToUserId(uid, { t: 'event', action: 'rsvp', event: eventPayload(fresh, uid) });
      }
      json(res, 200, { ok: true, event: eventPayload(fresh, a.userId) });
      return;
    }

    if ((wm = p.match(/^\/api\/events\/([^/]+)\/chat$/)) && req.method === 'POST') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const event = eventAccess(a.userId, wm[1]);
      if (!event) { json(res, 404, { error: 'not found' }); return; }
      if (event.conversation_id) {
        json(res, 200, { ok: true, conversationId: event.conversation_id, created: false });
        return;
      }
      const members = [event.created_by, ...eventAttendees(event.id).map((x) => x.userId)];
      const gid = roomWith('Meeting: ' + event.title, members);
      db.prepare(`UPDATE events SET conversation_id=?, updated_at=? WHERE id=?`).run(gid, now(), event.id);
      sendToStaff({ t: 'refresh' });
      json(res, 200, { ok: true, conversationId: gid, created: true });
      return;
    }

    /* ---------- leave ---------- */

    if (p === '/api/leave') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      if (req.method === 'GET') {
        const mine = (db.prepare(
          `SELECT * FROM leave_requests WHERE user_id=? ORDER BY starts_on DESC LIMIT 100`
        ).all(a.userId) as any[]).map(leavePayload);
        const team = (db.prepare(
          `SELECT l.*, u.display_name FROM leave_requests l JOIN users u ON u.id=l.user_id
            WHERE l.status='approved' AND l.ends_on >= ? ORDER BY l.starts_on ASC LIMIT 200`
        ).all(dayKey(Date.now())) as any[]).map((r) => ({ ...leavePayload(r), name: r.display_name }));
        const hol = db.prepare(`SELECT id, day, name FROM holidays ORDER BY day`).all();
        json(res, 200, { mine, team, holidays: hol });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        const kind = ['annual', 'sick', 'personal', 'unpaid'].includes(String(body?.kind))
          ? String(body.kind) : 'annual';
        const startsOn = String(body?.startsOn || '').slice(0, 10);
        const endsOn = String(body?.endsOn || startsOn).slice(0, 10);
        if (!parseDayKey(startsOn) || !parseDayKey(endsOn)) {
          json(res, 400, { error: 'Pick the dates you will be away.' });
          return;
        }
        if (endsOn < startsOn) { json(res, 400, { error: 'The end date is before the start date.' }); return; }
        const days = leaveDays(startsOn, endsOn);
        if (!days) { json(res, 400, { error: 'Those dates are all weekend or holidays.' }); return; }
        const lid = id();
        db.prepare(
          `INSERT INTO leave_requests(id, user_id, kind, starts_on, ends_on, days, reason, status, created_at)
           VALUES(?,?,?,?,?,?,?,'pending',?)`
        ).run(lid, a.userId, kind, startsOn, endsOn, days, String(body?.reason || '').trim().slice(0, 500), now());
        for (const row of db.prepare(`SELECT id FROM users WHERE (role='admin' OR is_operator=1) AND disabled=0`).all() as any[]) {
          sendToUserId(row.id, { t: 'leave', action: 'request' });
        }
        sendToStaff({ t: 'leave', action: 'request' });
        json(res, 200, { ok: true, id: lid, days });
        return;
      }
    }

    if ((wm = p.match(/^\/api\/leave\/([^/]+)\/cancel$/)) && req.method === 'POST') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const row = db.prepare(`SELECT * FROM leave_requests WHERE id=? AND user_id=?`).get(wm[1], a.userId) as any;
      if (!row) { json(res, 404, { error: 'not found' }); return; }
      if (row.status === 'cancelled') { json(res, 400, { error: 'Already cancelled.' }); return; }
      db.prepare(`UPDATE leave_requests SET status='cancelled', decided_at=? WHERE id=?`).run(now(), row.id);
      json(res, 200, { ok: true });
      return;
    }

    /* ---------- calendar feed (iCal) ---------- */

    if (p === '/api/calendar/feed') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const me = db.prepare(`SELECT ical_token FROM users WHERE id=?`).get(a.userId) as any;
      let token = String(me?.ical_token || '');
      if (!token || url.searchParams.get('token') === 'new') {
        token = newToken();
        db.prepare(`UPDATE users SET ical_token=? WHERE id=?`).run(token, a.userId);
      }
      json(res, 200, {
        url: `${publicBase()}/api/calendar.ics?token=${encodeURIComponent(token)}`,
        note: 'Paste this into Google Calendar under Other calendars → From URL.',
      });
      return;
    }

    if (p === '/api/calendar.ics') {
      const token = String(url.searchParams.get('token') || '');
      let userId = '';
      if (token) {
        if (!allow('ics:' + clientIp(req), 60)) { json(res, 429, { error: 'too many requests' }); return; }
        const row = db.prepare(`SELECT id FROM users WHERE ical_token=?`).get(token) as any;
        if (!row) { json(res, 404, { error: 'unknown calendar' }); return; }
        userId = row.id;
      } else {
        const a = requireUser(req, res);
        if (!a || a.kind !== 'operator') return;
        userId = a.userId;
      }
      const body = buildIcs(userId);
      res.writeHead(200, {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'attachment; filename="messenger-calendar.ics"',
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }

    if (p === '/api/calendar/import' && req.method === 'POST') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const body = await readJson(req);
      const text = String(body?.ics || '');
      if (!text.includes('BEGIN:VEVENT')) { json(res, 400, { error: 'That file has no events in it.' }); return; }
      const lines = icsUnfold(text);
      let imported = 0;
      let inEvent = false;
      let cur: any = null;
      const finish = () => {
        if (!cur || !cur.startsAt) return;
        const endsAt = cur.endsAt && cur.endsAt > cur.startsAt ? cur.endsAt : cur.startsAt + (cur.allDay ? 86400000 : 1800000);
        const eid = id();
        db.prepare(
          `INSERT INTO events(id, space_id, title, notes, location, starts_at, ends_at, all_day, created_by,
             ical_uid, ical_seq, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?)`
        ).run(eid, businessSpaceId(), (cur.title || 'Imported event').slice(0, 200), cur.notes || '',
          cur.location || '', cur.startsAt, endsAt, cur.allDay ? 1 : 0, a.userId,
          cur.uid || id() + '@messenger', now(), now());
        db.prepare(`INSERT INTO event_invites(event_id, user_id, status, responded_at) VALUES(?,?,'accepted',?)`)
          .run(eid, a.userId, now());
        imported++;
      };
      for (const raw of lines) {
        const line = raw.trim();
        if (line === 'BEGIN:VEVENT') { inEvent = true; cur = {}; continue; }
        if (line === 'END:VEVENT') { if (inEvent) finish(); inEvent = false; cur = null; continue; }
        if (!inEvent || !cur) continue;
        const idx = line.indexOf(':');
        if (idx < 0) continue;
        const key = line.slice(0, idx).toUpperCase();
        const value = line.slice(idx + 1);
        if (key.startsWith('DTSTART')) {
          const d = icsParseDate(value);
          if (d) { cur.startsAt = d.ts; cur.allDay = d.allDay; }
        } else if (key.startsWith('DTEND')) {
          const d = icsParseDate(value);
          if (d) cur.endsAt = d.ts;
        } else if (key === 'SUMMARY') cur.title = icsUnescape(value);
        else if (key === 'DESCRIPTION') cur.notes = icsUnescape(value).slice(0, 4000);
        else if (key === 'LOCATION') cur.location = icsUnescape(value).slice(0, 200);
        else if (key === 'UID') cur.uid = value.slice(0, 200);
      }
      sendToStaff({ t: 'refresh' });
      json(res, 200, { ok: true, imported });
      return;
    }

    /* ---------- work hours ---------- */

    if (p === '/api/hours') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const todayStart = parseDayKey(dayKey(Date.now()));
      const open = db.prepare(
        `SELECT started_at FROM work_sessions WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`
      ).get(a.userId) as any;
      const weekStart = todayStart - 6 * 86400000;
      json(res, 200, {
        todayMinutes: minutesWorked(a.userId, todayStart, now()),
        weekMinutes: minutesWorked(a.userId, weekStart, now()),
        since: open ? Number(open.started_at) : null,
      });
      return;
    }

    /* ---------- reports (admin, manager, or your own data) ---------- */

    if (p === '/api/reports/hours') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const from = Number(url.searchParams.get('from') || 0) || Date.now() - 86400000 * 13;
      const to = Number(url.searchParams.get('to') || 0) || Date.now() + 1;
      const wanted = String(url.searchParams.get('userId') || '');
      const all = a.admin || a.role === 'manager';
      const people = all && !wanted
        ? db.prepare(`SELECT id, display_name FROM users WHERE disabled=0 ORDER BY display_name`).all() as any[]
        : [{ id: a.userId, display_name: a.name }];
      const rows = people.map((u: any) => {
        const minutes = minutesWorked(u.id, from, to);
        return {
          userId: u.id, name: u.display_name, minutes,
          days: Number((db.prepare(
            `SELECT COUNT(DISTINCT strftime('%Y-%m-%d', started_at/1000, 'unixepoch', 'localtime')) AS c
               FROM work_sessions WHERE user_id=? AND started_at>=? AND started_at<=?`
          ).get(u.id, from, to) as any)?.c || 0),
        };
      });
      json(res, 200, { from, to, rows });
      return;
    }

    if (p === '/api/reports/chat') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const from = Number(url.searchParams.get('from') || 0) || Date.now() - 86400000 * 6;
      const to = Number(url.searchParams.get('to') || 0) || Date.now() + 1;
      const all = a.admin || a.role === 'manager';
      const userId = all && url.searchParams.get('userId') ? String(url.searchParams.get('userId')) : a.userId;
      const rows = db.prepare(
        `SELECT m.created_at, m.sender_name, m.kind, m.body, c.title, c.kind AS conv_kind
           FROM messages m JOIN conversations c ON c.id=m.conversation_id
           JOIN participants p ON p.conversation_id=c.id AND p.participant_type='operator' AND p.participant_id=?
          WHERE m.created_at>=? AND m.created_at<=? AND m.deleted_at IS NULL
          ORDER BY m.created_at ASC LIMIT 5000`
      ).all(userId, from, to) as any[];
      const csv = ['When,Conversation,From,Kind,Message'];
      for (const r of rows) {
        const when = new Date(r.created_at).toISOString();
        const conv = r.title || (r.conv_kind === 'direct' ? 'Direct message' : 'Chat');
        const cells = [when, conv, r.sender_name, r.kind, r.body || '']
          .map((v) => '"' + String(v).replace(/"/g, '""') + '"');
        csv.push(cells.join(','));
      }
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="chat-log-${dayKey(from)}.csv"`,
        'Cache-Control': 'no-store',
      });
      res.end(csv.join('\r\n'));
      return;
    }

    /* ---------- admin: leave and holidays ---------- */

    if (p === '/api/admin/leave' && req.method === 'GET') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      const rows = db.prepare(
        `SELECT l.*, u.display_name FROM leave_requests l JOIN users u ON u.id=l.user_id
          ORDER BY (l.status='pending') DESC, l.starts_on DESC LIMIT 300`
      ).all() as any[];
      json(res, 200, { requests: rows.map((r) => ({ ...leavePayload(r), name: r.display_name })) });
      return;
    }

    if ((wm = p.match(/^\/api\/admin\/leave\/([^/]+)\/decide$/)) && req.method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      const row = db.prepare(`SELECT * FROM leave_requests WHERE id=?`).get(wm[1]) as any;
      if (!row) { json(res, 404, { error: 'not found' }); return; }
      const body = await readJson(req);
      const status = body?.approve ? 'approved' : 'declined';
      db.prepare(
        `UPDATE leave_requests SET status=?, decided_by=?, decided_at=?, decision_note=? WHERE id=?`
      ).run(status, admin.userId, now(), String(body?.note || '').slice(0, 300), row.id);
      audit(admin.userId, admin.name, 'leave.' + status, `request ${row.id}`);
      sendToUserId(row.user_id, { t: 'leave', action: status });
      json(res, 200, { ok: true });
      return;
    }

    if (p === '/api/admin/holidays') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      if (req.method === 'GET') {
        json(res, 200, db.prepare(`SELECT id, day, name FROM holidays ORDER BY day`).all());
        return;
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        const day = String(body?.day || '').slice(0, 10);
        const name = String(body?.name || '').trim().slice(0, 80);
        if (!parseDayKey(day) || !name) { json(res, 400, { error: 'Pick a date and give it a name.' }); return; }
        const hid = id();
        db.prepare(`INSERT INTO holidays(id, day, name, created_at) VALUES(?,?,?,?)
                    ON CONFLICT(day) DO UPDATE SET name=excluded.name`).run(hid, day, name, now());
        audit(admin.userId, admin.name, 'holiday.add', `${day} ${name}`);
        json(res, 200, { ok: true });
        return;
      }
    }

    if ((wm = p.match(/^\/api\/admin\/holidays\/([^/]+)$/)) && req.method === 'DELETE') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      db.prepare(`DELETE FROM holidays WHERE id=?`).run(wm[1]);
      json(res, 200, { ok: true });
      return;
    }

    /* ---------- Peach Drive ---------- */

    if (p === '/api/drive' && req.method === 'GET') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      if (!userFlags(a.userId).drive) { json(res, 403, { error: 'Drive is switched off for your account' }); return; }
      const scope = url.searchParams.get('scope') === 'room' ? 'room' : 'mine';
      const roomId = String(url.searchParams.get('roomId') || '');
      const parentId = String(url.searchParams.get('parent') || '') || null;
      const parent = parentId ? db.prepare(`SELECT * FROM drive_items WHERE id=?`).get(parentId) as any : null;
      if (parentId && (!parent || parent.kind !== 'folder' || !driveCanOpen(a, parentId))) {
        json(res, 404, { error: 'no such folder' }); return;
      }

      const roomRows = db.prepare(
        `SELECT * FROM conversations WHERE kind='room' AND client_id IS NULL AND space_id=? ORDER BY created_at`
      ).all(businessSpaceId()) as any[];
      const rooms = roomRows.filter((r) => conversationAccess(a, r.id)).map((r) => ({ id: r.id, name: r.title || 'Room' }));

      let conv: any = null;
      if (scope === 'room') {
        conv = driveRoom(a, roomId);
        if (!conv) { json(res, 404, { error: 'no such room drive' }); return; }
        if (parent && parent.conversation_id !== conv.id) { json(res, 400, { error: 'that folder is elsewhere' }); return; }
      }

      let rows: any[];
      if (parentId) {
        rows = (db.prepare(`SELECT * FROM drive_items WHERE parent_id=? ORDER BY kind DESC, name COLLATE NOCASE`)
          .all(parentId) as any[]).filter((it) => driveCanOpen(a, it.id));
      } else if (scope === 'room') {
        rows = db.prepare(
          `SELECT * FROM drive_items WHERE conversation_id=? AND parent_id IS NULL ORDER BY kind DESC, name COLLATE NOCASE`
        ).all(conv.id) as any[];
      } else {
        const own = db.prepare(
          `SELECT * FROM drive_items WHERE owner_id=? AND parent_id IS NULL ORDER BY kind DESC, name COLLATE NOCASE`
        ).all(a.userId) as any[];
        const shared = db.prepare(
          `SELECT d.* FROM drive_items d JOIN drive_shares s ON s.item_id=d.id
            WHERE s.user_id=? ORDER BY d.kind DESC, d.name COLLATE NOCASE`
        ).all(a.userId) as any[];
        const seen = new Set(own.map((r) => r.id));
        rows = [...own, ...shared.filter((r) => !seen.has(r.id))];
      }

      const used = scope === 'room' ? Number((db.prepare(
        `SELECT COALESCE(SUM(bytes),0) AS b FROM drive_items WHERE conversation_id=? AND kind='file'`
      ).get(conv.id) as any)?.b || 0) : driveUsedBytes(a.userId);

      json(res, 200, {
        scope,
        roomId: scope === 'room' ? conv.id : null,
        parentId,
        crumbs: parent ? driveCrumbs(parent) : [],
        items: rows.map((it) => driveItemPayload(it, a.userId)),
        rooms,
        usage: { used, quota: driveQuotaBytes() },
        quotaMb: Math.round(driveQuotaBytes() / 1048576),
        canWrite: scope === 'room' ? true : (!parent || parent.owner_id === a.userId),
      });
      return;
    }

    if (p === '/api/drive/folder' && req.method === 'POST') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      if (!userFlags(a.userId).drive) { json(res, 403, { error: 'Drive is switched off for your account' }); return; }
      const body = await readJson(req);
      const name = String(body?.name || '').trim().replace(/[\/\\]/g, '-').slice(0, 80);
      if (!name) { json(res, 400, { error: 'name required' }); return; }
      const scope = body?.scope === 'room' ? 'room' : 'mine';
      const parentId = String(body?.parentId || '') || null;
      let conv: any = null;
      if (scope === 'room') {
        conv = driveRoom(a, String(body?.roomId || ''));
        if (!conv) { json(res, 404, { error: 'no such room drive' }); return; }
      }
      if (parentId) {
        const parent = db.prepare(`SELECT * FROM drive_items WHERE id=?`).get(parentId) as any;
        const ok = parent && parent.kind === 'folder' &&
          (scope === 'room' ? parent.conversation_id === conv.id : parent.owner_id === a.userId);
        if (!ok) { json(res, 400, { error: 'no such folder' }); return; }
      }
      const clash = db.prepare(
        `SELECT 1 AS ok FROM drive_items WHERE parent_id IS ? AND kind='folder'
           AND lower(name)=lower(?) AND (owner_id IS ? AND conversation_id IS ?)`
      ).get(parentId, name, scope === 'mine' ? a.userId : null, scope === 'room' ? conv.id : null);
      if (clash) { json(res, 409, { error: 'a folder with that name is already here' }); return; }
      const folderId = id();
      db.prepare(
        `INSERT INTO drive_items(id, owner_id, conversation_id, parent_id, name, kind, mime, bytes, storage_key,
           version, updated_by, created_at, updated_at)
         VALUES(?,?,?,?,?,'folder','',0,NULL,1,?,?,?)`
      ).run(folderId, scope === 'mine' ? a.userId : null, scope === 'room' ? conv.id : null,
        parentId, name, a.userId, now(), now());
      json(res, 200, { ok: true, folder: driveItemPayload(
        db.prepare(`SELECT * FROM drive_items WHERE id=?`).get(folderId), a.userId) });
      return;
    }

    if (p === '/api/drive/upload' && req.method === 'POST') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      if (!userFlags(a.userId).drive) { json(res, 403, { error: 'Drive is switched off for your account' }); return; }
      if (!allow('drive-upload:' + a.userId, 20)) { json(res, 429, { error: 'slow down' }); return; }

      let rawName = String(req.headers['x-filename'] || 'file');
      try { rawName = decodeURIComponent(rawName); } catch { /* keep raw */ }
      const filename = path.basename(rawName).replace(/[\/\\]/g, '-').slice(0, 120);
      const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].toLowerCase();
      const refusal = uploadRefusal(filename, mime);
      if (refusal) { json(res, 415, { error: refusal }); return; }

      const buf = await readBody(req, UPLOAD_MAX + 1);
      if (buf.length > UPLOAD_MAX) { json(res, 413, { error: 'file too large' }); return; }
      if (!buf.length) { json(res, 400, { error: 'empty file' }); return; }

      const scope = String(req.headers['x-scope'] || 'mine') === 'room' ? 'room' : 'mine';
      const parentId = String(req.headers['x-parent-id'] || '') || null;
      const versionOf = String(req.headers['x-item-id'] || '') || null;
      const storageKey = crypto.randomBytes(16).toString('hex');

      const writeVersion = (itemId: string, version: number, name: string) => {
        const full = db.prepare(`SELECT * FROM drive_items WHERE id=?`).get(itemId) as any;
        db.prepare(
          `INSERT INTO drive_versions(id, item_id, version, storage_key, filename, mime, bytes, uploaded_by, created_at)
           VALUES(?,?,?,?,?,?,?,?,?)`
        ).run(id(), itemId, version, storageKey, name, mime, buf.length, a.userId, now());
        db.prepare(
          `UPDATE drive_items SET storage_key=?, bytes=?, mime=?, version=?, updated_by=?, updated_at=? WHERE id=?`
        ).run(storageKey, buf.length, mime, version, a.userId, now(), itemId);
        return full;
      };

      if (versionOf) {
        const item = driveCanOpen(a, versionOf);
        if (!item || item.kind !== 'file') { json(res, 404, { error: 'no such file' }); return; }
        const canUpdate = a.admin || (item.owner_id === a.userId) ||
          (item.conversation_id && driveRoom(a, item.conversation_id));
        if (!canUpdate) { json(res, 403, { error: 'read only' }); return; }
        if (!item.owner_id || item.owner_id === a.userId) {
          if (item.owner_id === a.userId && driveUsedBytes(a.userId) + buf.length > driveQuotaBytes()) {
            json(res, 413, { error: 'drive quota reached' }); return;
          }
        }
        fs.writeFileSync(path.join(UPLOAD_DIR, storageKey), buf);
        writeVersion(item.id, Number(item.version) + 1, filename);
        json(res, 200, { ok: true, item: driveItemPayload(
          db.prepare(`SELECT * FROM drive_items WHERE id=?`).get(item.id), a.userId) });
        return;
      }

      let conv: any = null;
      if (scope === 'room') {
        conv = driveRoom(a, String(req.headers['x-room-id'] || ''));
        if (!conv) { json(res, 404, { error: 'no such room drive' }); return; }
      } else if (driveUsedBytes(a.userId) + buf.length > driveQuotaBytes()) {
        json(res, 413, { error: 'drive quota reached' }); return;
      }
      if (parentId) {
        const parent = db.prepare(`SELECT * FROM drive_items WHERE id=?`).get(parentId) as any;
        const ok = parent && parent.kind === 'folder' &&
          (scope === 'room' ? parent.conversation_id === conv.id : parent.owner_id === a.userId);
        if (!ok) { json(res, 400, { error: 'no such folder' }); return; }
      }

      fs.writeFileSync(path.join(UPLOAD_DIR, storageKey), buf);
      const itemId = id();
      db.prepare(
        `INSERT INTO drive_items(id, owner_id, conversation_id, parent_id, name, kind, mime, bytes, storage_key,
           version, updated_by, created_at, updated_at)
         VALUES(?,?,?,?,?,'file',?,?,?,1,?,?,?)`
      ).run(itemId, scope === 'mine' ? a.userId : null, scope === 'room' ? conv.id : null,
        parentId, filename, mime, buf.length, storageKey, a.userId, now(), now());
      db.prepare(
        `INSERT INTO drive_versions(id, item_id, version, storage_key, filename, mime, bytes, uploaded_by, created_at)
         VALUES(?,?,1,?,?,?,?,?,?)`
      ).run(id(), itemId, storageKey, filename, mime, buf.length, a.userId, now());
      json(res, 200, { ok: true, item: driveItemPayload(
        db.prepare(`SELECT * FROM drive_items WHERE id=?`).get(itemId), a.userId) });
      return;
    }

    const driveMatch = p.match(/^\/api\/drive\/([^/]+)(\/download|\/versions|\/restore)?$/);
    if (driveMatch) {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      if (!userFlags(a.userId).drive) { json(res, 403, { error: 'Drive is switched off for your account' }); return; }
      const itemId = driveMatch[1];
      const sub = driveMatch[2] || '';
      const item = driveCanOpen(a, itemId);
      if (!item) { json(res, 404, { error: 'no such file' }); return; }

      if (!sub && req.method === 'GET') {
        const versions = db.prepare(
          `SELECT version, filename, mime, bytes, uploaded_by, created_at FROM drive_versions
            WHERE item_id=? ORDER BY version DESC`
        ).all(item.id) as any[];
        json(res, 200, {
          item: driveItemPayload(item, a.userId),
          versions: versions.map((v) => ({
            version: v.version, name: v.filename, mime: v.mime, bytes: v.bytes,
            uploadedBy: userBrief(v.uploaded_by)?.name || 'Someone', createdAt: v.created_at,
          })),
          crumbs: driveCrumbs(item),
          shares: (db.prepare(`SELECT user_id FROM drive_shares WHERE item_id=?`).all(item.id) as any[])
            .map((r) => ({ id: r.user_id, name: userBrief(r.user_id)?.name || 'Someone' })),
        });
        return;
      }

      if (sub === '/download' && req.method === 'GET') {
        if (item.kind !== 'file' || !item.storage_key) { json(res, 400, { error: 'not a file' }); return; }
        const versionNo = Number(url.searchParams.get('version') || 0);
        let storage = item.storage_key;
        let name = item.name;
        let mime = item.mime;
        let bytes = item.bytes;
        if (versionNo) {
          const row = db.prepare(`SELECT * FROM drive_versions WHERE item_id=? AND version=?`)
            .get(item.id, versionNo) as any;
          if (!row) { json(res, 404, { error: 'no such version' }); return; }
          storage = row.storage_key; name = row.filename; mime = row.mime; bytes = row.bytes;
        }
        const file = path.join(UPLOAD_DIR, storage);
        if (!fs.existsSync(file)) { json(res, 404, { error: 'file is gone' }); return; }
        res.writeHead(200, {
          'Content-Type': mime || 'application/octet-stream',
          'Content-Length': String(bytes),
          'Content-Disposition': `attachment; filename="${downloadName(name)}"`,
          'Cache-Control': 'private, max-age=60',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(fs.readFileSync(file));
        return;
      }

      if (sub === '/versions' && req.method === 'GET') {
        const versions = db.prepare(
          `SELECT version, filename, mime, bytes, uploaded_by, created_at FROM drive_versions
            WHERE item_id=? ORDER BY version DESC`
        ).all(item.id) as any[];
        json(res, 200, { versions: versions.map((v) => ({
          version: v.version, name: v.filename, mime: v.mime, bytes: v.bytes,
          uploadedBy: userBrief(v.uploaded_by)?.name || 'Someone', createdAt: v.created_at,
        })) });
        return;
      }

      if (sub === '/restore' && req.method === 'POST') {
        const body = await readJson(req);
        const versionNo = Number(body?.version || 0);
        const row = db.prepare(`SELECT * FROM drive_versions WHERE item_id=? AND version=?`)
          .get(item.id, versionNo) as any;
        if (!row) { json(res, 404, { error: 'no such version' }); return; }
        db.prepare(
          `UPDATE drive_items SET storage_key=?, bytes=?, mime=?, version=version+1, updated_by=?, updated_at=? WHERE id=?`
        ).run(row.storage_key, row.bytes, row.mime, a.userId, now(), item.id);
        json(res, 200, { ok: true });
        return;
      }

      const isOwner = item.owner_id === a.userId;
      const canEdit = a.admin || isOwner || (item.conversation_id && driveRoom(a, item.conversation_id));

      if (!isOwner && !a.admin && !(item.conversation_id && driveRoom(a, item.conversation_id))) {
        json(res, 403, { error: 'read only' }); return;
      }

      if (req.method === 'PATCH') {
        const body = await readJson(req);
        if (body?.name !== undefined) {
          const name = String(body.name || '').trim().replace(/[\/\\]/g, '-').slice(0, 120);
          if (!name) { json(res, 400, { error: 'name required' }); return; }
          db.prepare(`UPDATE drive_items SET name=?, updated_by=?, updated_at=? WHERE id=?`)
            .run(name, a.userId, now(), item.id);
        }
        if (body?.parentId !== undefined) {
          const target = String(body.parentId || '') || null;
          if (target === item.id) { json(res, 400, { error: 'cannot move into itself' }); return; }
          if (target) {
            const folder = db.prepare(`SELECT * FROM drive_items WHERE id=?`).get(target) as any;
            const sameScope = folder && folder.kind === 'folder' && (
              item.conversation_id
                ? folder.conversation_id === item.conversation_id
                : folder.owner_id === item.owner_id && !folder.conversation_id);
            if (!sameScope) { json(res, 400, { error: 'no such folder here' }); return; }
            let walk = folder;
            let guard = 0;
            while (walk && guard++ < 50) {
              if (walk.id === item.id) { json(res, 400, { error: 'cannot move into itself' }); return; }
              walk = walk.parent_id ? db.prepare(`SELECT * FROM drive_items WHERE id=?`).get(walk.parent_id) as any : null;
            }
          }
          db.prepare(`UPDATE drive_items SET parent_id=?, updated_by=?, updated_at=? WHERE id=?`)
            .run(target, a.userId, now(), item.id);
        }
        if (Array.isArray(body?.shareUserIds)) {
          if (!isOwner && !a.admin) { json(res, 403, { error: 'only the owner can share' }); return; }
          const ids: string[] = [...new Set<string>((body.shareUserIds as unknown[]).map((x) => String(x)))]
            .slice(0, 100).filter((uid) => uid && uid !== item.owner_id);
          db.prepare(`DELETE FROM drive_shares WHERE item_id=?`).run(item.id);
          for (const uid of ids) {
            const person = db.prepare(`SELECT id FROM users WHERE id=? AND disabled=0`).get(uid) as any;
            if (!person) continue;
            db.prepare(`INSERT OR IGNORE INTO drive_shares(item_id, user_id, created_at) VALUES(?,?,?)`)
              .run(item.id, uid, now());
            sendToUserId(uid, { t: 'drive', name: item.name });
          }
        }
        json(res, 200, { ok: true, item: driveItemPayload(
          db.prepare(`SELECT * FROM drive_items WHERE id=?`).get(item.id), a.userId) });
        return;
      }

      if (req.method === 'DELETE') {
        if (!canEdit) { json(res, 403, { error: 'not allowed' }); return; }
        const all = db.prepare(
          `WITH RECURSIVE tree(id) AS (
             SELECT id FROM drive_items WHERE id=?
             UNION ALL SELECT d.id FROM drive_items d JOIN tree t ON d.parent_id=t.id
           ) SELECT id FROM tree`
        ).all(item.id) as any[];
        const ids = all.map((r) => r.id);
        for (const one of ids) {
          const files = db.prepare(`SELECT storage_key FROM drive_items WHERE id=? AND storage_key IS NOT NULL`).all(one) as any[];
          const vers = db.prepare(`SELECT storage_key FROM drive_versions WHERE item_id=?`).all(one) as any[];
          for (const f of [...files, ...vers]) {
            try { fs.unlinkSync(path.join(UPLOAD_DIR, f.storage_key)); } catch { /* already gone */ }
          }
          db.prepare(`DELETE FROM mail_attachments WHERE item_id=?`).run(one);
          db.prepare(`DELETE FROM drive_shares WHERE item_id=?`).run(one);
          db.prepare(`DELETE FROM drive_versions WHERE item_id=?`).run(one);
        }
        for (const one of ids) db.prepare(`DELETE FROM drive_items WHERE id=?`).run(one);
        json(res, 200, { ok: true, removed: ids.length });
        return;
      }
    }

    /* ---------- internal mail ---------- */

    if (p === '/api/mail' && req.method === 'GET') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const folder = url.searchParams.get('folder') === 'sent' ? 'sent' : 'inbox';
      json(res, 200, { folder, threads: mailThreads(a.userId, folder), unread: mailUnread(a.userId) });
      return;
    }

    if (p === '/api/mail' && req.method === 'POST') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      if (!allow('mail:' + a.userId, 20)) { json(res, 429, { error: 'slow down' }); return; }
      const body = await readJson(req);
      const to = [...new Set((Array.isArray(body?.to) ? body.to : []).map(String).filter(Boolean))];
      const people = to.map((uid) => db.prepare(`SELECT id, display_name FROM users WHERE id=? AND disabled=0`).get(uid) as any)
        .filter(Boolean);
      if (!people.length) { json(res, 400, { error: 'pick at least one person' }); return; }
      const subject = String(body?.subject || '').trim().slice(0, 200) || '(no subject)';
      const text = String(body?.body || '').trim().slice(0, 20000);
      if (!text && !(Array.isArray(body?.attachmentIds) && body.attachmentIds.length)) {
        json(res, 400, { error: 'write something or attach a file' }); return;
      }
      const priority = body?.priority === 'high' ? 'high' : 'normal';
      const mailId = id();
      db.prepare(
        `INSERT INTO mail(id, thread_id, from_id, to_ids, subject, body, priority, created_at)
         VALUES(?,?,?,?,?,?,?,?)`
      ).run(mailId, mailId, a.userId, JSON.stringify(people.map((u) => u.id)), subject, text, priority, now());

      for (const itemId of (Array.isArray(body?.attachmentIds) ? body.attachmentIds : []).slice(0, 10)) {
        const item = driveItem(a, String(itemId));
        if (!item || item.owner_id !== a.userId || item.kind !== 'file') continue;
        db.prepare(`INSERT INTO mail_attachments(id, mail_id, item_id, created_at) VALUES(?,?,?,?)`)
          .run(id(), mailId, item.id, now());
        for (const u of people) {
          db.prepare(`INSERT OR IGNORE INTO drive_shares(item_id, user_id, created_at) VALUES(?,?,?)`)
            .run(item.id, u.id, now());
        }
      }

      const row = db.prepare(`SELECT * FROM mail WHERE id=?`).get(mailId);
      for (const u of people) {
        sendToUserId(u.id, { t: 'mail', threadId: mailId, subject, fromName: a.name });
      }
      json(res, 200, { ok: true, mail: mailPayload(row, a.userId), unread: mailUnread(a.userId) });
      return;
    }

    const mailAttach = p.match(/^\/api\/mail\/attachments\/([^/]+)\/download$/);
    if (mailAttach && req.method === 'GET') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const row = db.prepare(
        `SELECT a.id, a.item_id, m.from_id, m.to_ids FROM mail_attachments a
           JOIN mail m ON m.id = a.mail_id WHERE a.id=?`
      ).get(mailAttach[1]) as any;
      if (!row || !(row.from_id === a.userId || mailRecipients(row).includes(a.userId))) {
        json(res, 404, { error: 'not found' }); return;
      }
      const item = driveCanOpen(a, row.item_id);
      if (!item || item.kind !== 'file' || !item.storage_key) { json(res, 404, { error: 'file is gone' }); return; }
      const file = path.join(UPLOAD_DIR, item.storage_key);
      if (!fs.existsSync(file)) { json(res, 404, { error: 'file is gone' }); return; }
      res.writeHead(200, {
        'Content-Type': item.mime || 'application/octet-stream',
        'Content-Length': String(item.bytes),
        'Content-Disposition': `attachment; filename="${downloadName(item.name)}"`,
        'Cache-Control': 'private, max-age=60',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(fs.readFileSync(file));
      return;
    }

    const mailOne = p.match(/^\/api\/mail\/([^/]+)(\/reply)?$/);
    if (mailOne) {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const threadId = mailOne[1];
      const rows = db.prepare(`SELECT * FROM mail WHERE thread_id=? ORDER BY created_at`).all(threadId) as any[];
      const involved = rows.some((r) => r.from_id === a.userId || mailRecipients(r).includes(a.userId));
      if (!rows.length || !involved) { json(res, 404, { error: 'no such mail' }); return; }

      if (!mailOne[2] && req.method === 'GET') {
        db.prepare(`INSERT INTO mail_reads(thread_id, user_id, read_at) VALUES(?,?,?)
                    ON CONFLICT(thread_id, user_id) DO UPDATE SET read_at=excluded.read_at`)
          .run(threadId, a.userId, now());
        json(res, 200, {
          threadId,
          subject: rows[0].subject,
          messages: rows.map((r) => mailPayload(r, a.userId)),
          unread: mailUnread(a.userId),
        });
        return;
      }

      if (!mailOne[2] && req.method === 'DELETE') {
        db.prepare(`INSERT INTO mail_deleted(thread_id, user_id, deleted_at) VALUES(?,?,?)
                    ON CONFLICT(thread_id, user_id) DO UPDATE SET deleted_at=excluded.deleted_at`)
          .run(threadId, a.userId, now());
        json(res, 200, { ok: true, unread: mailUnread(a.userId) });
        return;
      }

      if (mailOne[2] === '/reply' && req.method === 'POST') {
        const body = await readJson(req);
        const text = String(body?.body || '').trim().slice(0, 20000);
        if (!text) { json(res, 400, { error: 'write something' }); return; }
        const participants = new Set<string>();
        for (const r of rows) {
          participants.add(r.from_id);
          for (const u of mailRecipients(r)) participants.add(u);
        }
        participants.delete(a.userId);
        const to = [...participants].filter((uid) => !!db.prepare(
          `SELECT 1 AS ok FROM users WHERE id=? AND disabled=0`).get(uid));
        if (!to.length) { json(res, 400, { error: 'nobody to reply to' }); return; }
        const mailId = id();
        db.prepare(
          `INSERT INTO mail(id, thread_id, from_id, to_ids, subject, body, priority, created_at)
           VALUES(?,?,?,?,?,?,?,?)`
        ).run(mailId, threadId, a.userId, JSON.stringify(to), rows[0].subject, text, 'normal', now());
        const row = db.prepare(`SELECT * FROM mail WHERE id=?`).get(mailId);
        for (const uid of to) sendToUserId(uid, { t: 'mail', threadId, subject: rows[0].subject, fromName: a.name });
        json(res, 200, { ok: true, mail: mailPayload(row, a.userId), unread: mailUnread(a.userId) });
        return;
      }
    }

    /* ---------- helpdesk ---------- */

    if (p === '/api/tickets' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      ensureTickets();
      const status = String(url.searchParams.get('status') || '');
      const rows = db.prepare(`SELECT * FROM tickets ORDER BY updated_at DESC`).all() as any[];
      json(res, 200, {
        tickets: rows.filter((r) => !status || r.status === status).map(ticketPayload),
        counts: {
          open: rows.filter((r) => r.status === 'open').length,
          pending: rows.filter((r) => r.status === 'pending').length,
          resolved: rows.filter((r) => r.status === 'resolved').length,
        },
      });
      return;
    }

    const ticketOne = p.match(/^\/api\/tickets\/([^/]+)$/);
    if (ticketOne) {
      if (!requireAdmin(req, res)) return;
      const row = db.prepare(`SELECT * FROM tickets WHERE id=?`).get(ticketOne[1]) as any;
      if (!row) { json(res, 404, { error: 'no such ticket' }); return; }
      if (req.method === 'GET') { json(res, 200, ticketPayload(row)); return; }
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        if (body?.subject !== undefined) {
          const subject = String(body.subject || '').trim().slice(0, 200);
          if (subject) db.prepare(`UPDATE tickets SET subject=? WHERE id=?`).run(subject, row.id);
        }
        if (body?.status !== undefined) {
          const status = ['open', 'pending', 'resolved'].includes(String(body.status)) ? String(body.status) : 'open';
          db.prepare(`UPDATE tickets SET status=?, closed_at=? WHERE id=?`)
            .run(status, status === 'resolved' ? now() : null, row.id);
        }
        if (body?.priority !== undefined) {
          const pr = ['low', 'normal', 'high'].includes(String(body.priority)) ? String(body.priority) : 'normal';
          db.prepare(`UPDATE tickets SET priority=? WHERE id=?`).run(pr, row.id);
        }
        if (body?.assigneeId !== undefined) {
          const uid = String(body.assigneeId || '') || null;
          const person = uid ? db.prepare(`SELECT id FROM users WHERE id=?`).get(uid) as any : null;
          db.prepare(`UPDATE tickets SET assignee_id=? WHERE id=?`).run(person ? person.id : null, row.id);
          if (person) sendToUserId(person.id, { t: 'ticket', ticketId: row.id });
        }
        db.prepare(`UPDATE tickets SET updated_at=? WHERE id=?`).run(now(), row.id);
        json(res, 200, { ok: true, ticket: ticketPayload(
          db.prepare(`SELECT * FROM tickets WHERE id=?`).get(row.id)) });
        return;
      }
    }

    /* ---------- REST API keys (admin) ---------- */

    if (p === '/api/admin/api-tokens') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      if (req.method === 'GET') {
        const rows = db.prepare(
          `SELECT t.*, u.display_name FROM api_tokens t LEFT JOIN users u ON u.id=t.created_by
            WHERE t.revoked_at IS NULL ORDER BY t.created_at DESC`
        ).all() as any[];
        json(res, 200, {
          tokens: rows.map((r) => ({
            id: r.id, name: r.name, prefix: r.prefix, scopes: r.scopes,
            createdBy: r.display_name || 'Someone', createdAt: r.created_at,
            lastUsedAt: r.last_used_at || null,
          })),
          quotaMb: Math.round(driveQuotaBytes() / 1048576),
        });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        const name = String(body?.name || '').trim().slice(0, 60);
        if (!name) { json(res, 400, { error: 'give the key a name' }); return; }
        const scopes = Array.isArray(body?.scopes)
          ? body.scopes.map(String).filter((s: string) => s === 'read' || s === 'write')
          : ['read', 'write'];
        if (!scopes.length) scopes.push('read');
        const token = 'omk_' + newToken();
        db.prepare(
          `INSERT INTO api_tokens(id, name, token_hash, prefix, scopes, created_by, created_at, last_used_at, revoked_at)
           VALUES(?,?,?,?,?,?,?,NULL,NULL)`
        ).run(id(), name, sha256(token), token.slice(0, 12), scopes.join(','), admin.userId, now());
        audit(admin.userId, admin.name, 'api.key.create', name);
        json(res, 200, { ok: true, token, name, scopes });
        return;
      }
    }

    const tokenOne = p.match(/^\/api\/admin\/api-tokens\/([^/]+)$/);
    if (tokenOne && req.method === 'DELETE') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      const row = db.prepare(`SELECT * FROM api_tokens WHERE id=?`).get(tokenOne[1]) as any;
      if (!row) { json(res, 404, { error: 'not found' }); return; }
      db.prepare(`UPDATE api_tokens SET revoked_at=? WHERE id=?`).run(now(), row.id);
      audit(admin.userId, admin.name, 'api.key.revoke', row.name);
      json(res, 200, { ok: true });
      return;
    }

    /* ---------- two-factor sign-in (self service) ---------- */

    if (p === '/api/2fa') {
      const a = resolveAuth(req);
      if (!a || a.kind !== 'operator') { json(res, 401, { error: 'unauthorized' }); return; }
      const row = db.prepare(`SELECT totp_enabled FROM users WHERE id=?`).get(a.userId) as any;
      json(res, 200, {
        enabled: Number(row?.totp_enabled) === 1,
        required: getSetting('require_2fa', '0') === '1',
        pending: !!a.needs2fa,
      });
      return;
    }

    if (p === '/api/2fa/start' && req.method === 'POST') {
      const a = resolveAuth(req);
      if (!a || a.kind !== 'operator') { json(res, 401, { error: 'unauthorized' }); return; }
      if (!allow('2fa:' + a.userId, 6)) { json(res, 429, { error: 'slow down' }); return; }
      const secret = newTotpSecret();
      db.prepare(`UPDATE users SET totp_secret=?, totp_enabled=0 WHERE id=?`).run(secret, a.userId);
      json(res, 200, { secret, uri: otpauthUrl(secret, a.name) });
      return;
    }

    if (p === '/api/2fa/confirm' && req.method === 'POST') {
      const a = resolveAuth(req);
      if (!a || a.kind !== 'operator') { json(res, 401, { error: 'unauthorized' }); return; }
      const body = await readJson(req);
      const user = db.prepare(`SELECT totp_secret FROM users WHERE id=?`).get(a.userId) as any;
      if (!user?.totp_secret) { json(res, 400, { error: 'start the setup first' }); return; }
      if (!totpVerify(user.totp_secret, String(body?.code || ''))) {
        json(res, 400, { error: 'That code is not right. Check the clock on this device.' });
        return;
      }
      db.prepare(`UPDATE users SET totp_enabled=1 WHERE id=?`).run(a.userId);
      db.prepare(`UPDATE sessions SET needs_2fa=0 WHERE user_id=?`).run(a.userId);
      audit(a.userId, a.name, '2fa.enable', 'two-factor sign-in turned on');
      json(res, 200, { ok: true });
      return;
    }

    if (p === '/api/2fa/disable' && req.method === 'POST') {
      const a = resolveAuth(req);
      if (!a || a.kind !== 'operator') { json(res, 401, { error: 'unauthorized' }); return; }
      const body = await readJson(req);
      const user = db.prepare(`SELECT password_hash FROM users WHERE id=?`).get(a.userId) as any;
      if (!user || !scryptVerify(String(body?.password || ''), user.password_hash)) {
        json(res, 401, { error: 'wrong password' }); return;
      }
      db.prepare(`UPDATE users SET totp_secret=NULL, totp_enabled=0 WHERE id=?`).run(a.userId);
      audit(a.userId, a.name, '2fa.disable', 'two-factor sign-in turned off');
      json(res, 200, { ok: true });
      return;
    }

    /* ---------- backups, restore, directory import (admin) ---------- */

    if (p === '/api/admin/retention/run' && req.method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      const removed = runRetention();
      audit(admin.userId, admin.name, 'retention.run', `${removed} old messages removed`);
      json(res, 200, { ok: true, removed, lastRun: Number(getSetting('retention_last_run', '0')) || 0 });
      return;
    }

    if (p === '/api/admin/backups' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      json(res, 200, { backups: listBackups() });
      return;
    }

    if (p === '/api/admin/backups' && req.method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      const made = makeBackup('manual');
      audit(admin.userId, admin.name, 'backup.create', made.name);
      json(res, 200, { ok: true, name: made.name, bytes: made.bytes, backups: listBackups() });
      return;
    }

    const backupFile = p.match(/^\/api\/admin\/backups\/([A-Za-z0-9._-]+\.db)$/);
    if (backupFile && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      const file = path.join(BACKUP_DIR, backupFile[1]);
      if (!fs.existsSync(file)) { json(res, 404, { error: 'not found' }); return; }
      res.writeHead(200, {
        'Content-Type': 'application/vnd.sqlite3',
        'Content-Length': String(fs.statSync(file).size),
        'Content-Disposition': `attachment; filename="${backupFile[1]}"`,
        'Cache-Control': 'no-store',
      });
      res.end(fs.readFileSync(file));
      return;
    }

    if (p === '/api/admin/restore' && req.method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      if (!allow('restore:' + admin.userId, 3)) { json(res, 429, { error: 'slow down' }); return; }
      const buf = await readBody(req, 200 * 1024 * 1024);
      if (!buf.length) { json(res, 400, { error: 'empty file' }); return; }
      if (buf.subarray(0, 15).toString('utf8') !== 'SQLite format 3') {
        json(res, 400, { error: 'that is not a SQLite database' }); return;
      }
      const temp = path.join(DATA_DIR, 'restore-upload.db');
      fs.writeFileSync(temp, buf);
      try {
        const before = makeBackup('pre-restore');
        const result = restoreDatabase(temp);
        audit(admin.userId, admin.name, 'backup.restore',
          `${result.tables} tables from an uploaded file; previous copy ${before.name}`);
        sendToStaff({ t: 'refresh' });
        json(res, 200, { ok: true, ...result, safetyCopy: before.name });
      } catch (err: any) {
        json(res, 400, { error: err?.message || 'that file could not be restored' });
      } finally {
        try { fs.unlinkSync(temp); } catch { /* already gone */ }
      }
      return;
    }

    if (p === '/api/admin/directory/import' && req.method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      const body = await readJson(req);
      const csv = String(body?.csv || '');
      if (!csv.trim()) { json(res, 400, { error: 'the file is empty' }); return; }
      const rows = parseCsv(csv);
      if (!rows.length) { json(res, 400, { error: 'no rows found' }); return; }
      const head = rows[0].map((h) => h.trim().toLowerCase());
      const at = (row: string[], key: string) => {
        const i = head.indexOf(key);
        return i >= 0 ? String(row[i] || '').trim() : '';
      };
      if (!head.includes('name')) {
        json(res, 400, { error: 'the first row must name the columns, starting with name' }); return;
      }
      const dry = body?.dryRun === true;
      const result = { created: 0, updated: 0, skipped: 0, invited: [] as { name: string; username: string; password: string }[], problems: [] as string[] };
      for (const row of rows.slice(1)) {
        const name = at(row, 'name').slice(0, 60);
        const username = at(row, 'username').toLowerCase().slice(0, 40);
        const email = at(row, 'email').toLowerCase().slice(0, 120);
        const role = ['manager', 'member'].includes(at(row, 'role').toLowerCase()) ? at(row, 'role').toLowerCase() : 'member';
        const deptName = at(row, 'department').slice(0, 60);
        if (!name || (!username && !email)) { result.problems.push('a row is missing a name or sign-in'); continue; }
        const existing = username
          ? db.prepare(`SELECT id FROM users WHERE lower(username)=?`).get(username) as any
          : db.prepare(`SELECT id FROM users WHERE lower(email)=?`).get(email) as any;
        if (existing) {
          if (dry) { result.skipped += 1; continue; }
          db.prepare(`UPDATE users SET display_name=?, role=? WHERE id=?`).run(name, role, existing.id);
          result.updated += 1;
          continue;
        }
        let departmentId: string | null = null;
        if (deptName) {
          const found = db.prepare(`SELECT id FROM departments WHERE lower(name)=lower(?)`).get(deptName) as any;
          if (found) departmentId = found.id;
          else if (!dry) {
            departmentId = id();
            db.prepare(`INSERT INTO departments(id, name, created_at) VALUES(?,?,?)`)
              .run(departmentId, deptName, now());
          }
        }
        const password = at(row, 'password') || crypto.randomBytes(6).toString('base64url');
        if (dry) { result.created += 1; continue; }
        db.prepare(
          `INSERT INTO users(id, email, username, display_name, password_hash, role, is_operator,
             department_id, disabled, status, status_text, created_at)
           VALUES(?,?,?,?,?,?,0,?,0,'Offline','',?)`
        ).run(id(), email || null, username || null, name, scryptHash(password.slice(0, 200)), role, departmentId, now());
        result.created += 1;
        if (!at(row, 'password')) result.invited.push({ name, username: username || email, password });
      }
      if (!dry) audit(admin.userId, admin.name, 'directory.import',
        `${result.created} created, ${result.updated} updated, ${result.skipped} skipped`);
      json(res, 200, { ok: true, ...result, dryRun: dry });
      return;
    }

    /* ---------- abuse letter ---------- */

    if (p === '/api/admin/abuse-letter' && req.method === 'GET') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      const hours = Math.max(1, Math.min(720, Number(url.searchParams.get('hours') || 24)));
      const since = now() - hours * 3600 * 1000;
      const rows = db.prepare(`SELECT user_name, handle, ip, host, agent, note, created_at
                                 FROM signin_log WHERE ok=0 AND created_at>=?
                                 ORDER BY created_at DESC LIMIT 500`).all(since) as any[];

      type Group = { ip: string; host: string; attempts: number; names: Set<string>;
                     reasons: Map<string, number>; agents: Set<string>; first: number; last: number };
      const groups = new Map<string, Group>();
      for (const r of rows) {
        const key = String(r.ip || 'unknown');
        const g = groups.get(key) || {
          ip: key, host: '', attempts: 0, names: new Set<string>(),
          reasons: new Map<string, number>(), agents: new Set<string>(),
          first: r.created_at, last: r.created_at,
        };
        g.attempts += 1;
        if (r.host) g.host = String(r.host);
        if (r.handle) g.names.add(String(r.handle));
        const reason = String(r.note || 'refused');
        g.reasons.set(reason, (g.reasons.get(reason) || 0) + 1);
        if (r.agent) g.agents.add(String(r.agent));
        g.first = Math.min(g.first, r.created_at);
        g.last = Math.max(g.last, r.created_at);
        groups.set(key, g);
      }
      const sorted = [...groups.values()].sort((a, b) => b.attempts - a.attempts);

      // The letter goes to this server's own domain: admin@<public host or hostname>.
      let domain = '';
      try {
        const custom = getSetting('public_url', '');
        if (custom) domain = new URL(custom).hostname;
      } catch { /* fall through */ }
      if (!domain) domain = String(os.hostname() || '').toLowerCase() || 'localhost';
      const to = String(getSetting('abuse_mailbox', '')).trim() || ('admin@' + domain);

      const when = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
      const attemptsWord = rows.length === 1 ? 'attempt' : 'attempts';
      const subject = 'Request to stop ' + rows.length + ' sign-in ' + attemptsWord + ' from '
        + sorted.length + ' address' + (sorted.length === 1 ? '' : 'es');

      const lines: string[] = [];
      lines.push('To: ' + to);
      lines.push('From: ' + admin.name + ' <' + (getSetting('abuse_from', '') || ('messenger@' + domain)) + '>');
      lines.push('Subject: ' + subject);
      lines.push('');
      lines.push('Hello,');
      lines.push('');
      if (!rows.length) {
        lines.push('There is nothing to report: no sign-in attempt was refused in the last '
          + hours + ' hours.');
      } else {
        lines.push('Our messenger recorded ' + rows.length + ' refused sign-in ' + attemptsWord + ' from '
          + sorted.length + ' address' + (sorted.length === 1 ? '' : 'es') + ' in the last ' + hours
          + ' hours, between ' + when(since) + ' and ' + when(now()) + '.');
        lines.push('We are asking you to stop these attempts. If an address belongs to somebody who');
        lines.push('should have access, tell us and we will arrange it properly instead.');
        lines.push('');
        let n = 0;
        for (const g of sorted) {
          n += 1;
          lines.push(n + '. ' + g.ip + (g.host ? ' (' + g.host + ')' : '')
            + ' — ' + g.attempts + ' attempt' + (g.attempts === 1 ? '' : 's'));
          lines.push('   First ' + when(g.first) + ', last ' + when(g.last));
          if (g.names.size) lines.push('   Names tried: ' + [...g.names].slice(0, 8).join(', '));
          lines.push('   Reasons: ' + [...g.reasons.entries()].map(([k, v]) => k + ' x' + v).join(', '));
          if (g.agents.size) lines.push('   Browsers: ' + [...g.agents].slice(0, 4).join(' | '));
        }
        lines.push('');
        lines.push('Latest entries:');
        for (const r of rows.slice(0, 20).reverse()) {
          lines.push('   ' + when(r.created_at) + '  ' + (r.ip || '?')
            + (r.host ? ' (' + r.host + ')' : '') + '  '
            + (r.handle || r.user_name || '(no name)') + '  ' + (r.note || 'refused') + '  '
            + String(r.agent || '').slice(0, 40));
        }
      }
      lines.push('');
      lines.push('We keep this log for security purposes and can share more detail on request.');
      lines.push('');
      lines.push('Regards,');
      lines.push(admin.name);
      lines.push('Messenger administrator' + (domain ? ', ' + domain : ''));

      json(res, 200, {
        to, subject, body: lines.join(String.fromCharCode(10)),
        attempts: rows.length, addresses: sorted.length, hours,
      });
      return;
    }

    /* ---------- blocks ---------- */

    if (p === '/api/admin/blocks') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      if (req.method === 'GET') { json(res, 200, blockList()); return; }
      if (req.method === 'POST') {
        const body = await readJson(req) as any;
        const ip = String(body?.ip || '').split(',').map((x) => x.trim()).filter(Boolean).join(',');
        const host = String(body?.host || '').trim().toLowerCase();
        const name = String(body?.name || '').trim();
        if (!ip && !host && !name) { json(res, 400, { error: 'give a name, an address or a DNS name' }); return; }
        for (const one of ip ? ip.split(',') : []) {
          if (!/^[0-9a-fA-F:.]+$/.test(one)) { json(res, 400, { error: 'that does not look like an address' }); return; }
        }
        db.prepare(`INSERT INTO signin_blocks(id, ip, host, name, note, created_by, created_at)
                    VALUES(?,?,?,?,?,?,?)`)
          .run(id(), ip, host, name, String(body?.note || '').slice(0, 200), admin.name, now());
        blockCache = null;
        audit(admin.userId, admin.name, 'block.add', [name, ip, host].filter(Boolean).join(' / '));
        json(res, 200, { ok: true, blocks: blockList() });
        return;
      }
    }

    if (p.startsWith('/api/admin/blocks/') && req.method === 'DELETE') {
      const blockId = decodeURIComponent(p.slice('/api/admin/blocks/'.length));
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      db.prepare('DELETE FROM signin_blocks WHERE id=?').run(blockId);
      blockCache = null;
      audit(admin.userId, admin.name, 'block.remove', blockId);
      json(res, 200, { ok: true });
      return;
    }

    if (p === '/api/admin/firewall' && req.method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      const body = await readJson(req) as any;
      const ip = String(body?.ip || '').trim();
      if (!/^[0-9a-fA-F:.]+$/.test(ip)) { json(res, 400, { error: 'give one address' }); return; }
      const rule = 'Peach Assist block ' + ip;
      const args = ['advfirewall', 'firewall', 'add', 'rule', 'name=' + rule, 'dir=in', 'action=block', 'remoteip=' + ip];
      const command = 'netsh ' + args.join(' ');
      const result = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
        execFile('netsh', args, { timeout: 10000 }, (err, stdout, stderr) => {
          resolve({ ok: !err, detail: String(stdout || stderr || (err && err.message) || '').trim().slice(0, 400) });
        });
      });
      audit(admin.userId, admin.name, 'firewall.block', ip + (result.ok ? ' added' : ' failed'));
      json(res, 200, { ok: result.ok, command, detail: result.detail });
      return;
    }

    /* ---------- sign-ins ---------- */

    if (p === '/api/admin/signins' && req.method === 'GET') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      const rows = db.prepare(`SELECT user_name, handle, ip, host, agent, ok, note, created_at
                                 FROM signin_log ORDER BY created_at DESC LIMIT 200`).all() as any[];
      json(res, 200, rows.map((r) => ({
        who: r.user_name, handle: r.handle, ip: r.ip, host: r.host, agent: r.agent,
        ok: !!r.ok, note: r.note, at: r.created_at,
      })));
      return;
    }

    /* ---------- port ---------- */

    /* ---------- dynamic DNS ---------- */

    if (p === '/api/admin/ddns') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      if (req.method === 'GET') {
        json(res, 200, {
          host: getSetting('ddns_host', ''),
          mode: getSetting('ddns_mode', 'off'),
          url: getSetting('ddns_url', ''),
          user: getSetting('ddns_user', ''),
          hasPass: !!getSetting('ddns_pass', '') || !!process.env.DDNS_PASSWORD,
          lastIp: getSetting('ddns_last_ip', ''),
          lastAt: Number(getSetting('ddns_last_at', '0')) || 0,
          result: getSetting('ddns_result', ''),
          detail: getSetting('ddns_detail', ''),
          publicIp: PUBLIC_IP,
          link: ddnsLink(),
        });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        const host = String(body?.host || '').trim().toLowerCase().slice(0, 200);
        if (host && !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(host)) {
          json(res, 400, { error: 'that does not look like a hostname' }); return;
        }
        const mode = ['off', 'dyndns2', 'noip', 'duckdns', 'custom'].includes(String(body?.mode))
          ? String(body.mode) : 'off';
        const url = String(body?.url || '').trim().slice(0, 300);
        if (url && !/^https?:\/\//i.test(url)) {
          json(res, 400, { error: 'the update address must start with http:// or https://' }); return;
        }
        setSetting('ddns_host', host);
        setSetting('ddns_mode', host ? mode : 'off');
        setSetting('ddns_url', url);
        setSetting('ddns_user', String(body?.user || '').trim().slice(0, 120));
        if (typeof body?.pass === 'string' && body.pass) {
          setSetting('ddns_pass', String(body.pass).slice(0, 200));
        }
        if (body?.clearPass) setSetting('ddns_pass', '');
        audit(admin.userId, admin.name, 'ddns.save', host ? host + ' via ' + mode : 'cleared');
        json(res, 200, { ok: true, link: ddnsLink() });
        return;
      }
    }

    // How this server is reached from outside: through the VPN, through the
    // home router, or by hand. Read by the panel, written here.
    if (p === '/api/admin/public-path') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      if (req.method === 'GET') {
        json(res, 200, { path: publicPath() });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        const want = String(body?.path || '').toLowerCase();
        if (!['vpn', 'upnp', 'manual'].includes(want)) {
          json(res, 400, { error: 'choose vpn, upnp or manual' }); return;
        }
        setSetting('public_path', want);
        audit(admin.userId, admin.name, 'network.path', want);
        json(res, 200, { ok: true, path: want, restartRequired: true });
        return;
      }
    }

    // The router's address, typed by hand. Android cannot read the routing
    // table, so on a phone this is the difference between a mapping and a
    // shrug — and a wrong guess costs one field to correct.
    if (p === '/api/admin/gateway' && req.method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      const body = await readJson(req);
      const ip = String(body?.ip || '').trim();
      if (ip && !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        json(res, 400, { error: 'that is not an address like 192.168.1.1' }); return;
      }
      setSetting('gateway_ip', ip);
      process.env.GATEWAY = ip;
      audit(admin.userId, admin.name, 'network.gateway', ip || '(cleared)');
      json(res, 200, { ok: true, ip });
      return;
    }

    // The port the world uses, when 3000 is not available to forward.
    if (p === '/api/admin/external-port' && req.method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      const body = await readJson(req);
      const raw = String(body?.port ?? '').trim();
      const port = raw === '' ? 0 : Number(raw);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        json(res, 400, { error: 'a port is a whole number between 1 and 65535' }); return;
      }
      setSetting('external_port', port ? String(port) : '');
      if (port) process.env.EXTERNAL_PORT = String(port);
      else delete process.env.EXTERNAL_PORT;
      audit(admin.userId, admin.name, 'network.external_port', port ? String(port) : '(same as listening port)');
      json(res, 200, { ok: true, port });
      return;
    }

    // Ask the router right now and hand back every step it took, so a failure
    // says which step failed instead of "not available".
    if (p === '/api/admin/router-check' && req.method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      const result = await routerCheck(PORT);
      audit(admin.userId, admin.name, 'network.check', result.ok ? 'mapped' : String(result.error || 'failed'));
      json(res, 200, result);
      return;
    }

    if (p === '/api/admin/ddns/check' && req.method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      const result = await ddnsUpdate(true);
      audit(admin.userId, admin.name, 'ddns.check',
        (result.ok ? 'ok ' : 'failed ') + result.detail);
      json(res, 200, { ok: result.ok, detail: result.detail, ip: result.ip, link: ddnsLink() });
      return;
    }

    if (p === '/api/admin/port') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      if (req.method === 'GET') {
        json(res, 200, { ok: true, listening: PORT, manual: Number(getSetting('manual_port', '0')) || 0 });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJson(req) as any;
        const raw = String(body?.port ?? '').trim();
        if (!raw) {
          setSetting('manual_port', '');
          audit(admin.userId, admin.name, 'port.clear', 'hand-set port removed');
          json(res, 200, { ok: true, manual: 0, listening: PORT, restartRequired: false });
          return;
        }
        const n = Math.round(Number(raw));
        if (!Number.isFinite(n) || n < 1 || n > 65535) {
          json(res, 400, { error: 'a port is a number from 1 to 65535' }); return;
        }
        setSetting('manual_port', String(n));
        audit(admin.userId, admin.name, 'port.set', 'manual port ' + n);
        json(res, 200, { ok: true, manual: n, listening: PORT, restartRequired: n !== PORT });
        return;
      }
    }

    /* ---------- hang up and redial ---------- */

    // Network HUP: re-apply the public path without dropping connections.
    if (p === '/api/admin/network-hup' && req.method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      const result = await applyNetworkNow();
      audit(admin.userId, admin.name, 'server.network-hup',
        result.path + ': ' + result.details.join('; '));
      json(res, 200, result);
      return;
    }

    // A clean copy, built here on the device: the program with an empty database
    // that holds one account (admin/peach123) and nothing of this install's.
    if (p === '/api/admin/clean-package' && req.method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      try {
        const appRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
        const built = await buildCleanPackage(appRoot, DATA_DIR, stamp);
        const name = path.basename(built.file);
        audit(admin.userId, admin.name, 'server.clean-package', `${name} (${built.files} files)`);
        json(res, 200, {
          ok: true, name, bytes: built.bytes, files: built.files,
          url: '/api/admin/clean-package/' + encodeURIComponent(name),
        });
      } catch (err) {
        json(res, 500, { error: String(err instanceof Error ? err.message : err) });
      }
      return;
    }

    const cleanMatch = p.match(/^\/api\/admin\/clean-package\/([A-Za-z0-9._-]+)$/);
    if (cleanMatch && req.method === 'GET') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      const name = cleanMatch[1];
      if (!/^PeachMessenger-clean-[A-Za-z0-9._-]+\.zip$/.test(name)) { json(res, 400, { error: 'bad name' }); return; }
      const file = path.join(DATA_DIR, 'exports', name);
      if (!fs.existsSync(file)) { json(res, 404, { error: 'build one first' }); return; }
      const buf = fs.readFileSync(file);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': String(buf.length),
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'private, no-store',
      });
      res.end(buf);
      return;
    }

    // Where the app itself fetches a newer APK from. The phone asks for this
    // address, downloads the file, reads the version inside it and offers to
    // install it — an update in place, with no uninstall and no lost data.
    if (p === '/api/admin/app-update') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      if (req.method === 'GET') {
        json(res, 200, { url: getSetting('update_url', '') });
        return;
      }
      if (req.method === 'POST') {
        const url = String((await readJson(req))?.url || '').trim();
        if (url && !/^https?:\/\//i.test(url)) {
          json(res, 400, { error: 'give an http or https address to an APK' }); return;
        }
        setSetting('update_url', url);
        audit(admin.userId, admin.name, 'server.update-url', url || 'cleared');
        json(res, 200, { ok: true, url });
        return;
      }
    }

    // Queued update. A browser cannot install an APK, so it can still ask for
    // one: this writes the request where the phone's service is watching, and
    // the service offers the update as a notification. That makes updating work
    // from any screen, not only from inside the app.
    if (p === '/api/admin/app-update/apply' && req.method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      const asked = String((await readJson(req))?.url || '').trim();
      const url = asked || getSetting('update_url', '').trim();
      if (!/^https?:\/\//i.test(url)) {
        json(res, 400, { error: 'give an http or https address to an APK' }); return;
      }
      if (asked) setSetting('update_url', asked);
      try {
        fs.writeFileSync(path.join(DATA_DIR, 'update-request.json'),
          JSON.stringify({ url, at: Date.now(), by: admin.name }));
      } catch (err) {
        json(res, 500, { error: 'could not queue the update: ' + String(err) }); return;
      }
      audit(admin.userId, admin.name, 'server.update-apply', url);
      json(res, 200, { ok: true, queued: true, url });
      return;
    }

    // A real stop and start, without leaving the app to be killed by hand.
    // Exit code 42 is the agreed signal for "come back up": the Android service
    // watches for it and starts the server again straight away. On a desktop the
    // supervisor script does the same; without one, 42 simply ends the process.
    if (p === '/api/admin/power' && req.method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      const action = String((await readJson(req))?.action || '').toLowerCase();
      if (action !== 'restart' && action !== 'stop') {
        json(res, 400, { error: 'say whether to restart or stop' }); return;
      }
      audit(admin.userId, admin.name, 'server.' + action, action === 'restart' ? 'restarting' : 'stopping');
      json(res, 200, { ok: true, action, willExitIn: 250 });
      setTimeout(() => process.exit(action === 'restart' ? 42 : 0), 250);
      return;
    }

    if (p === '/api/admin/hup' && req.method === 'POST') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      // HUP is a reload, not a stop. Settings and module switches are read from
      // the database per request; this pushes the current state to open windows
      // so nobody has to reload their page to see a change.
      sendToStaff({ t: 'modules', modules: modulesState() });
      sendToStaff({ t: 'refresh' });
      audit(admin.userId, admin.name, 'server.hup', 'settings reloaded; every open window refreshed');
      json(res, 200, { ok: true, modules: modulesState(), reloadedAt: now() });
      return;
    }
    /* ---------- admin settings ---------- */

    if (p === '/api/admin/settings') {
      const admin = requireAdmin(req, res);
      if (!admin || admin.kind !== 'operator') return;
      if (req.method === 'GET') {
        json(res, 200, {
          otrAllowed: getSetting('otr_allowed', '1') === '1',
          workHours: workHours(),
          workOpen: workOpen(),
          turnKeyId: getSetting('turn_key_id', ''),
          turnConfigured: turnConfigured(),
          driveQuotaMb: Math.round(driveQuotaBytes() / 1048576),
          driveUsedMb: Math.round(driveUsedBytes(admin.userId) / 1048576 * 10) / 10,
          require2fa: getSetting('require_2fa', '0') === '1',
          messagePolicy: getSetting('message_policy', 'everyone'),
          retentionDays: Number(getSetting('retention_days', '0')) || 0,
          retentionLastRun: Number(getSetting('retention_last_run', '0')) || 0,
          publicUrl: getSetting('public_url', ''),
          linksUse: publicBase(),
          modules: MODULES.map((m) => ({ id: m.id, ...moduleWording(m.id), on: moduleEnabled(m.id) })),
          commands: COMMANDS.map((c) => ({ id: c.id, usage: c.usage, hint: c.hint, on: commandOn(c.id) })),
        });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        if (body?.driveQuotaMb !== undefined) {
          const mb = Math.max(50, Math.min(102400, Number(body.driveQuotaMb) || 1024));
          setSetting('drive_quota_mb', String(Math.round(mb)));
          audit(admin.userId, admin.name, 'settings.update', `drive quota ${Math.round(mb)} MB`);
        }
        if (body?.require2fa !== undefined) {
          setSetting('require_2fa', body.require2fa ? '1' : '0');
          audit(admin.userId, admin.name, 'settings.update',
            'two-factor sign-in ' + (body.require2fa ? 'required' : 'optional'));
          sendToStaff({ t: 'refresh' });
        }
        if (body?.messagePolicy !== undefined) {
          const policy = ['everyone', 'department', 'admins'].includes(String(body.messagePolicy))
            ? String(body.messagePolicy) : 'everyone';
          setSetting('message_policy', policy);
          audit(admin.userId, admin.name, 'settings.update', 'private chat policy: ' + policy);
          sendToStaff({ t: 'refresh' });
        }
        if (body?.retentionDays !== undefined) {
          const days = Math.max(0, Math.min(3650, Math.round(Number(body.retentionDays) || 0)));
          setSetting('retention_days', String(days));
          audit(admin.userId, admin.name, 'settings.update',
            days ? `chat history kept for ${days} days` : 'chat history kept forever');
        }
        if (body?.publicUrl !== undefined) {
          const url = String(body.publicUrl || '').trim().slice(0, 200).replace(/\/+$/, '');
          if (url && !/^https?:\/\/[^\s]+$/i.test(url)) {
            json(res, 400, { error: 'use a full address starting with http:// or https://' }); return;
          }
          setSetting('public_url', url);
          audit(admin.userId, admin.name, 'settings.update', url ? 'public address ' + url : 'public address cleared');
        }
        if (body?.otrAllowed !== undefined) {
          setSetting('otr_allowed', body.otrAllowed ? '1' : '0');
          audit(admin.userId, admin.name, 'settings.update',
            'off-the-record messages ' + (body.otrAllowed ? 'enabled' : 'disabled'));
          sendToStaff({ t: 'refresh' });
        }
        if (body?.turnKeyId !== undefined || body?.turnApiToken !== undefined) {
          if (body.turnKeyId !== undefined) {
            setSetting('turn_key_id', String(body.turnKeyId).trim().slice(0, 200));
          }
          // The token is a secret: written here, never read back to a browser.
          if (body.turnApiToken) {
            setSetting('turn_api_token', String(body.turnApiToken).trim().slice(0, 500));
          }
          turnCache = null;
          audit(admin.userId, admin.name, 'settings.update',
            turnConfigured() ? 'call relay configured' : 'call relay not configured');
        }
        if (body?.workHours && typeof body.workHours === 'object') {
          const w = body.workHours;
          const hm = (v: any) => (/^\d{2}:\d{2}$/.test(String(v || '')) ? String(v) : null);
          if (w.on !== undefined) setSetting('work_hours_on', w.on ? '1' : '0');
          const from = hm(w.from);
          const to = hm(w.to);
          if (from) setSetting('work_hours_from', from);
          if (to) setSetting('work_hours_to', to);
          if (w.days !== undefined) {
            const days = dayList(String(w.days));
            setSetting('work_hours_days', days.join(','));
          }
          if (w.note !== undefined) setSetting('work_hours_note', String(w.note).slice(0, 300));
          const h = workHours();
          audit(admin.userId, admin.name, 'settings.update',
            h.on ? `work hours ${h.from}-${h.to} (days ${h.days || 'none'})` : 'work hours off');
          sendToStaff({ t: 'refresh' });
        }
        if (body?.modules && typeof body.modules === 'object') {
          const next = modulesState();
          for (const m of MODULES) {
            if (body.modules[m.id] !== undefined) next[m.id] = !!body.modules[m.id];
          }
          const off = Object.keys(next).filter((k) => !next[k]);
          setSetting('modules_off', off.join(','));
          audit(admin.userId, admin.name, 'settings.update',
            off.length ? 'unloaded modules: ' + off.join(', ') : 'every module loaded');
          sendToStaff({ t: 'modules', modules: modulesState() });
        }
        if (body?.commands && typeof body.commands === 'object') {
          const next = commandState();
          for (const c of COMMANDS) {
            if (body.commands[c.id] !== undefined) next[c.id] = !!body.commands[c.id];
          }
          const off = Object.keys(next).filter((k) => !next[k]);
          setSetting('irc_off', off.join(','));
          audit(admin.userId, admin.name, 'settings.update',
            off.length ? 'commands switched off: ' + off.join(', ') : 'every command switched on');
        }
        json(res, 200, { ok: true });
        return;
      }
    }

    /* ---------- typed commands (nothing in the app lists these) ---------- */

    if (p === '/api/command' && req.method === 'POST') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const body = await readJson(req);
      const raw = String(body?.text || '').trim();
      const m = raw.match(/^\/([a-z]+)(?:\s+([\s\S]*))?$/i);
      if (!m) { json(res, 404, { error: 'unknown command' }); return; }
      const name = m[1].toLowerCase();
      const rest = (m[2] || '').trim();
      const convId = String(body?.conversationId || '');
      const def = COMMANDS.find((c) => c.id === name);
      if (!def || !commandOn(def.id)) { json(res, 404, { error: 'unknown command' }); return; }
      if (def.adminOnly && !a.admin) { json(res, 403, { error: 'not allowed' }); return; }

      if (def.id === 'nick') {
        const wanted = rest.replace(/\s+/g, ' ').trim().slice(0, 40);
        if (wanted.length < 2) { json(res, 400, { error: 'A name needs at least 2 characters.' }); return; }
        const taken = db.prepare(
          `SELECT id FROM users WHERE display_name=? COLLATE NOCASE AND id<>?`
        ).get(wanted, a.userId) as any;
        if (taken) { json(res, 409, { error: 'Someone already uses that name.' }); return; }
        db.prepare(`UPDATE users SET display_name=? WHERE id=?`).run(wanted, a.userId);
        audit(a.userId, a.name, 'profile.rename', a.name + ' is now ' + wanted);
        sendToStaff({ t: 'refresh' });
        json(res, 200, { ok: true, message: 'You are now ' + wanted + '.', refresh: true });
        return;
      }

      if (def.id === 'join') {
        const title = rest.replace(/\s+/g, ' ').trim().slice(0, 60);
        if (!title) { json(res, 400, { error: 'Which room? Use /join room name.' }); return; }
        let room = db.prepare(
          `SELECT id, title FROM conversations WHERE kind='room' AND visibility<>'members'
              AND space_id=? AND title=? COLLATE NOCASE`
        ).get(businessSpaceId(), title) as any;
        const created = !room;
        if (!room) {
          room = { id: id(), title };
          db.prepare(`INSERT INTO conversations(id, space_id, client_id, kind, title, archived_at, created_at, visibility)
                      VALUES(?,?,NULL,'room',?,NULL,?,'space')`)
            .run(room.id, businessSpaceId(), title, now());
        }
        db.prepare(
          `INSERT INTO participants(conversation_id, participant_type, participant_id, last_read_seq, joined_at)
           VALUES(?,'operator',?,0,?) ON CONFLICT DO NOTHING`
        ).run(room.id, a.userId, now());
        sendToStaff({ t: 'refresh' });
        json(res, 200, {
          ok: true, refresh: true, openConversationId: room.id,
          message: created ? 'Created and opened ' + room.title + '.' : 'Opened ' + room.title + '.',
        });
        return;
      }

      if (def.id === 'list') {
        const rooms = (db.prepare(
          `SELECT title FROM conversations WHERE kind='room' AND visibility<>'members' AND space_id=?
              ORDER BY title COLLATE NOCASE`
        ).all(businessSpaceId()) as any[]).map((r) => r.title || 'Room');
        const groups = (db.prepare(
          `SELECT DISTINCT c.title FROM conversations c
             JOIN participants p ON p.conversation_id=c.id
            WHERE p.participant_type='operator' AND p.participant_id=?
              AND c.kind='room' AND c.visibility='members' ORDER BY c.title COLLATE NOCASE`
        ).all(a.userId) as any[]).map((g) => g.title || 'Group');
                  const roomRows = (db.prepare(
            `SELECT c.id, c.title,
                    (SELECT COUNT(*) FROM participants p WHERE p.conversation_id=c.id) AS members
               FROM conversations c
              WHERE c.kind='room' AND c.visibility<>'members' AND c.space_id=?
              ORDER BY c.title COLLATE NOCASE`
          ).all(businessSpaceId()) as any[]).map((r) => ({
            id: r.id,
            name: r.title || 'Room',
            members: Number(r.members || 0),
          }));
          json(res, 200, {
            ok: true,
            rooms: roomRows,
            message: 'Rooms: ' + (rooms.join(', ') || 'none') + '. Groups: ' + (groups.join(', ') || 'none') + '.',
          });
        return;
      }

      if (def.id === 'msg') {
        const parts = rest.match(/^(\S+)\s+([\s\S]+)$/);
        if (!parts) { json(res, 400, { error: 'Use /msg name message.' }); return; }
        const target = db.prepare(
          `SELECT id, display_name FROM users WHERE disabled=0 AND display_name=? COLLATE NOCASE`
        ).get(parts[1]) as any;
        if (!target) { json(res, 404, { error: 'No one called ' + parts[1] + '.' }); return; }
        if (target.id === a.userId) { json(res, 400, { error: 'That is you.' }); return; }
        const refusal = directChatRefusal(a, target.id);
        if (refusal) { json(res, 403, { error: refusal }); return; }
        const conv = directConversation(a.userId, target.id);
        const { message } = insertMessage(
          conv, { type: 'operator', id: a.userId, name: a.name }, parts[2].slice(0, 4000), null
        );
        sendToConversation(conv.id, { t: 'message', ...message });
        sendToStaff({ t: 'refresh' });
        json(res, 200, {
          ok: true, refresh: true, openConversationId: conv.id,
          message: 'Sent to ' + target.display_name + '.',
        });
        return;
      }

      if (def.id === 'me') {
        if (!rest) { json(res, 400, { error: 'Say what you are doing.' }); return; }
        const conv = convId ? conversationAccess(a, convId) : null;
        if (!conv) { json(res, 400, { error: 'Open a chat first.' }); return; }
        const { message } = insertMessage(
          conv, { type: 'operator', id: a.userId, name: a.name },
          '* ' + a.name + ' ' + rest.slice(0, 400), null
        );
        sendToConversation(conv.id, { t: 'message', ...message });
        json(res, 200, { ok: true, message: '' });
        return;
      }

      if (def.id === 'whois') {
        const u = db.prepare(
          `SELECT u.id, u.display_name, u.email, u.is_operator, u.status, u.status_text, d.name AS department
             FROM users u LEFT JOIN departments d ON d.id = u.department_id
            WHERE u.disabled=0 AND u.display_name=? COLLATE NOCASE`
        ).get(rest) as any;
        if (!u) { json(res, 404, { error: 'No one called ' + rest + '.' }); return; }
        const bits = [u.display_name];
        if (u.department) bits.push(u.department);
        if (Number(u.is_operator) === 1) bits.push('administrator');
        bits.push(isUserOnline(u.id) ? 'online' : 'offline');
        if (u.status_text) bits.push(u.status_text);
        if (a.admin && u.email) bits.push(u.email);
        json(res, 200, { ok: true, message: bits.join(' \u00b7 ') });
        return;
      }

      if (def.id === 'invite') {
        if (!convId) { json(res, 400, { error: 'Open the group first.' }); return; }
        const conv = conversationAccess(a, convId);
        if (!conv) { json(res, 404, { error: 'not found' }); return; }
        if (conv.kind !== 'room' || conv.visibility !== 'members') {
          json(res, 400, { error: 'Invites work in groups only.' }); return;
        }
        const person = db.prepare(
          `SELECT id, display_name FROM users WHERE disabled=0 AND display_name=? COLLATE NOCASE`
        ).get(rest) as any;
        if (!person) { json(res, 404, { error: 'No one called ' + rest + '.' }); return; }
        db.prepare(
          `INSERT INTO participants(conversation_id, participant_type, participant_id, last_read_seq, joined_at)
           VALUES(?,'operator',?,0,?) ON CONFLICT DO NOTHING`
        ).run(conv.id, person.id, now());
        sendToStaff({ t: 'refresh' });
        json(res, 200, { ok: true, refresh: true, message: person.display_name + ' was added.' });
        return;
      }

      if (def.id === 'topic') {
        if (!convId) { json(res, 400, { error: 'Open the room first.' }); return; }
        const conv = conversationAccess(a, convId);
        if (!conv || conv.kind !== 'room' || conv.visibility === 'members') {
          json(res, 400, { error: 'That works in shared rooms only.' }); return;
        }
        const title = rest.replace(/\s+/g, ' ').trim().slice(0, 60);
        if (!title) { json(res, 400, { error: 'Give the room a new name.' }); return; }
        db.prepare(`UPDATE conversations SET title=? WHERE id=?`).run(title, conv.id);
        audit(a.userId, a.name, 'room.rename', (conv.title || 'room') + ' \u2192 ' + title);
        sendToStaff({ t: 'refresh' });
        json(res, 200, { ok: true, refresh: true, message: 'Room renamed to ' + title + '.' });
        return;
      }

      if (def.id === 'part') {
        if (!convId) { json(res, 400, { error: 'Open the group first.' }); return; }
        const conv = conversationAccess(a, convId);
        if (!conv) { json(res, 404, { error: 'not found' }); return; }
        if (conv.visibility !== 'members') {
          json(res, 400, { error: 'Shared rooms stay open; close the chat instead.' }); return;
        }
        db.prepare(
          `DELETE FROM participants WHERE conversation_id=? AND participant_type='operator' AND participant_id=?`
        ).run(conv.id, a.userId);
        sendToStaff({ t: 'refresh' });
        json(res, 200, { ok: true, refresh: true, message: 'You left the group.' });
        return;
      }

      if (def.id === 'help') {
        const lines = COMMANDS.filter((c) => commandOn(c.id) && (!c.adminOnly || a.admin)).map((c) => c.usage);
        json(res, 200, { ok: true, message: lines.join('  \u00b7  ') });
        return;
      }

      json(res, 404, { error: 'unknown command' });
      return;
    }

    /* ---------- search ---------- */

    if (p === '/api/search') {
      const a = requireUser(req, res);
      if (!a || a.kind !== 'operator') return;
      const q = String(url.searchParams.get('q') || '').trim();
      const from = Number(url.searchParams.get('from') || 0);
      const to = Number(url.searchParams.get('to') || 0);
      const clientId = String(url.searchParams.get('clientId') || '');
      const spaceId = businessSpaceId();

      const clauses = [`m.space_id = ?`, `m.deleted_at IS NULL`];
      const params: any[] = [spaceId];
      // Nobody searches their way into a private chat they are not part of.
      if (!a.admin) {
        clauses.push(
          `(c.client_id IS NOT NULL OR (c.kind='room' AND c.visibility<>'members')
            OR EXISTS (SELECT 1 FROM participants p WHERE p.conversation_id=c.id
                        AND p.participant_type='operator' AND p.participant_id=?))`
        );
        params.push(a.userId);
      }
      if (q) { clauses.push(`lower(m.body) LIKE ?`); params.push('%' + q.toLowerCase() + '%'); }
      if (from) { clauses.push(`m.created_at >= ?`); params.push(from); }
      if (to) { clauses.push(`m.created_at <= ?`); params.push(to); }
      if (clientId) { clauses.push(`c.client_id = ?`); params.push(clientId); }

      const rows = db.prepare(
        `SELECT m.id, m.conversation_id, m.seq, m.sender_name, m.body, m.created_at, c.client_id,
                cl.display_name AS client_name, c.title,
                (SELECT GROUP_CONCAT(u.display_name, ', ') FROM participants p
                   JOIN users u ON u.id = p.participant_id
                  WHERE p.conversation_id = c.id AND p.participant_type='operator') AS people
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
           LEFT JOIN clients cl ON cl.id = c.client_id
          WHERE ${clauses.join(' AND ')}
          ORDER BY m.created_at DESC LIMIT 100`
      ).all(...params) as any[];

      // Private notes are included in search, as the brief asks.
      const noteRows = db.prepare(
        `SELECT n.client_id, n.body, n.updated_at, cl.display_name AS client_name
           FROM notes n LEFT JOIN clients cl ON cl.id = n.client_id
          WHERE n.space_id = ? AND lower(n.body) LIKE ? LIMIT 50`
      ).all(spaceId, '%' + q.toLowerCase() + '%') as any[];

      json(res, 200, {
        messages: rows.map((r) => ({
          id: r.id, conversationId: r.conversation_id, clientId: r.client_id,
          clientName: r.client_name,
          where: r.client_name || r.title || r.people || 'Conversation',
          senderName: r.sender_name, body: r.body, createdAt: r.created_at,
        })),
        notes: noteRows.map((r) => ({ clientId: r.client_id, clientName: r.client_name, body: r.body })),
      });
      return;
    }

    /* ---------- transcript ---------- */

    if ((m = p.match(/^\/api\/conversations\/([^/]+)\/transcript$/)) && req.method === 'POST') {
      const a = resolveAuth(req);
      const conv = conversationAccess(a, m[1]);
      if (!conv) { json(res, 401, { error: 'unauthorized' }); return; }
      const client = db.prepare(`SELECT * FROM clients WHERE id=?`).get(conv.client_id) as any;
      if (!client) { json(res, 404, { error: 'not found' }); return; }

      const rows = db.prepare(
        `SELECT sender_name, body, created_at, kind FROM messages
          WHERE conversation_id=? AND deleted_at IS NULL ORDER BY seq`
      ).all(conv.id) as any[];
      const lines = rows.map((r) =>
        `[${new Date(r.created_at).toISOString()}] ${r.sender_name}: ${r.kind === 'file' ? '[attachment] ' : ''}${r.body}`
      );
      const text = `Conversation transcript\nClient: ${client.display_name || 'Client'}\n\n` + lines.join('\n');

      if (client.email) {
        await sendMail(client.email, 'Your conversation transcript', text);
        json(res, 200, { ok: true, emailed: true });
      } else {
        json(res, 200, { ok: true, emailed: false, transcript: text });
      }
      return;
    }

    /* ---------- attachments list (Images tab) ---------- */

    if ((m = p.match(/^\/api\/conversations\/([^/]+)\/attachments$/)) && req.method === 'GET') {
      const a = resolveAuth(req);
      const conv = conversationAccess(a, m[1]);
      if (!conv) { json(res, 401, { error: 'unauthorized' }); return; }
      const rows = db.prepare(
        `SELECT a.id, a.filename, a.mime, a.bytes, a.created_at FROM attachments a
          JOIN messages m ON m.id = a.message_id
         WHERE m.conversation_id = ? ORDER BY a.created_at DESC LIMIT 200`
      ).all(conv.id) as any[];
      json(res, 200, rows.map((r) => ({ ...r, url: signedFileUrl(r.id) })));
      return;
    }

    /* ---------- fallback static ---------- */

    if (serveStatic(res, p.replace(/^\/+/, '') || 'index.html')) return;

    json(res, 404, { error: 'not found' });
  } catch (err: any) {
    console.error('[http]', err?.message || err);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
};
/* The same handlers serve TLS when a certificate is present, so a name typed
   into a phone browser works on the port directly, with no tunnel in front. */
function loadTls(): { cert: Buffer; key: Buffer } | null {
  try {
    const base = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'certs', 'certificates');
    // No name of anybody's is baked in here: an install serves TLS only when the
    // operator has supplied a name and a certificate for it.
    const names = [process.env.TLS_NAME || '', getSetting('tls_name', '').trim()]
      .map((n) => n.trim())
      .filter((n, i, all) => n && all.indexOf(n) === i);
    for (const n of names) {
      const certFile = process.env.TLS_CERT || path.join(base, n + '.crt');
      const keyFile = process.env.TLS_KEY || path.join(base, n + '.key');
      if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
        return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
      }
    }
    return null;
  } catch { return null; }
}

const TLS_PAIR = loadTls();
const plainServer = http.createServer(handleRequest);
const server: http.Server | https.Server = TLS_PAIR
  ? https.createServer(TLS_PAIR, handleRequest)
  : plainServer;
if (TLS_PAIR) console.log('  TLS on: serving HTTPS with the certificate for ' + (process.env.TLS_NAME || getSetting('tls_name', '').trim()));
function sendToConversationAll(payload: any): void {
  for (const s of sockets) {
    if (s.ws.readyState === WebSocket.OPEN && s.auth) s.ws.send(JSON.stringify(payload));
  }
}

/* A task or meeting nudges the people involved, once. */
setInterval(() => {
  try {
    const dueTasks = db.prepare(
      `SELECT t.*, a.display_name AS assignee_name FROM tasks t
         LEFT JOIN users a ON a.id=t.assignee_id
        WHERE t.done_at IS NULL AND t.notified_at IS NULL AND t.due_at IS NOT NULL AND t.due_at<=?
          AND t.assignee_id IS NOT NULL LIMIT 50`
    ).all(now()) as any[];
    for (const t of dueTasks) {
      db.prepare(`UPDATE tasks SET notified_at=? WHERE id=?`).run(now(), t.id);
      sendToUserId(t.assignee_id, { t: 'task:due', taskId: t.id, title: t.title, dueAt: t.due_at });
    }

    const soon = db.prepare(
      `SELECT * FROM events WHERE cancelled_at IS NULL AND reminded_at IS NULL
          AND starts_at>? AND starts_at<=? LIMIT 50`
    ).all(now(), now() + 15 * 60000) as any[];
    for (const e of soon) {
      db.prepare(`UPDATE events SET reminded_at=? WHERE id=?`).run(now(), e.id);
      for (const att of eventAttendees(e.id)) {
        if (att.status === 'declined') continue;
        sendToUserId(att.userId, { t: 'event:soon', event: eventPayload(e, att.userId) });
      }
    }
  } catch (err: any) {
    console.error('[work nudges]', err?.message || err);
  }
}, 30000);

/* Reminders fire once when they come due, on every device the owner has open. */
setInterval(() => {
  try {
    const due = db.prepare(
      `SELECT * FROM reminders WHERE done=0 AND notified_at IS NULL AND due_at<=? LIMIT 50`
    ).all(now()) as any[];
    for (const r of due) {
      db.prepare(`UPDATE reminders SET notified_at=? WHERE id=?`).run(now(), r.id);
      sendToUserId(r.user_id, {
        t: 'reminder', id: r.id, body: r.body, dueAt: r.due_at,
        conversationId: r.conversation_id, messageId: r.message_id,
      });
    }
  } catch (err: any) {
    console.error('[reminders]', err?.message || err);
  }
}, 20000);

/* ------------------------------------------------------------------ */
/* websocket                                                           */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ server: server as any, path: '/ws' });

/* Plain HTTP on loopback so typing http://localhost keeps working while the
   public port speaks TLS. Loopback only: nothing outside this computer can
   reach it, and chat sockets are handed to the same websocket server. */
if (TLS_PAIR) {
  const localPort = Number(process.env.LOCAL_HTTP_PORT) > 0 ? Number(process.env.LOCAL_HTTP_PORT) : 3000;
  {
    const localServer = http.createServer(handleRequest);
    localServer.on('upgrade', (req: any, socket: any, head: any) => {
      if ((req.url || '').split('?')[0] === '/ws') {
        wss.handleUpgrade(req, socket, head, (ws: any) => wss.emit('connection', ws, req));
      } else { socket.destroy(); }
    });
    localServer.on('error', () => { /* port taken elsewhere; the TLS port still works */ });
    localServer.listen(localPort, '127.0.0.1', () => console.log('  Local HTTP: http://localhost:' + localPort));
  }
}


wss.on('connection', (ws, req) => {
  const auth = resolveAuth(req);
  if (!auth) { ws.close(1008, 'unauthorized'); return; }

  const entry = { ws, auth };
  sockets.add(entry);
  const key = onlineKey(auth);
  const wasOffline = (presence.get(key) || 0) === 0;
  presence.set(key, (presence.get(key) || 0) + 1);
  // Work hours follow presence: the clock starts on the first device, stops on the last.
  if (wasOffline && auth.kind === 'operator') {
    try { openWorkSession(auth.userId); } catch (err: any) { console.error('[hours]', err?.message || err); }
  }

  ws.send(JSON.stringify({ t: 'hello', kind: auth.kind, online: true }));

  if (auth.kind === 'client') {
    const conv = conversationForClient(auth.clientId);
    if (conv) {
      const opStatus = getSetting('op_status', 'Online');
      ws.send(JSON.stringify({ t: 'operator_status', status: opStatus, message: getSetting('op_status_message', '') }));
    }
    sendToOperatorAll({ t: 'presence', clientId: auth.clientId, online: true });
  } else {
    db.prepare(`UPDATE users SET last_seen=? WHERE id=?`).run(now(), auth.userId);
    const me = db.prepare(`SELECT status, status_text FROM users WHERE id=?`).get(auth.userId) as any;
    sendToStaff({
      t: 'presence',
      userId: auth.userId,
      online: true,
      status: me?.status || 'Online',
      statusText: me?.status_text || '',
    });
  }

  ws.on('message', (raw) => {
    let msg: any;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'ping') { ws.send(JSON.stringify({ t: 'pong' })); return; }

    if (msg.t === 'read' && msg.conversationId) {
      const conv = conversationAccess(auth, String(msg.conversationId));
      if (!conv) return;
      const sender = senderFrom(auth);
      if (!sender) return;
      const seq = Number(msg.seq || 0);
      db.prepare(
        `UPDATE participants SET last_read_seq=MAX(last_read_seq, ?)
          WHERE conversation_id=? AND participant_type=? AND participant_id=?`
      ).run(seq, conv.id, sender.type, sender.id);
      sendToConversation(conv.id, { t: 'read', conversationId: conv.id, seq, by: sender.type, userId: sender.id, name: sender.name });
      return;
    }
  });

  ws.on('close', () => {
    sockets.delete(entry);
    const n = (presence.get(key) || 1) - 1;
    if (n <= 0) presence.delete(key); else presence.set(key, n);
    if (auth.kind === 'client') {
      sendToOperatorAll({ t: 'presence', clientId: auth.clientId, online: n > 0 });
    } else {
      db.prepare(`UPDATE users SET last_seen=? WHERE id=?`).run(now(), auth.userId);
      if (n <= 0) {
        try { closeWorkSession(auth.userId); } catch (err: any) { console.error('[hours]', err?.message || err); }
        sendToStaff({ t: 'presence', userId: auth.userId, online: false, status: 'Offline' });
      }
    }
  });
});

function sendToOperatorAll(payload: any): void {
  for (const s of sockets) {
    if (s.ws.readyState === WebSocket.OPEN && s.auth?.kind === 'operator') {
      s.ws.send(JSON.stringify(payload));
    }
  }
}

/* ------------------------------------------------------------------ */


/* After a crash or a restart, close shifts that never got a proper sign-off.
   The user's last-seen time is the best estimate of when they actually left. */
function closeStaleWorkSessions(): void {
  const open = db.prepare(
    `SELECT w.id, w.started_at, u.last_seen FROM work_sessions w JOIN users u ON u.id=w.user_id
      WHERE w.ended_at IS NULL`
  ).all() as any[];
  for (const row of open) {
    const end = Math.max(Number(row.started_at), Number(row.last_seen || 0), Number(row.started_at) + 60000);
    db.prepare(`UPDATE work_sessions SET ended_at=? WHERE id=?`).run(Math.min(end, now()), row.id);
  }
}
closeStaleWorkSessions();
ensureTickets();
// Old chat is swept shortly after boot, then every six hours.
setTimeout(() => { try { runRetention(); } catch { /* the log already has it */ } }, 60 * 1000);
setInterval(() => { try { runRetention(); } catch { /* keep serving */ } }, 6 * 60 * 60 * 1000);

function listenOn(port: number): Promise<void> {
  // Refuse a port this machine will never grant, before the socket says EACCES
  // and leaves the operator guessing.
  const problem = portProblem(port);
  if (problem) {
    console.error('  ' + problem);
    process.exit(1);
  }
  return new Promise((resolve, reject) => {
    const srv: any = server;
    const onError = (err: any) => { srv.off('listening', onListening); reject(err); };
    const onListening = () => { srv.off('error', onError); resolve(); };
    srv.once('error', onError);
    srv.once('listening', onListening);
    srv.listen(port, '0.0.0.0');
  });
}

/**
 * A VPN's forwarded port is the only number the outside world can dial, so when
 * a tunnel is up ask it which port it forwards to this machine and listen there.
 * No VPN, or a VPN that does not forward: stay on the normal port.
 */
/* ------------------------------------------------------------------ */
/* dynamic DNS: keep a name pointing at whatever address we end up on   */
/* ------------------------------------------------------------------ */

let PUBLIC_IP = '';
let ddnsCache: { ip: string; at: number } | null = null;

/** Our best idea of the public address: the VPN's own answer first. */
async function publicIPv4(): Promise<string> {
  const forced = String(process.env.DDNS_IP || '').trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(forced)) return forced;
  if (PUBLIC_IP) return PUBLIC_IP;
  if (ddnsCache && now() - ddnsCache.at < 60000) return ddnsCache.ip;
  const probes = ['https://api.ipify.org', 'https://icanhazip.com', 'https://ifconfig.me/ip'];
  for (const url of probes) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) continue;
      const ip = (await r.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        ddnsCache = { ip, at: now() };
        return ip;
      }
    } catch { /* try the next one */ }
  }
  return '';
}

/** The origin links should use when a dynamic name is configured. */
function ddnsLink(): string {
  const host = getSetting('ddns_host', '').trim();
  if (!host) return '';
  return 'http://' + host + (PORT === 80 ? '' : ':' + PORT);
}

/** Send one update, but only when the address moved (unless forced). */
async function ddnsUpdate(force = false): Promise<{ ok: boolean; detail: string; ip: string }> {
  const host = getSetting('ddns_host', '').trim();
  const mode = getSetting('ddns_mode', 'off');
  if (!host || mode === 'off') return { ok: false, detail: 'dynamic DNS is off', ip: '' };
  // Prefer the address the tunnel actually exposes. The household address must
  // not be published, and it is the VPN entry point that reaches this server.
  const ip = PUBLIC_IP || (MAPPING && MAPPING.publicIp) || (await publicIPv4());
  if (!ip) return { ok: false, detail: 'could not work out the public address', ip: '' };
  const settled = ip === getSetting('ddns_last_ip', '') && getSetting('ddns_result', '') === 'ok';
  if (!force && settled) return { ok: true, detail: 'unchanged', ip };

  const user = getSetting('ddns_user', '');
  const pass = String(process.env.DDNS_PASSWORD || getSetting('ddns_pass', ''));
  const headers: Record<string, string> = { 'User-Agent': 'PeachMessenger/1.0' };
  if (user) headers.Authorization = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');

  let url = '';
  if (mode === 'duckdns') {
    url = 'https://www.duckdns.org/update?domains=' + encodeURIComponent(host.split('.')[0])
      + '&token=' + encodeURIComponent(pass) + '&ip=' + encodeURIComponent(ip);
  } else if (mode === 'custom') {
    url = getSetting('ddns_url', '')
      .replace('{host}', encodeURIComponent(host))
      .replace('{ip}', encodeURIComponent(ip));
    if (!url) return { ok: false, detail: 'no update address set', ip };
  } else {
    const base = (getSetting('ddns_url', '').trim() || 'https://dynupdate.no-ip.com').replace(/\/+$/, '');
    url = base + '/nic/update?hostname=' + encodeURIComponent(host) + '&myip=' + encodeURIComponent(ip);
  }

  let detail = '';
  let ok = false;
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    const text = (await r.text()).trim().slice(0, 200);
    ok = r.ok && !/^(badauth|nohost|notfqdn|abuse|badagent|dnserr|!donator|KO)/i.test(text);
    detail = r.status + ' ' + text;
  } catch (err: any) {
    detail = String((err && err.message) || err).slice(0, 200);
  }
  setSetting('ddns_last_at', String(now()));
  setSetting('ddns_result', ok ? 'ok' : 'failed');
  setSetting('ddns_detail', detail);
  if (ok) setSetting('ddns_last_ip', ip);
  console.log('  Dynamic DNS: ' + host + ' -> ' + ip + ' (' + detail + ')');
  return { ok, detail, ip };
}

async function choosePort(): Promise<void> {
  if (Number(process.env.PORT) > 0) return; // an explicit PORT always wins
  if (publicPath() === 'manual') {
    console.log('  Public path is manual: keeping port ' + PORT + ' and leaving the VPN alone.');
    return;
  }
  const manual = Number(getSetting('manual_port', '0')) || 0;
  if (manual > 0) {
    PORT = manual;
    console.log(`  Port set by hand in the panel: ${PORT}.`);
    return;
  }
  // Only look for a tunnel when somebody has deliberately chosen that path.
  if (publicPath() !== 'vpn') return;

  const vpn = await detectVpn();
  if (!vpn.addresses.length) return;

  console.log('');
  console.log('  VPN detected: ' + vpn.addresses.map((a) => a.address + ' (' + a.name + ')').join(', '));
  const fwd = await vpnForwardedPort(PORT);
  if (!fwd.ok || !fwd.port) {
    console.log(`  No VPN port offered (${fwd.error}); staying on ${PORT}.`);
    return;
  }
  PORT = fwd.port;
  VPN_MAPPING = { gateway: fwd.gateway as string, external: fwd.externalPort as number };
  const fwdScheme = TLS_PAIR ? 'https' : 'http';
  BASE_URL = `${fwdScheme}://${fwd.publicIp || lanAddresses()[0] || 'localhost'}:${fwd.externalPort}`;
  PUBLIC_IP = fwd.publicIp || '';
  console.log(`  ProtonVPN forwards port ${fwd.externalPort} ${fwd.udp ? '(TCP and UDP)' : '(TCP)'}`
    + ` to this computer${fwd.publicIp ? ` (public address ${fwd.publicIp})` : ''}; listening on ${PORT}.`);
  const storedLink = getSetting('public_url', '');
  const liveLink = withLivePort(storedLink);
  if (storedLink && liveLink !== storedLink) {
    console.log(`  Saved link had an old port, following this session instead: ${liveLink}`);
  }
}

/**
 * Re-do the public path while the server keeps running.
 *
 * This is the "network HUP": release whatever was asked for before, ask again
 * under the current choice, refresh the address and the dynamic DNS. It cannot
 * move the listening port — the listener and the websocket server attached to
 * it are bound at boot — so a port change is reported as needing a restart
 * rather than silently ignored.
 */
async function applyNetworkNow(): Promise<{
  ok: boolean;
  path: PublicPath;
  port: number;
  needsRestart: boolean;
  message: string;
  details: string[];
}> {
  const path = publicPath();
  const details: string[] = [];

  // Give back whatever we previously held, so switching does not leave a rule
  // forwarding from the home line after the choice was abandoned.
  if (MAPPING && MAPPING.method === 'upnp') {
    const removed = await removeUpnpMapping(MAPPING.externalPort || PORT);
    details.push('router rule ' + (MAPPING.externalPort || PORT) + (removed ? ' released' : ' could not be released'));
  }
  MAPPING = null;
  MAPPED_URL = '';
  VPN_MAPPING = null;

  if (path === 'vpn') {
    const fwd = await vpnForwardedPort(PORT);
    if (!fwd.ok || !fwd.port) {
      MAPPING = { ok: false, method: null, error: fwd.error || 'no VPN port offered' };
      details.push('the VPN did not offer a port' + (fwd.error ? ' (' + fwd.error + ')' : ''));
      return { ok: false, path, port: PORT, needsRestart: false, message: 'The VPN did not offer a port just now.', details };
    }
    if (fwd.port !== PORT) {
      details.push('the VPN now hands out port ' + fwd.port + ', this server is on ' + PORT);
      return {
        ok: true, path, port: PORT, needsRestart: true,
        message: 'The VPN now hands out port ' + fwd.port + '; a restart is needed to move to it.',
        details,
      };
    }
    VPN_MAPPING = { gateway: fwd.gateway as string, external: fwd.externalPort as number };
    PUBLIC_IP = fwd.publicIp || PUBLIC_IP;
    MAPPING = {
      ok: true, method: 'natpmp',
      externalPort: fwd.externalPort,
      publicIp: fwd.publicIp,
      publicUrl: publicBase(),
    };
    details.push('the VPN carries port ' + fwd.externalPort + (fwd.publicIp ? ' as ' + fwd.publicIp : ''));
  } else if (path === 'upnp') {
    const mapped = await openPort(PORT);
    MAPPING = mapped;
    if (mapped.ok) {
      MAPPED_URL = mapped.publicUrl || '';
      PUBLIC_IP = mapped.publicIp || PUBLIC_IP;
      details.push('router forwarded port ' + (mapped.externalPort || PORT) + (mapped.publicIp ? ' as ' + mapped.publicIp : ''));
    } else {
      details.push('the router refused: ' + (mapped.error || 'no answer'));
    }
  } else {
    MAPPING = { ok: false, method: null, error: 'manual routing: this server does not ask the VPN or the router' };
    details.push('nothing forwarded; port ' + PORT + ' is yours to forward');
  }

  const ddns = await ddnsUpdate(true).catch(() => null);
  if (ddns && ddns.ip) details.push('dynamic DNS ' + ddns.ip + ' (' + ddns.detail + ')');
  sendToStaff({ t: 'refresh' });

  const summary = path === 'vpn' ? 'VPN tunnel' : path === 'upnp' ? 'UPnP' : 'Manual forwarding';
  return { ok: true, path, port: PORT, needsRestart: false, message: summary + ' applied.', details };
}

async function boot(): Promise<void> {
  await choosePort();
  try {
    await listenOn(PORT);
  } catch (err: any) {
    console.log(`  Could not listen on ${PORT} (${err?.code || err?.message}); falling back to 3000.`);
    PORT = 3000;
    await listenOn(3000);
  }

  console.log('');
  console.log('  Messenger is listening on:');
  const listenScheme = TLS_PAIR ? 'https' : 'http';
  console.log(`    ${listenScheme}://localhost:${PORT}          (this computer)`);
  for (const ip of lanAddresses()) {
    console.log(`    ${listenScheme}://${ip}:${PORT}${' '.repeat(Math.max(1, 18 - ip.length))}(same Wi-Fi / LAN)`);
  }
  console.log('');
  console.log(`  Data directory: ${DATA_DIR}`);
  console.log(`  Running on: ${platformLabel}`);
  if (onAndroid) console.log('  ' + platformNote());
  if (!process.env.SESSION_SECRET) {
    console.log('  SESSION_SECRET not set: sessions will not survive a restart.');
  }

  // ProtonVPN hands out 60-second leases, so renew well before it lapses.
  if (VPN_MAPPING) {
    setInterval(() => {
      // Read it each tick: a network HUP can replace the mapping while running.
      const mapping = VPN_MAPPING;
      if (!mapping) return;
      void renewVpnMapping(mapping.gateway, PORT).then((r) => {
        if (!r.ok) { console.log('  VPN port renewal failed: ' + r.error); return; }
        if (r.externalPort !== mapping.external) {
          console.log(`  VPN port moved to ${r.externalPort}; restart to follow it.`);
        }
      });
    }, 45 * 1000);
  }

  void setupPortMapping();

  // Dynamic DNS: check shortly after start, then every five minutes.
  setTimeout(() => { void ddnsUpdate(false); }, 8000);
  setInterval(() => { void ddnsUpdate(false); }, 5 * 60 * 1000);
}

void boot();

/**
 * Ask the router to forward this port, so links work from outside the network.
 * Refresh the lease in the background; routers usually allow 1 hour at a time.
 */
/** How this server is reached from outside: VPN tunnel, home router, or by hand. */
type PublicPath = 'vpn' | 'upnp' | 'manual';
function publicPath(): PublicPath {
  // A distributed install has exactly one public path: the customer's own router,
  // asked over UPnP/NAT-PMP. A tunnel is a personal arrangement, never a default.
  const value = String(getSetting('public_path', 'upnp')).toLowerCase();
  return value === 'upnp' || value === 'manual' ? value : 'vpn';
}

async function setupPortMapping(): Promise<void> {
  if (String(process.env.PORTMAP || 'on').toLowerCase() === 'off') {
    MAPPED_URL = process.env.PUBLIC_URL || process.env.BASE_URL || '';
    console.log('');
    console.log(`  Client links use: ${publicBase()}`);
    console.log('');
    return;
  }

  const vpn = await detectVpn();
  if (vpn.addresses.length) {
    console.log('');
    console.log('  VPN detected: ' + vpn.addresses.map((a) => a.address + ' (' + a.name + ')').join(', '));
    if (vpn.ports.length) console.log('  VPN port listening: ' + vpn.ports.join(', '));
  }

  const path = publicPath();
  if (path === 'manual') {
    MAPPING = { ok: false, method: null, error: 'manual routing: this server does not ask the VPN or the router' };
    console.log('  Public path is manual: nothing is forwarded automatically.');
    console.log('  Forward port ' + PORT + ' to this computer yourself.');
    console.log(`  Client links use: ${publicBase()}`);
    console.log('');
    return;
  }

  // With a VPN forwarding a port, the tunnel is the public path. Forwarding on
  // the home router as well would publish the household's own address, so that
  // only happens when the panel is explicitly set to UPnP.
  const upnpWanted = path === 'upnp' || String(process.env.ALLOW_UPNP || '').toLowerCase() === 'on';
  if (vpn.addresses.length && !upnpWanted) {
    MAPPING = VPN_MAPPING
      ? {
          ok: true,
          method: 'natpmp',
          externalPort: VPN_MAPPING.external,
          publicIp: PUBLIC_IP || undefined,
          publicUrl: publicBase(),
        }
      : { ok: false, method: null, error: 'no VPN port offered; the home router was left untouched on purpose' };
    console.log('  The VPN carries the public path, so the home router is left untouched.');
    console.log('  (Administration → Reaching this server from outside can ask for UPnP instead.)');
    console.log(`  Client links use: ${publicBase()}`);
    console.log('');
    return;
  }

  console.log('');
  console.log('  Asking the router for a public address…');
  const attempt = async (first: boolean) => {
    MAPPING = await openPort(PORT);
    if (MAPPING.ok) {
      MAPPED_URL = MAPPING.publicUrl || '';
      PUBLIC_IP = MAPPING.publicIp || PUBLIC_IP;
      console.log(`  Router accepted the mapping (${MAPPING.method}).`);
      if (MAPPED_URL) {
        console.log(`  Public address: ${MAPPED_URL}`);
        console.log(`  Client links use: ${MAPPED_URL}`);
      } else {
        console.log('  Mapping is in place, but the router did not report a public IP.');
        console.log('  Set PUBLIC_URL to your hostname so links are shareable.');
      }
    } else if (first) {
      console.log('  No automatic port mapping available.');
      if (MAPPING.error) console.log(`  (${MAPPING.error})`);
      console.log('  Links stay on the LAN address. Some ISPs use CGNAT, where');
      console.log('  forwarding cannot work and a tunnel is the only route.');
    }
    console.log(`  Client links use: ${publicBase()}`);
    console.log('');
  };

  await attempt(true);

  // No router mapping? A VPN address is the other way in — links then only work
  // for people already on that VPN.
  if (!MAPPING?.ok && vpn.addresses.length && !VPN_MAPPING) {
    MAPPED_URL = `http://${vpn.addresses[0].address}:${PORT}`;
    console.log('  Using the VPN address for links: ' + MAPPED_URL);
    console.log('  Only devices connected to that VPN can open them.');
    console.log('');
  }

  // Keep asking, whether or not it worked the first time.
  //
  // At phone start-up the Wi-Fi is often not associated yet, so the first
  // attempt fails — and this used to be the only attempt, which meant the
  // server stayed unreachable until somebody restarted the app by hand.
  // The same applies when the router reboots, or when the phone's address
  // changes: the rule then points at an address nobody is using.
  const OK_DELAY = 20 * 60 * 1000;
  const RETRY_DELAY = 30 * 1000;
  const keepAlive = async () => {
    try {
      await attempt(false);
    } catch { /* a failure is the signal to try again sooner */ }
    setTimeout(() => { void keepAlive(); }, MAPPING?.ok ? OK_DELAY : RETRY_DELAY);
  };
  setTimeout(() => { void keepAlive(); }, MAPPING?.ok ? OK_DELAY : RETRY_DELAY);
}
