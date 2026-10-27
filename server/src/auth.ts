import crypto from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import type { Manager } from '../../shared/types';
import type { DB } from './db';

export const SESSION_COOKIE = 'dg_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const KEY_LENGTH = 64;

// ---------- Passwords (scrypt, stored as "scrypt$<salt>$<hash>") ----------

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, KEY_LENGTH, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Compared against when an email is unknown, so response time doesn't reveal which emails exist.
const dummyHash = hashPassword(crypto.randomBytes(16).toString('hex'));
export async function verifyPasswordOrDummy(password: string, stored: string | undefined): Promise<boolean> {
  const ok = await verifyPassword(password, stored ?? (await dummyHash));
  return ok && stored !== undefined;
}

// ---------- Sessions ----------

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export const SELECT_MANAGER = `
  SELECT m.id, m.name, m.email, m.status, m.created_at AS createdAt FROM managers m
`;

export function startSession(db: DB, req: Request, res: Response, managerId: number): void {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
  db.prepare('INSERT INTO sessions (token_hash, manager_id, expires_at) VALUES (?, ?, ?)').run(
    hashToken(token),
    managerId,
    expiresAt.toISOString(),
  );
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    expires: expiresAt,
    path: '/',
  });
}

export function endSession(db: DB, req: Request, res: Response): void {
  const token = readSessionToken(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Signs a manager out everywhere, optionally keeping the session making this request. */
export function revokeSessions(db: DB, managerId: number, keep?: Request): void {
  const token = keep && readSessionToken(keep);
  db.prepare('DELETE FROM sessions WHERE manager_id = ? AND token_hash IS NOT ?').run(
    managerId,
    token ? hashToken(token) : null,
  );
}

function readSessionToken(req: Request): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(value.join('=')) || undefined;
  }
  return undefined;
}

export function sessionManager(db: DB, req: Request): Manager | undefined {
  const token = readSessionToken(req);
  if (!token) return undefined;
  return db
    .prepare(
      `${SELECT_MANAGER} JOIN sessions s ON s.manager_id = m.id
       WHERE s.token_hash = ? AND s.expires_at > ? AND m.status = 'active'`,
    )
    .get(hashToken(token), new Date().toISOString()) as Manager | undefined;
}

export function requireManager(db: DB): RequestHandler {
  return (req, res, next) => {
    const manager = sessionManager(db, req);
    if (!manager) {
      res.status(401).json({ error: 'Sign in to continue' });
      return;
    }
    res.locals.manager = manager;
    next();
  };
}

/** The signed-in manager making this request. Only valid behind requireManager. */
export function actorOf(res: Response): Manager {
  const manager = res.locals.manager as Manager | undefined;
  if (!manager) throw new Error('actorOf called without requireManager');
  return manager;
}
