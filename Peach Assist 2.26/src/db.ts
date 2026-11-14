import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { id, now, sha256, scryptHash } from './util.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

/**
 * Schema follows the brief, with space_id on every table that a client can query.
 * SQLite stands in for Postgres; column names and semantics are unchanged.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('business','social')),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'operator',
  is_operator INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  display_name TEXT,
  email TEXT,
  link_token_hash TEXT NOT NULL UNIQUE,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  client_id TEXT REFERENCES clients(id),
  kind TEXT NOT NULL CHECK(kind IN ('direct','room')),
  title TEXT,
  archived_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  participant_type TEXT NOT NULL CHECK(participant_type IN ('operator','client','member')),
  participant_id TEXT NOT NULL,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, participant_type, participant_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  seq INTEGER NOT NULL,
  sender_type TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  body TEXT NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,
  client_msg_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(conversation_id, seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_client_msg
  ON messages(conversation_id, sender_id, client_msg_id)
  WHERE client_msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_messages_conv_seq ON messages(conversation_id, seq);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  storage_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS room_guests (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  name TEXT NOT NULL,
  joined_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS canned (
  id TEXT PRIMARY KEY,
  shortcut TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suppression (
  email TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  user_name TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
`);

/* ---- Seed: one business space, always on ---- */

export function seed(): { spaceId: string; operatorId: string; generatedPassword?: string } {
  let space = db.prepare(`SELECT id FROM spaces WHERE type='business' LIMIT 1`).get() as any;
  if (!space) {
    space = { id: id() };
    db.prepare(`INSERT INTO spaces(id, type, name, created_at) VALUES(?, 'business', 'Business', ?)`)
      .run(space.id, now());
  }

  let op = db.prepare(`SELECT id FROM users WHERE is_operator=1 LIMIT 1`).get() as any;
  let generatedPassword: string | undefined;
  if (!op) {
    const password = process.env.OP_PASSWORD || require('node:crypto').randomBytes(12).toString('base64url');
    if (!process.env.OP_PASSWORD) generatedPassword = password;
    op = { id: id() };
    db.prepare(`INSERT INTO users(id, email, display_name, password_hash, role, is_operator, created_at)
                VALUES(?, ?, ?, ?, 'admin', 1, ?)`)
      .run(op.id, process.env.OP_EMAIL || 'operator@localhost', 'Admin', scryptHash(password), now());
  }

  const cannedCount = db.prepare(`SELECT COUNT(*) AS c FROM canned`).get() as any;
  if (!cannedCount.c) {
    const defaults: [string, string][] = [
      ['/hi', 'Hi! Thanks for reaching out — how can I help?'],
      ['/thanks', 'Thanks for that, I will take a look and get back to you shortly.'],
      ['/sent', 'Just sent that over — let me know if it arrives and reads correctly.'],
      ['/bye', 'Thanks for your time. I will keep this thread here if anything else comes up.'],
    ];
    for (const [shortcut, body] of defaults) {
      db.prepare(`INSERT INTO canned(id, shortcut, body) VALUES(?,?,?)`).run(id(), shortcut, body);
    }
  }

  return { spaceId: space.id, operatorId: op.id, generatedPassword };
}

export function businessSpaceId(): string {
  const row = db.prepare(`SELECT id FROM spaces WHERE type='business' LIMIT 1`).get() as any;
  return row.id;
}

/* ---- additive migrations (safe to re-run) ---- */
function addColumn(table: string, column: string, decl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

addColumn('clients', 'status_text', "TEXT NOT NULL DEFAULT 'Offline'");
addColumn('messages', 'kind', "TEXT NOT NULL DEFAULT 'text'");

// Team accounts: a username to sign in with, a department, a presence state and
// the custom status line that goes with it.
addColumn('users', 'username', 'TEXT');
addColumn('users', 'status', "TEXT NOT NULL DEFAULT 'Offline'");
addColumn('users', 'status_text', "TEXT NOT NULL DEFAULT ''");
addColumn('users', 'department_id', 'TEXT');
addColumn('users', 'disabled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'last_seen', 'INTEGER NOT NULL DEFAULT 0');
// A room is either an open room anyone with the link can join, or a group with
// a fixed member list.
addColumn('conversations', 'visibility', "TEXT NOT NULL DEFAULT 'open'");
// The team-wide Announcements thread accepts posts from administrators only.
addColumn('conversations', 'announce_only', 'INTEGER NOT NULL DEFAULT 0');
// A message someone can leave for you when you are Busy or Away.
addColumn('users', 'auto_reply', "TEXT NOT NULL DEFAULT ''");
// Voice messages carry their length so the player can show it before playing.
addColumn('attachments', 'duration_ms', 'INTEGER');

db.exec(`
CREATE TABLE IF NOT EXISTS polls (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  question TEXT NOT NULL,
  multi INTEGER NOT NULL DEFAULT 0,
  closed_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS poll_options (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id),
  label TEXT NOT NULL,
  position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id TEXT NOT NULL REFERENCES polls(id),
  option_id TEXT NOT NULL REFERENCES poll_options(id),
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (poll_id, option_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_poll_votes ON poll_votes(poll_id, user_id);

CREATE TABLE IF NOT EXISTS acks (
  message_id TEXT NOT NULL REFERENCES messages(id),
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS sticky_notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  colour TEXT NOT NULL DEFAULT 'amber',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  conversation_id TEXT,
  message_id TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  notified_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_reminders_due ON reminders(user_id, done, due_at);
CREATE INDEX IF NOT EXISTS ix_sticky_user ON sticky_notes(user_id, updated_at DESC);

/* Calls are kept as a record of who called whom and for how long. */
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  caller_id TEXT NOT NULL,
  caller_name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  answered_at INTEGER,
  ended_at INTEGER,
  participant_ids TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS ix_calls_started ON calls(started_at DESC);
`);

db.exec(`
/* Work management: tasks, meetings, leave, work hours. */
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  conversation_id TEXT,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'private',
  assignee_id TEXT,
  created_by TEXT NOT NULL,
  due_at INTEGER,
  priority TEXT NOT NULL DEFAULT 'normal',
  done_at INTEGER,
  done_by TEXT,
  notified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_tasks_assignee ON tasks(assignee_id, done_at, due_at);
CREATE INDEX IF NOT EXISTS ix_tasks_conv ON tasks(conversation_id);
CREATE INDEX IF NOT EXISTS ix_tasks_creator ON tasks(created_by);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  conversation_id TEXT,
  cancelled_at INTEGER,
  reminded_at INTEGER,
  ical_uid TEXT NOT NULL,
  ical_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_events_start ON events(starts_at);

CREATE TABLE IF NOT EXISTS event_invites (
  event_id TEXT NOT NULL REFERENCES events(id),
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'invited',
  responded_at INTEGER,
  notified_at INTEGER,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_event_invites_user ON event_invites(user_id);

CREATE TABLE IF NOT EXISTS leave_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'annual',
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  days INTEGER NOT NULL DEFAULT 1,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  decided_at INTEGER,
  decision_note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_leave_user ON leave_requests(user_id, starts_on);

CREATE TABLE IF NOT EXISTS holidays (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS work_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  source TEXT NOT NULL DEFAULT 'presence'
);
CREATE INDEX IF NOT EXISTS ix_work_user ON work_sessions(user_id, started_at);
`);

// A private calendar feed address, so Google Calendar and others can subscribe.
addColumn('users', 'ical_token', 'TEXT');

db.exec(`
/* Peach Drive: personal folders and room drives, with versions and per-file sharing. */
CREATE TABLE IF NOT EXISTS drive_items (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  conversation_id TEXT,
  parent_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('folder','file')),
  mime TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0,
  storage_key TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_drive_owner ON drive_items(owner_id, parent_id);
CREATE INDEX IF NOT EXISTS ix_drive_room ON drive_items(conversation_id, parent_id);
CREATE INDEX IF NOT EXISTS ix_drive_parent ON drive_items(parent_id);

CREATE TABLE IF NOT EXISTS drive_versions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES drive_items(id),
  version INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  uploaded_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_drive_versions ON drive_versions(item_id, version DESC);

CREATE TABLE IF NOT EXISTS drive_shares (
  item_id TEXT NOT NULL REFERENCES drive_items(id),
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_drive_shares_user ON drive_shares(user_id);

/* Internal mail: a thread of messages, read marks and shared files. */
CREATE TABLE IF NOT EXISTS mail (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_ids TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_mail_thread ON mail(thread_id, created_at);

CREATE TABLE IF NOT EXISTS mail_reads (
  thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);

CREATE TABLE IF NOT EXISTS mail_deleted (
  thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);

CREATE TABLE IF NOT EXISTS mail_attachments (
  id TEXT PRIMARY KEY,
  mail_id TEXT NOT NULL REFERENCES mail(id),
  item_id TEXT NOT NULL REFERENCES drive_items(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_mail_attach ON mail_attachments(mail_id);

/* Helpdesk: one ticket per customer thread, with status, priority and an owner. */
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'normal',
  assignee_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_tickets_status ON tickets(status, updated_at DESC);

/* Public REST API keys. Only a hash is stored; the key is shown once. */
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT 'read,write',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
`);

/* ---- Phase 6: hardening ---- */
// Two-factor sign-in, per-person feature switches, and a session that still
// owes the second step.
addColumn('users', 'totp_secret', 'TEXT');
addColumn('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'allow_files', 'INTEGER NOT NULL DEFAULT 1');
addColumn('users', 'allow_calls', 'INTEGER NOT NULL DEFAULT 1');
addColumn('users', 'allow_otr', 'INTEGER NOT NULL DEFAULT 1');
addColumn('users', 'allow_drive', 'INTEGER NOT NULL DEFAULT 1');
addColumn('sessions', 'needs_2fa', 'INTEGER NOT NULL DEFAULT 0');

db.exec(`
CREATE TABLE IF NOT EXISTS twofa_tickets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_participants_member ON participants(participant_type, participant_id);
CREATE INDEX IF NOT EXISTS ix_audit_created ON audit_log(created_at DESC);
`);

// The seeded admin always answers to the username "admin".
db.prepare(`UPDATE users SET username='admin' WHERE is_operator=1 AND (username IS NULL OR username='')`).run();

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

export function getSetting(key: string, fallback = ''): string {
  const row = db.prepare(`SELECT value FROM settings WHERE key=?`).get(key) as any;
  return row ? row.value : fallback;
}

export function audit(userId: string | null, userName: string | null, action: string, detail: string): void {
  db.prepare(`INSERT INTO audit_log(id, user_id, user_name, action, detail, created_at) VALUES(?,?,?,?,?,?)`)
    .run(id(), userId, userName, action.slice(0, 60), detail.slice(0, 500), now());
}

export function setSetting(key: string, value: string): void {
  db.prepare(`INSERT INTO settings(key,value) VALUES(?,?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value);
}

/* ---- Peach Wall: one shared wall of posts, likes and replies ---- */
db.exec(`
CREATE TABLE IF NOT EXISTS wall_posts (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wall_likes (
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE IF NOT EXISTS wall_comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_wall_posts_created ON wall_posts(created_at DESC);
CREATE INDEX IF NOT EXISTS ix_wall_comments_post ON wall_comments(post_id, created_at);
`);
