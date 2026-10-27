import crypto from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import type { Manager, MemberSession } from '../../shared/types';
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
export async function verifyPasswordOrDummy(password: string, stored: string | null | undefined): Promise<boolean> {
  const ok = await verifyPassword(password, stored ?? (await dummyHash));
  return ok && Boolean(stored);
}

// ---------- Who is signed in ----------

/** Someone signed in to the console: an account manager, or a member of an account. */
export type Principal = { kind: 'manager'; manager: Manager } | { kind: 'member'; member: MemberSession };

/** The identity written to the audit log. */
export interface AuditActor {
  kind: 'manager' | 'member';
  id: number;
  name: string;
  email: string;
}

export const SELECT_MANAGER = `
  SELECT m.id, m.name, m.email, m.status, m.created_at AS createdAt FROM managers m
`;

export function getMemberSession(db: DB, userId: number): MemberSession | undefined {
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.account_id AS accountId, a.name AS accountName, a.type AS accountType,
              u.role_id AS roleId, r.name AS roleName,
              (SELECT GROUP_CONCAT(p.code) FROM role_policies rp JOIN policies p ON p.id = rp.policy_id
               WHERE rp.role_id = u.role_id) AS policyCodes
       FROM users u JOIN accounts a ON a.id = u.account_id JOIN roles r ON r.id = u.role_id
       WHERE u.id = ? AND u.status = 'active' AND u.password_hash IS NOT NULL`,
    )
    .get(userId) as (Omit<MemberSession, 'policyCodes'> & { policyCodes: string | null }) | undefined;
  if (!row) return undefined;
  return { ...row, policyCodes: row.policyCodes ? row.policyCodes.split(',').sort() : [] };
}

// ---------- Sessions ----------

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export function startSession(
  db: DB,
  req: Request,
  res: Response,
  owner: { managerId: number } | { userId: number },
): void {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
  db.prepare('INSERT INTO sessions (token_hash, manager_id, user_id, expires_at) VALUES (?, ?, ?, ?)').run(
    hashToken(token),
    'managerId' in owner ? owner.managerId : null,
    'userId' in owner ? owner.userId : null,
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

/** Signs someone out everywhere, optionally keeping the session making this request. */
export function revokeSessions(db: DB, owner: { managerId: number } | { userId: number }, keep?: Request): void {
  const token = keep && readSessionToken(keep);
  const column = 'managerId' in owner ? 'manager_id' : 'user_id';
  const id = 'managerId' in owner ? owner.managerId : owner.userId;
  db.prepare(`DELETE FROM sessions WHERE ${column} = ? AND token_hash IS NOT ?`).run(id, token ? hashToken(token) : null);
}

function readSessionToken(req: Request): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(value.join('=')) || undefined;
  }
  return undefined;
}

export function sessionPrincipal(db: DB, req: Request): Principal | undefined {
  const token = readSessionToken(req);
  if (!token) return undefined;
  const session = db
    .prepare('SELECT manager_id AS managerId, user_id AS userId FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .get(hashToken(token), new Date().toISOString()) as { managerId: number | null; userId: number | null } | undefined;
  if (!session) return undefined;

  if (session.managerId !== null) {
    const manager = db.prepare(`${SELECT_MANAGER} WHERE m.id = ? AND m.status = 'active'`).get(session.managerId) as
      | Manager
      | undefined;
    return manager && { kind: 'manager', manager };
  }
  const member = getMemberSession(db, session.userId!);
  return member && { kind: 'member', member };
}

export function requireManager(db: DB): RequestHandler {
  return (req, res, next) => {
    const principal = sessionPrincipal(db, req);
    if (!principal) {
      res.status(401).json({ error: 'Sign in to continue' });
      return;
    }
    if (principal.kind !== 'manager') {
      res.status(403).json({ error: 'Only account managers can do this' });
      return;
    }
    res.locals.principal = principal;
    next();
  };
}

/** Requires a signed-in member whose role grants at least one of `anyOf` (or any member if empty). */
export function requireMember(db: DB, ...anyOf: string[]): RequestHandler {
  return (req, res, next) => {
    const principal = sessionPrincipal(db, req);
    if (!principal) {
      res.status(401).json({ error: 'Sign in to continue' });
      return;
    }
    if (principal.kind !== 'member') {
      res.status(403).json({ error: 'Only account members can do this' });
      return;
    }
    if (anyOf.length > 0 && !anyOf.some((code) => principal.member.policyCodes.includes(code))) {
      res.status(403).json({ error: 'Your role does not allow this' });
      return;
    }
    res.locals.principal = principal;
    next();
  };
}

/** The signed-in manager making this request. Only valid behind requireManager. */
export function actorOf(res: Response): AuditActor {
  const principal = res.locals.principal as Principal | undefined;
  if (principal?.kind !== 'manager') throw new Error('actorOf called without requireManager');
  return { kind: 'manager', id: principal.manager.id, name: principal.manager.name, email: principal.manager.email };
}

/** The signed-in member making this request. Only valid behind requireMember. */
export function memberOf(res: Response): MemberSession {
  const principal = res.locals.principal as Principal | undefined;
  if (principal?.kind !== 'member') throw new Error('memberOf called without requireMember');
  return principal.member;
}

export const memberActor = (member: MemberSession): AuditActor => ({
  kind: 'member',
  id: member.id,
  name: member.name,
  email: member.email,
});

/** The signed-in principal, for routes open to both managers and members. */
export function requireSignedIn(db: DB): RequestHandler {
  return (req, res, next) => {
    const principal = sessionPrincipal(db, req);
    if (!principal) {
      res.status(401).json({ error: 'Sign in to continue' });
      return;
    }
    res.locals.principal = principal;
    next();
  };
}
