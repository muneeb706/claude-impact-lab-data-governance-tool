import { Router } from 'express';
import { z } from 'zod';
import { ACCOUNT_TYPES, type Account } from '../../../shared/types';
import { recordAudit } from '../audit';
import { actorOf } from '../auth';
import type { DB } from '../db';
import { notFound, parseId } from '../http';

const SELECT_ACCOUNT = `
  SELECT a.id, a.name, a.type, a.description, a.created_at AS createdAt,
         (SELECT COUNT(*) FROM users u WHERE u.account_id = a.id) AS userCount
  FROM accounts a
`;

const createSchema = z.object({
  name: z.string().trim().min(1, 'Account name is required').max(120),
  type: z.enum(ACCOUNT_TYPES, 'Account type must be academic or industry'),
  description: z.string().trim().max(500).default(''),
});

// The account type is fixed at creation because users' roles depend on it.
const updateSchema = createSchema.omit({ type: true }).partial();

export function getAccount(db: DB, id: number): Account {
  const account = db.prepare(`${SELECT_ACCOUNT} WHERE a.id = ?`).get(id) as Account | undefined;
  if (!account) throw notFound('Account');
  return account;
}

export function accountsRouter(db: DB): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(db.prepare(`${SELECT_ACCOUNT} ORDER BY a.name`).all());
  });

  router.get('/:id', (req, res) => {
    res.json(getAccount(db, parseId(req.params.id)));
  });

  router.post('/', (req, res) => {
    const input = createSchema.parse(req.body);
    const id = db.transaction(() => {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO accounts (name, type, description) VALUES (@name, @type, @description)')
        .run(input);
      recordAudit(db, actorOf(res), {
        action: 'account.created',
        entityType: 'account',
        entityId: lastInsertRowid,
        summary: `Created ${input.type} account "${input.name}"`,
        details: input,
      });
      return Number(lastInsertRowid);
    })();
    res.status(201).json(getAccount(db, id));
  });

  router.patch('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const input = updateSchema.parse(req.body);
    const before = getAccount(db, id);
    db.transaction(() => {
      db.prepare(
        `UPDATE accounts SET name = COALESCE(@name, name), description = COALESCE(@description, description)
         WHERE id = @id`,
      ).run({ id, name: input.name ?? null, description: input.description ?? null });
      recordAudit(db, actorOf(res), {
        action: 'account.updated',
        entityType: 'account',
        entityId: id,
        summary: `Updated account "${input.name ?? before.name}"`,
        details: { before: { name: before.name, description: before.description }, changes: input },
      });
    })();
    res.json(getAccount(db, id));
  });

  router.delete('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const account = getAccount(db, id);
    db.transaction(() => {
      db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
      recordAudit(db, actorOf(res), {
        action: 'account.deleted',
        entityType: 'account',
        entityId: id,
        summary: `Deleted account "${account.name}" and its ${account.userCount} user(s)`,
        details: { name: account.name, type: account.type, userCount: account.userCount },
      });
    })();
    res.status(204).end();
  });

  return router;
}
