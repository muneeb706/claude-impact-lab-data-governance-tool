import type { AuditActor } from './auth';
import type { DB } from './db';

export function recordAudit(
  db: DB,
  actor: AuditActor,
  entry: {
    action: string;
    entityType: string;
    entityId: number | bigint | null;
    summary: string;
    details?: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT INTO audit_log (actor_kind, actor_id, actor_user_id, actor, actor_email, action, entity_type, entity_id, summary, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    actor.kind,
    actor.kind === 'manager' ? actor.id : null,
    actor.kind === 'member' ? actor.id : null,
    actor.name,
    actor.email,
    entry.action,
    entry.entityType,
    entry.entityId,
    entry.summary,
    JSON.stringify(entry.details ?? {}),
  );
}
