import { Router } from 'express';
import { z } from 'zod';
import { CUSTOM_POLICY_CODE_PATTERN, slugifyPolicyCode } from '../../../shared/policyCode';
import { CUSTOM_POLICY_PREFIX, DATA_TIERS, RISK_LEVELS, type Policy } from '../../../shared/types';
import { recordAudit } from '../audit';
import { actorOf } from '../auth';
import type { DB } from '../db';
import { HttpError, notFound, parseId } from '../http';

export const SELECT_POLICY = `
  SELECT p.id, p.code, p.name, p.description, p.category, p.data_tier AS dataTier, p.risk, p.is_system AS isSystem
  FROM policies p
`;
export const POLICY_ORDER = 'p.is_system DESC, p.sort_order, p.id';

export type PolicyRow = Omit<Policy, 'isSystem'> & { isSystem: number };
export const toPolicy = (row: PolicyRow): Policy => ({ ...row, isSystem: row.isSystem === 1 });

const fieldsSchema = z.object({
  name: z.string().trim().min(1, 'Policy name is required').max(80),
  description: z.string().trim().min(1, 'Describe what the policy allows').max(300),
  category: z.string().trim().min(1, 'Category is required').max(60),
  dataTier: z.enum(DATA_TIERS).nullable(),
  risk: z.enum(RISK_LEVELS, 'Choose a risk level'),
});

const createSchema = fieldsSchema.extend({
  dataTier: fieldsSchema.shape.dataTier.default(null),
  code: z
    .string()
    .trim()
    .toLowerCase()
    .max(80)
    .regex(CUSTOM_POLICY_CODE_PATTERN, `Code must start with "${CUSTOM_POLICY_PREFIX}" and use lowercase letters, digits, _ and .`)
    .optional(),
});

// The code is a stable identifier, so it cannot change after creation.
const updateSchema = fieldsSchema.partial();

function getPolicy(db: DB, id: number): Policy {
  const row = db.prepare(`${SELECT_POLICY} WHERE p.id = ?`).get(id) as PolicyRow | undefined;
  if (!row) throw notFound('Policy');
  return toPolicy(row);
}

function getCustomPolicy(db: DB, id: number): Policy {
  const policy = getPolicy(db, id);
  if (policy.isSystem) throw new HttpError(400, 'Built-in policies cannot be changed');
  return policy;
}

export function policiesRouter(db: DB): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json((db.prepare(`${SELECT_POLICY} ORDER BY ${POLICY_ORDER}`).all() as PolicyRow[]).map(toPolicy));
  });

  router.post('/', (req, res) => {
    const input = createSchema.parse(req.body);
    const code = input.code ?? slugifyPolicyCode(input.name);
    if (!code) throw new HttpError(400, 'Enter a code for this policy', 'code');

    const id = db.transaction(() => {
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO policies (code, name, description, category, data_tier, risk, is_system)
           VALUES (@code, @name, @description, @category, @dataTier, @risk, 0)`,
        )
        .run({ ...input, code });
      recordAudit(db, actorOf(res), {
        action: 'policy.created',
        entityType: 'policy',
        entityId: lastInsertRowid,
        summary: `Created custom policy "${input.name}" (${code})`,
        details: { ...input, code },
      });
      return Number(lastInsertRowid);
    })();
    res.status(201).json(getPolicy(db, id));
  });

  router.patch('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const input = updateSchema.parse(req.body);
    const before = getCustomPolicy(db, id);
    const next = { ...before, ...input };

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of Object.keys(input) as (keyof typeof input)[]) {
      if (before[key] !== next[key]) changes[key] = { from: before[key], to: next[key] };
    }

    db.transaction(() => {
      db.prepare(
        `UPDATE policies SET name = @name, description = @description, category = @category,
           data_tier = @dataTier, risk = @risk
         WHERE id = @id`,
      ).run(next);
      if (Object.keys(changes).length > 0) {
        recordAudit(db, actorOf(res), {
          action: 'policy.updated',
          entityType: 'policy',
          entityId: id,
          summary: `Updated custom policy "${next.name}": ${Object.keys(changes).join(', ')}`,
          details: { code: before.code, ...changes },
        });
      }
    })();
    res.json(getPolicy(db, id));
  });

  router.delete('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const policy = getCustomPolicy(db, id);
    const roles = db
      .prepare('SELECT r.name FROM roles r JOIN role_policies rp ON rp.role_id = r.id WHERE rp.policy_id = ? ORDER BY r.name')
      .all(id) as { name: string }[];
    if (roles.length > 0) {
      throw new HttpError(409, `Remove this policy from ${roles.map((r) => r.name).join(', ')} before deleting it`);
    }
    db.transaction(() => {
      db.prepare('DELETE FROM policies WHERE id = ?').run(id);
      recordAudit(db, actorOf(res), {
        action: 'policy.deleted',
        entityType: 'policy',
        entityId: id,
        summary: `Deleted custom policy "${policy.name}" (${policy.code})`,
        details: { code: policy.code, name: policy.name },
      });
    })();
    res.status(204).end();
  });

  return router;
}
