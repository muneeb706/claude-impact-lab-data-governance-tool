import { Router } from 'express';
import { z } from 'zod';
import type { AuditEntry } from '../../../shared/types';
import type { DB } from '../db';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  entityType: z.enum(['account', 'role', 'user', 'policy', 'manager', 'dataset']).optional(),
  actorId: z.coerce.number().int().positive().optional(),
});

export function auditRouter(db: DB): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const { limit, entityType, actorId } = querySchema.parse(req.query);
    const rows = db
      .prepare(
        `SELECT id, actor_kind AS actorKind, actor_id AS actorId, actor, actor_email AS actorEmail, action, entity_type AS entityType,
                entity_id AS entityId, summary, details, created_at AS createdAt
         FROM audit_log
         WHERE (@entityType IS NULL OR entity_type = @entityType) AND (@actorId IS NULL OR actor_id = @actorId)
         ORDER BY id DESC
         LIMIT @limit`,
      )
      .all({ limit, entityType: entityType ?? null, actorId: actorId ?? null }) as (Omit<AuditEntry, 'details'> & { details: string })[];
    res.json(rows.map((row) => ({ ...row, details: JSON.parse(row.details) }) satisfies AuditEntry));
  });

  return router;
}
