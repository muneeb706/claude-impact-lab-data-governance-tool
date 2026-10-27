import { Router } from 'express';
import { z } from 'zod';
import { MANAGER_STATUSES, type Manager } from '../../../shared/types';
import { recordAudit } from '../audit';
import { actorOf, hashPassword, revokeSessions, SELECT_MANAGER } from '../auth';
import type { DB } from '../db';
import { asyncHandler, emailSchema, HttpError, nameSchema, notFound, parseId, passwordSchema } from '../http';

const createSchema = z.object({ name: nameSchema, email: emailSchema, password: passwordSchema });

// `password` sets a new temporary password for another manager.
const updateSchema = z.object({
  name: nameSchema.optional(),
  status: z.enum(MANAGER_STATUSES).optional(),
  password: passwordSchema.optional(),
});

function getManager(db: DB, id: number): Manager {
  const manager = db.prepare(`${SELECT_MANAGER} WHERE m.id = ?`).get(id) as Manager | undefined;
  if (!manager) throw notFound('Account manager');
  return manager;
}

export function managersRouter(db: DB): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(db.prepare(`${SELECT_MANAGER} ORDER BY m.status, m.name`).all());
  });

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = createSchema.parse(req.body);
      const passwordHash = await hashPassword(input.password);
      const id = db.transaction(() => {
        const { lastInsertRowid } = db
          .prepare('INSERT INTO managers (name, email, password_hash) VALUES (?, ?, ?)')
          .run(input.name, input.email, passwordHash);
        recordAudit(db, actorOf(res), {
          action: 'manager.created',
          entityType: 'manager',
          entityId: lastInsertRowid,
          summary: `Added account manager ${input.name}`,
          details: { name: input.name, email: input.email },
        });
        return Number(lastInsertRowid);
      })();
      res.status(201).json(getManager(db, id));
    }),
  );

  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const input = updateSchema.parse(req.body);
      const actor = actorOf(res);
      const before = getManager(db, id);

      if (id === actor.id && input.status === 'deactivated') {
        throw new HttpError(400, "You can't deactivate yourself");
      }
      if (id === actor.id && input.password) {
        throw new HttpError(400, 'Use "Change password" to change your own password', 'password');
      }
      const passwordHash = input.password ? await hashPassword(input.password) : null;

      db.transaction(() => {
        db.prepare(
          `UPDATE managers SET name = COALESCE(@name, name), status = COALESCE(@status, status),
             password_hash = COALESCE(@passwordHash, password_hash)
           WHERE id = @id`,
        ).run({ id, name: input.name ?? null, status: input.status ?? null, passwordHash });

        const deactivated = input.status === 'deactivated' && before.status !== 'deactivated';
        if (deactivated || passwordHash) revokeSessions(db, id);

        const log = (action: string, summary: string, details?: Record<string, unknown>) =>
          recordAudit(db, actor, { action, entityType: 'manager', entityId: id, summary, details });

        if (input.name !== undefined && input.name !== before.name) {
          log('manager.updated', `Renamed account manager ${before.name} to ${input.name}`, {
            name: { from: before.name, to: input.name },
          });
        }
        if (input.status !== undefined && input.status !== before.status) {
          log(
            input.status === 'deactivated' ? 'manager.deactivated' : 'manager.reactivated',
            `${input.status === 'deactivated' ? 'Deactivated' : 'Reactivated'} account manager ${before.name}`,
          );
        }
        if (passwordHash) log('manager.password_reset', `Reset the password for ${before.name}`);
      })();
      res.json(getManager(db, id));
    }),
  );

  return router;
}
