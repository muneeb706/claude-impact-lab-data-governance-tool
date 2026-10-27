import { Router } from 'express';
import { z } from 'zod';
import { USER_STATUSES, type User, type UserWithPolicies } from '../../../shared/types';
import { recordAudit } from '../audit';
import type { DB } from '../db';
import { actorOf } from '../auth';
import { emailSchema, nameSchema, notFound, parseId } from '../http';
import { getAccount } from './accounts';
import { POLICY_ORDER, SELECT_POLICY, toPolicy, type PolicyRow } from './policies';
import { assertRoleMatchesAccount, getRole } from './roles';

const SELECT_USER = `
  SELECT u.id, u.account_id AS accountId, a.name AS accountName, u.role_id AS roleId, r.name AS roleName,
         u.name, u.email, u.status, u.created_at AS createdAt
  FROM users u
  JOIN accounts a ON a.id = u.account_id
  JOIN roles r ON r.id = u.role_id
`;

const createSchema = z.object({
  accountId: z.number().int().positive(),
  roleId: z.number({ error: 'Select a role' }).int().positive(),
  name: nameSchema,
  email: emailSchema,
});

// Users stay in the account they were created in.
const updateSchema = z
  .object({
    roleId: z.number().int().positive(),
    name: nameSchema,
    email: emailSchema,
    status: z.enum(USER_STATUSES),
  })
  .partial();

const listQuerySchema = z.object({ accountId: z.coerce.number().int().positive().optional() });

export function getUser(db: DB, id: number): User {
  const user = db.prepare(`${SELECT_USER} WHERE u.id = ?`).get(id) as User | undefined;
  if (!user) throw notFound('User');
  return user;
}

export function usersRouter(db: DB): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const { accountId } = listQuerySchema.parse(req.query);
    const users = accountId
      ? db.prepare(`${SELECT_USER} WHERE u.account_id = ? ORDER BY u.name`).all(accountId)
      : db.prepare(`${SELECT_USER} ORDER BY a.name, u.name`).all();
    res.json(users);
  });

  // A user's effective policies are those granted by their role.
  router.get('/:id', (req, res) => {
    const user = getUser(db, parseId(req.params.id));
    const policies = db
      .prepare(
        `${SELECT_POLICY} JOIN role_policies rp ON rp.policy_id = p.id WHERE rp.role_id = ? ORDER BY ${POLICY_ORDER}`,
      )
      .all(user.roleId) as PolicyRow[];
    res.json({ ...user, policies: policies.map(toPolicy) } satisfies UserWithPolicies);
  });

  router.post('/', (req, res) => {
    const input = createSchema.parse(req.body);
    const account = getAccount(db, input.accountId);
    const role = getRole(db, input.roleId);
    assertRoleMatchesAccount(role, account.type);

    const id = db.transaction(() => {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO users (account_id, role_id, name, email) VALUES (@accountId, @roleId, @name, @email)')
        .run(input);
      recordAudit(db, actorOf(res), {
        action: 'user.created',
        entityType: 'user',
        entityId: lastInsertRowid,
        summary: `Added ${input.name} to "${account.name}" as ${role.name}`,
        details: { name: input.name, email: input.email, account: account.name, role: role.name },
      });
      return Number(lastInsertRowid);
    })();
    res.status(201).json(getUser(db, id));
  });

  router.patch('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const input = updateSchema.parse(req.body);
    const before = getUser(db, id);

    if (input.roleId !== undefined && input.roleId !== before.roleId) {
      assertRoleMatchesAccount(getRole(db, input.roleId), getAccount(db, before.accountId).type);
    }

    const after = db.transaction(() => {
      db.prepare(
        `UPDATE users SET
           role_id = COALESCE(@roleId, role_id),
           name = COALESCE(@name, name),
           email = COALESCE(@email, email),
           status = COALESCE(@status, status)
         WHERE id = @id`,
      ).run({
        id,
        roleId: input.roleId ?? null,
        name: input.name ?? null,
        email: input.email ?? null,
        status: input.status ?? null,
      });
      const updated = getUser(db, id);

      const changes: Record<string, { from: string; to: string }> = {};
      if (updated.roleName !== before.roleName) changes.role = { from: before.roleName, to: updated.roleName };
      if (updated.name !== before.name) changes.name = { from: before.name, to: updated.name };
      if (updated.email !== before.email) changes.email = { from: before.email, to: updated.email };
      if (updated.status !== before.status) changes.status = { from: before.status, to: updated.status };

      if (Object.keys(changes).length > 0) {
        recordAudit(db, actorOf(res), {
          action: changes.role ? 'user.role_changed' : 'user.updated',
          entityType: 'user',
          entityId: id,
          summary: describeUserUpdate(updated, changes),
          details: changes,
        });
      }
      return updated;
    })();
    res.json(after);
  });

  router.delete('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const user = getUser(db, id);
    db.transaction(() => {
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
      recordAudit(db, actorOf(res), {
        action: 'user.deleted',
        entityType: 'user',
        entityId: id,
        summary: `Removed ${user.name} from "${user.accountName}"`,
        details: { name: user.name, email: user.email, account: user.accountName, role: user.roleName },
      });
    })();
    res.status(204).end();
  });

  return router;
}

function describeUserUpdate(user: User, changes: Record<string, { from: string; to: string }>): string {
  if (changes.role) return `Changed ${user.name}'s role from ${changes.role.from} to ${changes.role.to}`;
  if (changes.status && Object.keys(changes).length === 1) {
    return `${changes.status.to === 'suspended' ? 'Suspended' : 'Reactivated'} ${user.name}`;
  }
  return `Updated ${user.name}: ${Object.keys(changes).join(', ')}`;
}
