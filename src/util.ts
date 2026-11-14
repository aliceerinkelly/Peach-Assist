import crypto from 'node:crypto';

export function id(bytes = 16): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function now(): number {
  return Date.now();
}

/** Opaque capability token. Only its hash is ever stored. */
export function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function hmac(secret: string, s: string): string {
  return crypto.createHmac('sha256', secret).update(s).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function scryptHash(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

export function scryptVerify(password: string, stored: string): boolean {
  const [saltHex, hashHex] = (stored || '').split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const COOKIE_ATTRS = 'Path=/; HttpOnly; SameSite=Lax';

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function setCookie(res: any, name: string, value: string, maxAgeSeconds = 60 * 60 * 24 * 30): void {
  const prior = res.getHeader('Set-Cookie');
  const list = prior ? (Array.isArray(prior) ? prior : [String(prior)]) : [];
  list.push(`${name}=${encodeURIComponent(value)}; Max-Age=${maxAgeSeconds}; ${COOKIE_ATTRS}`);
  res.setHeader('Set-Cookie', list);
}

export function clearCookie(res: any, name: string): void {
  const prior = res.getHeader('Set-Cookie');
  const list = prior ? (Array.isArray(prior) ? prior : [String(prior)]) : [];
  list.push(`${name}=; Max-Age=0; ${COOKIE_ATTRS}`);
  res.setHeader('Set-Cookie', list);
}

export function json(res: any, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(data);
}

export async function readBody(req: any, limit = 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req: any, limit = 256 * 1024): Promise<any> {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

export function clientIp(req: any): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}
