/**
 * Transactional email.
 *
 * With no EMAIL_API_KEY every message is printed to the console instead of sent,
 * which is the brief's development rule. With a key present the message is posted
 * to a transactional provider (Resend-compatible payload).
 *
 * Notification mail never carries message content: subject line and link only.
 */
import { db } from './db.js';
import { now, sha256 } from './util.js';

const API_KEY = process.env.EMAIL_API_KEY || '';
const FROM = process.env.EMAIL_FROM || 'Messenger <noreply@localhost>';
const API_URL = process.env.EMAIL_API_URL || 'https://api.resend.com/emails';

export function isSuppressed(email: string): boolean {
  const row = db.prepare(`SELECT email FROM suppression WHERE email=?`).get(email) as any;
  return !!row;
}

export function suppress(email: string): void {
  db.prepare(`INSERT OR IGNORE INTO suppression(email, created_at) VALUES(?,?)`).run(email.toLowerCase(), now());
}

export async function sendMail(to: string, subject: string, text: string, html?: string): Promise<boolean> {
  if (!to) return false;
  if (isSuppressed(to)) {
    console.log(`[mail] suppressed: ${to}`);
    return false;
  }
  if (!API_KEY) {
    console.log(`\n[mail:dev] to=${to}\n  subject: ${subject}\n  ${text.replace(/\n/g, '\n  ')}\n`);
    return true;
  }
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to: [to], subject, text, html }),
    });
    if (!res.ok) {
      console.error(`[mail] provider error ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[mail] send failed', err);
    return false;
  }
}

/** Reply notification: subject and link only, never the message body. */
export async function sendReplyNotification(to: string, threadUrl: string): Promise<void> {
  const subject = 'You have a reply in your conversation';
  const text =
    `There is a new reply waiting for you.\n\n` +
    `Open your conversation: ${threadUrl}\n\n` +
    `To stop these notifications: ${threadUrl}/stop\n\n` +
    `Reply\n`;
  await sendMail(to, subject, text);
}

export function stopToken(email: string): string {
  return sha256(email + '|stop');
}
