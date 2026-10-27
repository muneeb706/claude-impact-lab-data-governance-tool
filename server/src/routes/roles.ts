import { Router } from 'express';
import { z } from 'zod';
import { ACCOUNT_TYPES, type AccountType, type Role } from '../../../shared/types';
import { recordAudit } from '../audit';
import { actorOf } from '../auth';
import type { DB } from '../db';
import { HttpError, notFound, parseId } from '../http';
import { POLICY_ORDER } from './policies';

interface RoleRow extends Omit<Role, 'isSystem' | 'policyIds'> {
  isSystem: number;
  policyIds: string | null;
}

const SELECT_ROLE = `
  SELECT r.id, r.name, r.account_type AS accountType, r.description, r.is_system AS isSystem,
         r.created_at AS createdAt,
         (SELECT GROUP_CONCAT(rp.policy_id) FROM role_policies rp WHERE rp.role_id = r.id) AS policyIds,
         (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS userCount
  FROM roles r
`;

const policyIdsSchema = z.array(z.number().int().positive()).max(200);

const createSchema = z.object({
  name: z.string().trim().min(1, 'Role name is required').max(80),
  accountType: z.enum(ACCOUNT_TYPES, 'Account type must be academic or industry'),
  description: z.string().trim().max(500).default(''),
  policyIds: policyIdsSchema.default([]),
});

// A role's account type is fixed because users are assigned roles by account type.
const updateSchema = createSchema.omit({ accountType: true }).partial();

const listQuerySchema = z.object({ accountType: z.enum(ACCOUNT_TYPES).optional() });

function toRole(row: RoleRow): Role {
  return {
    ...row,
    isSystem: row.isSystem === 1,
    policyIds: row.policyIds ? row.policyIds.split(',').map(Number).sort((a, b) => a - b) : [],
  };
}

export function getRole(db: DB, id: number): Role {
  const row = db.prepare(`${SELECT_ROLE} WHERE r.id = ?`).get(id) as RoleRow | undefined;
  if (!row) throw notFound('Role');
  return toRole(row);
}

function policyCodes(db: DB, ids: number[]): string[] {
  if (ids.length === 0) return [];
  const rows = db
    .prepare(`SELECT p.code FROM policies p WHERE p.id IN (${ids.map(() => '?').join(',')}) ORDER BY ${POLICY_ORDER}`)
    .all(...ids) as { code: string }[];
  return rows.map((r) => r.code);
}

function assertPoliciesExist(db: DB, ids: number[]): void {
  const unique = [...new Set(ids)];
  if (policyCodes(db, unique).length !== unique.length) {
    throw new HttpError(400, 'One or more selected policies do not exist', 'policyIds');
  }
}

function setPolicies(db: DB, roleId: number, ids: number[]): void {
  db.prepare('DELETE FROM role_policies WHERE role_id = ?').run(roleId);
  const insert = db.prepare('INSERT OR IGNORE INTO role_policies (role_id, policy_id) VALUES (?, ?)');
  for (const policyId of ids) insert.run(roleId, policyId);
}

export function rolesRouter(db: DB): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const { accountType } = listQuerySchema.parse(req.query);
    const rows = accountType
      ? db.prepare(`${SELECT_ROLE} WHERE r.account_type = ? ORDER BY r.is_system DESC, r.name`).all(accountType)
      : db.prepare(`${SELECT_ROLE} ORDER BY r.account_type, r.is_system DESC, r.name`).all();
    res.json((rows as RoleRow[]).map(toRole));
  });

  router.get('/:id', (req, res) => {
    res.json(getRole(db, parseId(req.params.id)));
  });

  router.post('/', (req, res) => {
    const input = createSchema.parse(req.body);
    assertPoliciesExist(db, input.policyIds);
    const id = db.transaction(() => {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO roles (name, account_type, description) VALUES (@name, @accountType, @description)')
        .run(input);
      const roleId = Number(lastInsertRowid);
      setPolicies(db, roleId, input.policyIds);
      recordAudit(db, actorOf(res), {
        action: 'role.created',
        entityType: 'role',
        entityId: roleId,
        summary: `Created ${input.accountType} role "${input.name}" with ${policyCount(new Set(input.policyIds).size)}`,
        details: { name: input.name, accountType: input.accountType, policies: policyCodes(db, input.policyIds) },
      });
      return roleId;
    })();
    res.status(201).json(getRole(db, id));
  });

  router.patch('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const input = updateSchema.parse(req.body);
    const before = getRole(db, id);
    if (before.isSystem && input.name !== undefined && input.name !== before.name) {
      throw new HttpError(400, 'Built-in roles cannot be renamed', 'name');
    }
    if (input.policyIds) assertPoliciesExist(db, input.policyIds);

    db.transaction(() => {
      db.prepare(
        `UPDATE roles SET name = COALESCE(@name, name), description = COALESCE(@description, description)
         WHERE id = @id`,
      ).run({ id, name: input.name ?? null, description: input.description ?? null });

      const details: Record<string, unknown> = {};
      if (input.name !== undefined && input.name !== before.name) details.renamed = { from: before.name, to: input.name };
      if (input.description !== undefined && input.description !== before.description) details.descriptionChanged = true;
      if (input.policyIds) {
        const next = new Set(input.policyIds);
        const prev = new Set(before.policyIds);
        const added = policyCodes(db, [...next].filter((p) => !prev.has(p)));
        const removed = policyCodes(db, [...prev].filter((p) => !next.has(p)));
        setPolicies(db, id, [...next]);
        if (added.length) details.policiesAdded = added;
        if (removed.length) details.policiesRemoved = removed;
      }

      if (Object.keys(details).length > 0) {
        recordAudit(db, actorOf(res), {
          action: 'role.updated',
          entityType: 'role',
          entityId: id,
          summary: describeRoleUpdate(input.name ?? before.name, details),
          details,
        });
      }
    })();
    res.json(getRole(db, id));
  });

  router.delete('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const role = getRole(db, id);
    if (role.isSystem) throw new HttpError(400, 'Built-in roles cannot be deleted');
    if (role.userCount > 0) {
      throw new HttpError(409, `Reassign the ${role.userCount} user(s) with this role before deleting it`);
    }
    db.transaction(() => {
      db.prepare('DELETE FROM roles WHERE id = ?').run(id);
      recordAudit(db, actorOf(res), {
        action: 'role.deleted',
        entityType: 'role',
        entityId: id,
        summary: `Deleted ${role.accountType} role "${role.name}"`,
        details: { name: role.name, accountType: role.accountType },
      });
    })();
    res.status(204).end();
  });

  return router;
}

const policyCount = (n: number) => `${n} ${n === 1 ? 'policy' : 'policies'}`;

function describeRoleUpdate(name: string, details: Record<string, unknown>): string {
  const parts: string[] = [];
  const added = details.policiesAdded as string[] | undefined;
  const removed = details.policiesRemoved as string[] | undefined;
  if (details.renamed) parts.push('renamed');
  if (details.descriptionChanged) parts.push('description changed');
  if (added) parts.push(`${policyCount(added.length)} added`);
  if (removed) parts.push(`${policyCount(removed.length)} removed`);
  return `Updated role "${name}": ${parts.join(', ')}`;
}

export function assertRoleMatchesAccount(role: Role, accountType: AccountType): void {
  if (role.accountType !== accountType) {
    throw new HttpError(
      400,
      `"${role.name}" is a ${role.accountType} role and cannot be assigned in a ${accountType} account`,
      'roleId',
    );
  }
}
