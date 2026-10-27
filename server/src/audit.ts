import type { Manager } from '../../shared/types';
import type { DB } from './db';

export function recordAudit(
  db: DB,
  actor: Pick<Manager, 'id' | 'name' | 'email'>,
  entry: {
    action: string;
    entityType: string;
    entityId: number | bigint | null;
    summary: string;
    details?: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT INTO audit_log (actor_id, actor, actor_email, action, entity_type, entity_id, summary, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    actor.id,
    actor.name,
    actor.email,
    entry.action,
    entry.entityType,
    entry.entityId,
    entry.summary,
    JSON.stringify(entry.details ?? {}),
  );
}
