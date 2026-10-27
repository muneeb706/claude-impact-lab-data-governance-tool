import { Router } from 'express';
import { z } from 'zod';
import type { Manager, SessionInfo } from '../../../shared/types';
import { recordAudit } from '../audit';
import {
  endSession,
  getMemberSession,
  hashPassword,
  requireSignedIn,
  revokeSessions,
  SELECT_MANAGER,
  sessionPrincipal,
  startSession,
  verifyPassword,
  verifyPasswordOrDummy,
  type AuditActor,
  type Principal,
} from '../auth';
import type { DB } from '../db';
import { asyncHandler, emailSchema, HttpError, nameSchema, passwordSchema } from '../http';

const setupSchema = z.object({ name: nameSchema, email: emailSchema, password: passwordSchema });

const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password').max(200),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password').max(200),
  newPassword: passwordSchema,
});

const managerCount = (db: DB) => (db.prepare('SELECT COUNT(*) AS n FROM managers').get() as { n: number }).n;

type Credentials = { id: number; status: string; passwordHash: string | null };

export function authRouter(db: DB): Router {
  const router = Router();

  router.get('/session', (req, res) => {
    const principal = sessionPrincipal(db, req);
    res.json({
      manager: principal?.kind === 'manager' ? principal.manager : null,
      member: principal?.kind === 'member' ? principal.member : null,
      needsSetup: managerCount(db) === 0,
    } satisfies SessionInfo);
  });

  // First run only: creates the first account manager and signs them in.
  router.post(
    '/setup',
    asyncHandler(async (req, res) => {
      const input = setupSchema.parse(req.body);
      const passwordHash = await hashPassword(input.password);
      const manager = db.transaction(() => {
        if (managerCount(db) > 0) throw new HttpError(409, 'Setup is already complete. Sign in instead.');
        const { lastInsertRowid } = db
          .prepare('INSERT INTO managers (name, email, password_hash) VALUES (?, ?, ?)')
          .run(input.name, input.email, passwordHash);
        const created = db.prepare(`${SELECT_MANAGER} WHERE m.id = ?`).get(lastInsertRowid) as Manager;
        recordAudit(db, { kind: 'manager', ...created }, {
          action: 'manager.created',
          entityType: 'manager',
          entityId: created.id,
          summary: `Set up the first account manager, ${created.name}`,
          details: { name: created.name, email: created.email },
        });
        return created;
      })();
      startSession(db, req, res, { managerId: manager.id });
      res.status(201).json(manager);
    }),
  );

  // One sign-in form for everyone: account managers first, then account members.
  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const { email, password } = signInSchema.parse(req.body);
      const manager = db
        .prepare('SELECT id, status, password_hash AS passwordHash FROM managers WHERE email = ?')
        .get(email) as Credentials | undefined;
      const member = db
        .prepare('SELECT id, status, password_hash AS passwordHash FROM users WHERE email = ?')
        .get(email) as Credentials | undefined;

      if (await verifyPasswordOrDummy(password, manager?.passwordHash)) {
        if (manager!.status !== 'active') throw new HttpError(403, 'This account manager has been deactivated');
        startSession(db, req, res, { managerId: manager!.id });
        res.json({ kind: 'manager' });
        return;
      }
      if (await verifyPasswordOrDummy(password, member?.passwordHash)) {
        if (member!.status !== 'active') throw new HttpError(403, 'Your access has been suspended');
        if (!getMemberSession(db, member!.id)) throw new HttpError(403, 'Your access has been suspended');
        startSession(db, req, res, { userId: member!.id });
        res.json({ kind: 'member' });
        return;
      }
      throw new HttpError(401, 'Incorrect email or password');
    }),
  );

  router.post('/logout', (req, res) => {
    endSession(db, req, res);
    res.status(204).end();
  });

  // Changing your password signs you out of every other session.
  router.post(
    '/password',
    requireSignedIn(db),
    asyncHandler(async (req, res) => {
      const principal = res.locals.principal as Principal;
      const input = changePasswordSchema.parse(req.body);
      const isManager = principal.kind === 'manager';
      const self = isManager ? principal.manager : principal.member;
      const table = isManager ? 'managers' : 'users';

      const { passwordHash } = db.prepare(`SELECT password_hash AS passwordHash FROM ${table} WHERE id = ?`).get(self.id) as {
        passwordHash: string;
      };
      if (!(await verifyPassword(input.currentPassword, passwordHash))) {
        throw new HttpError(400, 'Current password is incorrect', 'currentPassword');
      }
      const newHash = await hashPassword(input.newPassword);
      const actor: AuditActor = { kind: principal.kind, id: self.id, name: self.name, email: self.email };
      db.transaction(() => {
        db.prepare(`UPDATE ${table} SET password_hash = ? WHERE id = ?`).run(newHash, self.id);
        revokeSessions(db, isManager ? { managerId: self.id } : { userId: self.id }, req);
        recordAudit(db, actor, {
          action: isManager ? 'manager.password_changed' : 'user.password_changed',
          entityType: isManager ? 'manager' : 'user',
          entityId: self.id,
          summary: `${self.name} changed their password`,
        });
      })();
      res.status(204).end();
    }),
  );

  return router;
}
