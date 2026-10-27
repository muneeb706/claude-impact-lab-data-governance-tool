import { Router } from 'express';
import { z } from 'zod';
import type { Manager, SessionInfo } from '../../../shared/types';
import { recordAudit } from '../audit';
import {
  actorOf,
  endSession,
  hashPassword,
  requireManager,
  revokeSessions,
  SELECT_MANAGER,
  sessionManager,
  startSession,
  verifyPassword,
  verifyPasswordOrDummy,
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

export function authRouter(db: DB): Router {
  const router = Router();

  router.get('/session', (req, res) => {
    res.json({ manager: sessionManager(db, req) ?? null, needsSetup: managerCount(db) === 0 } satisfies SessionInfo);
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
        recordAudit(db, created, {
          action: 'manager.created',
          entityType: 'manager',
          entityId: created.id,
          summary: `Set up the first account manager, ${created.name}`,
          details: { name: created.name, email: created.email },
        });
        return created;
      })();
      startSession(db, req, res, manager.id);
      res.status(201).json(manager);
    }),
  );

  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const { email, password } = signInSchema.parse(req.body);
      const row = db.prepare('SELECT id, status, password_hash AS passwordHash FROM managers WHERE email = ?').get(email) as
        | { id: number; status: string; passwordHash: string }
        | undefined;
      if (!(await verifyPasswordOrDummy(password, row?.passwordHash))) {
        throw new HttpError(401, 'Incorrect email or password');
      }
      if (row!.status !== 'active') throw new HttpError(403, 'This account manager has been deactivated');
      startSession(db, req, res, row!.id);
      res.json(db.prepare(`${SELECT_MANAGER} WHERE m.id = ?`).get(row!.id));
    }),
  );

  router.post('/logout', (req, res) => {
    endSession(db, req, res);
    res.status(204).end();
  });

  // Changing your password signs you out of every other session.
  router.post(
    '/password',
    requireManager(db),
    asyncHandler(async (req, res) => {
      const actor = actorOf(res);
      const input = changePasswordSchema.parse(req.body);
      const { passwordHash } = db.prepare('SELECT password_hash AS passwordHash FROM managers WHERE id = ?').get(actor.id) as {
        passwordHash: string;
      };
      if (!(await verifyPassword(input.currentPassword, passwordHash))) {
        throw new HttpError(400, 'Current password is incorrect', 'currentPassword');
      }
      const newHash = await hashPassword(input.newPassword);
      db.transaction(() => {
        db.prepare('UPDATE managers SET password_hash = ? WHERE id = ?').run(newHash, actor.id);
        revokeSessions(db, actor.id, req);
        recordAudit(db, actor, {
          action: 'manager.password_changed',
          entityType: 'manager',
          entityId: actor.id,
          summary: `${actor.name} changed their password`,
        });
      })();
      res.status(204).end();
    }),
  );

  return router;
}
