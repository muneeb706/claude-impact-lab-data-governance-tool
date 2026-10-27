import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import {
  COLUMN_CLAUDE_ACCESS,
  DATA_TIERS,
  FILE_CLAUDE_ACCESS,
  type Dataset,
  type DatasetGrant,
  type DatasetPreview,
  type Grantee,
  type MemberSession,
} from '../../../shared/types';
import { recordAudit } from '../audit';
import { memberActor, memberOf, requireMember } from '../auth';
import { CsvError, parseTable } from '../csv';
import {
  buildBundle,
  canRead,
  effectiveColumns,
  getColumns,
  getDatasetRecord,
  isStewardOf,
  projectCsv,
  type DatasetRecord,
} from '../datasets';
import type { DB } from '../db';
import { HttpError, notFound, parseId } from '../http';

export const MAX_CSV_BYTES = 10 * 1024 * 1024;
const MAX_COLUMNS = 200;

const uploadSchema = z.object({
  name: z.string().trim().min(1, 'Dataset name is required').max(120),
  description: z.string().trim().max(1000).default(''),
  fileName: z.string().trim().min(1).max(200),
  csv: z.string().min(1, 'Choose a CSV file'),
  dataTier: z.enum(DATA_TIERS).default('internal'),
});

const updateSchema = z.object({
  name: z.string().trim().min(1, 'Dataset name is required').max(120).optional(),
  description: z.string().trim().max(1000).optional(),
  dataTier: z.enum(DATA_TIERS).optional(),
  claudeAccess: z.enum(FILE_CLAUDE_ACCESS).optional(),
  columns: z
    .array(
      z.object({
        position: z.number().int().min(0),
        classification: z.enum(DATA_TIERS).optional(),
        claudeAccess: z.enum(COLUMN_CLAUDE_ACCESS).optional(),
        description: z.string().trim().max(300).optional(),
      }),
    )
    .max(MAX_COLUMNS)
    .optional(),
});

const previewSchema = z.object({
  view: z.enum(['full', 'claude']).default('full'),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});

const grantSchema = z.object({ userId: z.number().int().positive() });

const isGranted = (db: DB, datasetId: number, userId: number) =>
  Boolean(db.prepare('SELECT 1 FROM dataset_grants WHERE dataset_id = ? AND user_id = ?').get(datasetId, userId));

function policyNameLookup(db: DB): (code: string) => string {
  const rows = db.prepare('SELECT code, name FROM policies').all() as { code: string; name: string }[];
  const names = new Map(rows.map((r) => [r.code, r.name]));
  return (code) => names.get(code) ?? code;
}

/** A dataset this member may see: stewards see their account's datasets, others only ones granted to them. */
function loadVisible(db: DB, id: number, member: MemberSession): DatasetRecord {
  const dataset = getDatasetRecord(db, id);
  if (!dataset || dataset.accountId !== member.accountId) throw notFound('Dataset');
  if (!isStewardOf(member, dataset.accountId) && !isGranted(db, id, member.id)) throw notFound('Dataset');
  return dataset;
}

function loadStewarded(db: DB, id: number, member: MemberSession): DatasetRecord {
  const dataset = loadVisible(db, id, member);
  if (!isStewardOf(member, dataset.accountId)) throw new HttpError(403, 'Only data stewards can do this');
  return dataset;
}

function downloadCheck(db: DB, dataset: DatasetRecord, member: MemberSession): { allowed: boolean; reason?: string } {
  if (!isStewardOf(member, dataset.accountId)) {
    if (!isGranted(db, dataset.id, member.id)) return { allowed: false, reason: 'This dataset has not been shared with you.' };
    if (!member.policyCodes.includes('data.download')) {
      return { allowed: false, reason: 'Your role does not include "Download granted datasets".' };
    }
  }
  if (!canRead(member, dataset.dataTier)) {
    return { allowed: false, reason: `Your role can't read ${dataset.dataTier} data.` };
  }
  return { allowed: true };
}

function grantsFor(db: DB, datasetId: number): DatasetGrant[] {
  return db
    .prepare(
      `SELECT g.user_id AS userId, u.name, u.email, r.name AS roleName, gb.name AS grantedBy, g.created_at AS createdAt
       FROM dataset_grants g JOIN users u ON u.id = g.user_id JOIN roles r ON r.id = u.role_id
       LEFT JOIN users gb ON gb.id = g.granted_by
       WHERE g.dataset_id = ? ORDER BY u.name`,
    )
    .all(datasetId) as DatasetGrant[];
}

/** Members a steward can share this dataset with: same account, active, and their role allows downloading it. */
function eligibleGrantees(db: DB, dataset: DatasetRecord): Grantee[] {
  return db
    .prepare(
      `SELECT u.id, u.name, u.email, r.name AS roleName FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.account_id = @accountId AND u.status = 'active'
         AND EXISTS (SELECT 1 FROM role_policies rp JOIN policies p ON p.id = rp.policy_id
                     WHERE rp.role_id = u.role_id AND p.code = 'data.download')
         AND EXISTS (SELECT 1 FROM role_policies rp JOIN policies p ON p.id = rp.policy_id
                     WHERE rp.role_id = u.role_id AND p.code = @readPolicy)
         AND u.id NOT IN (SELECT user_id FROM dataset_grants WHERE dataset_id = @datasetId)
       ORDER BY u.name`,
    )
    .all({ accountId: dataset.accountId, readPolicy: `data.${dataset.dataTier}.read`, datasetId: dataset.id }) as Grantee[];
}

function toDataset(db: DB, dataset: DatasetRecord, member: MemberSession, detail: boolean): Dataset {
  const steward = isStewardOf(member, dataset.accountId);
  const columns = getColumns(db, dataset.id);
  const result: Dataset = {
    id: dataset.id,
    accountId: dataset.accountId,
    name: dataset.name,
    description: dataset.description,
    fileName: dataset.fileName,
    rowCount: dataset.rowCount,
    byteSize: dataset.byteSize,
    dataTier: dataset.dataTier,
    claudeAccess: dataset.claudeAccess,
    uploadedBy: dataset.uploadedBy,
    createdAt: dataset.createdAt,
    updatedAt: dataset.updatedAt,
    columns,
    download: downloadCheck(db, dataset, member),
  };
  if (steward) result.grants = grantsFor(db, dataset.id);
  if (detail) {
    result.effective = effectiveColumns(dataset, columns, member, policyNameLookup(db));
    if (steward) {
      const { rows } = parseTable(dataset.content);
      result.columns = columns.map((c) => ({
        ...c,
        samples: [...new Set(rows.map((r) => r[c.position]).filter((v) => v !== ''))].slice(0, 3),
      }));
    }
  }
  return result;
}

function stewardOf(db: DB, accountId: number): string | null {
  const row = db
    .prepare(
      `SELECT u.name FROM users u WHERE u.account_id = ? AND u.status = 'active'
         AND EXISTS (SELECT 1 FROM role_policies rp JOIN policies p ON p.id = rp.policy_id
                     WHERE rp.role_id = u.role_id AND p.code = 'data.steward')
       ORDER BY u.id LIMIT 1`,
    )
    .get(accountId) as { name: string } | undefined;
  return row?.name ?? null;
}

export function datasetsRouter(db: DB): Router {
  const router = Router();
  const anyMember = requireMember(db);
  const steward = requireMember(db, 'data.steward');

  router.get('/', anyMember, (_req, res) => {
    const member = memberOf(res);
    const ids = (
      member.policyCodes.includes('data.steward')
        ? db.prepare('SELECT id FROM datasets WHERE account_id = ? ORDER BY name').all(member.accountId)
        : db
            .prepare(
              `SELECT d.id FROM datasets d JOIN dataset_grants g ON g.dataset_id = d.id
               WHERE g.user_id = ? AND d.account_id = ? ORDER BY d.name`,
            )
            .all(member.id, member.accountId)
    ) as { id: number }[];
    res.json(ids.map(({ id }) => toDataset(db, getDatasetRecord(db, id)!, member, false)));
  });

  router.post('/', steward, (req, res) => {
    const member = memberOf(res);
    const input = uploadSchema.parse(req.body);
    const byteSize = Buffer.byteLength(input.csv, 'utf8');
    if (byteSize > MAX_CSV_BYTES) throw new HttpError(413, 'The file is larger than 10 MB', 'csv');

    let table: ReturnType<typeof parseTable>;
    try {
      table = parseTable(input.csv);
    } catch (err) {
      if (err instanceof CsvError) throw new HttpError(400, `Could not read the CSV: ${err.message}`, 'csv');
      throw err;
    }
    if (table.header.length > MAX_COLUMNS) throw new HttpError(400, `Files can have at most ${MAX_COLUMNS} columns`, 'csv');

    const id = db.transaction(() => {
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO datasets (account_id, name, description, file_name, content, sha256, row_count, byte_size,
                                 data_tier, mask_key, uploaded_by)
           VALUES (@accountId, @name, @description, @fileName, @content, @sha256, @rowCount, @byteSize,
                   @dataTier, @maskKey, @uploadedBy)`,
        )
        .run({
          accountId: member.accountId,
          name: input.name,
          description: input.description,
          fileName: input.fileName,
          content: input.csv,
          sha256: crypto.createHash('sha256').update(input.csv).digest('hex'),
          rowCount: table.rows.length,
          byteSize,
          dataTier: input.dataTier,
          maskKey: crypto.randomBytes(32).toString('hex'),
          uploadedBy: member.id,
        });
      const datasetId = Number(lastInsertRowid);
      // Columns start at the file's classification and readable by Claude Code; the steward tightens from there.
      const insertColumn = db.prepare(
        'INSERT INTO dataset_columns (dataset_id, position, name, classification) VALUES (?, ?, ?, ?)',
      );
      table.header.forEach((name, position) => insertColumn.run(datasetId, position, name, input.dataTier));
      recordAudit(db, memberActor(member), {
        action: 'dataset.uploaded',
        entityType: 'dataset',
        entityId: datasetId,
        summary: `Uploaded dataset "${input.name}" (${input.fileName}, ${table.rows.length} rows, ${table.header.length} columns)`,
        details: { account: member.accountName, fileName: input.fileName, rows: table.rows.length, columns: table.header },
      });
      return datasetId;
    })();
    res.status(201).json(toDataset(db, getDatasetRecord(db, id)!, member, true));
  });

  router.get('/:id', anyMember, (req, res) => {
    const member = memberOf(res);
    res.json(toDataset(db, loadVisible(db, parseId(req.params.id), member), member, true));
  });

  router.patch('/:id', steward, (req, res) => {
    const member = memberOf(res);
    const before = loadStewarded(db, parseId(req.params.id), member);
    const input = updateSchema.parse(req.body);
    const beforeColumns = getColumns(db, before.id);

    const changes: Record<string, unknown> = {};
    for (const key of ['name', 'description', 'dataTier', 'claudeAccess'] as const) {
      if (input[key] !== undefined && input[key] !== before[key]) changes[key] = { from: before[key], to: input[key] };
    }
    const columnChanges: Record<string, Record<string, { from: string; to: string }>> = {};
    for (const update of input.columns ?? []) {
      const column = beforeColumns.find((c) => c.position === update.position);
      if (!column) throw new HttpError(400, `Column ${update.position} does not exist`, 'columns');
      for (const key of ['classification', 'claudeAccess', 'description'] as const) {
        const next = update[key];
        if (next !== undefined && next !== column[key]) {
          (columnChanges[column.name] ??= {})[key] = { from: column[key], to: next };
        }
      }
    }
    if (Object.keys(columnChanges).length > 0) changes.columns = columnChanges;

    if (Object.keys(changes).length > 0) {
      db.transaction(() => {
        db.prepare(
          `UPDATE datasets SET name = COALESCE(@name, name), description = COALESCE(@description, description),
             data_tier = COALESCE(@dataTier, data_tier), claude_access = COALESCE(@claudeAccess, claude_access),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = @id`,
        ).run({
          id: before.id,
          name: input.name ?? null,
          description: input.description ?? null,
          dataTier: input.dataTier ?? null,
          claudeAccess: input.claudeAccess ?? null,
        });
        const updateColumn = db.prepare(
          `UPDATE dataset_columns SET classification = COALESCE(@classification, classification),
             claude_access = COALESCE(@claudeAccess, claude_access), description = COALESCE(@description, description)
           WHERE dataset_id = @datasetId AND position = @position`,
        );
        for (const update of input.columns ?? []) {
          updateColumn.run({
            datasetId: before.id,
            position: update.position,
            classification: update.classification ?? null,
            claudeAccess: update.claudeAccess ?? null,
            description: update.description ?? null,
          });
        }
        recordAudit(db, memberActor(member), {
          action: 'dataset.policy_updated',
          entityType: 'dataset',
          entityId: before.id,
          summary: describePolicyChange(input.name ?? before.name, changes, columnChanges),
          details: changes,
        });
      })();
    }
    res.json(toDataset(db, getDatasetRecord(db, before.id)!, member, true));
  });

  router.delete('/:id', steward, (req, res) => {
    const member = memberOf(res);
    const dataset = loadStewarded(db, parseId(req.params.id), member);
    db.transaction(() => {
      db.prepare('DELETE FROM datasets WHERE id = ?').run(dataset.id);
      recordAudit(db, memberActor(member), {
        action: 'dataset.deleted',
        entityType: 'dataset',
        entityId: dataset.id,
        summary: `Deleted dataset "${dataset.name}"`,
        details: { name: dataset.name, fileName: dataset.fileName },
      });
    })();
    res.status(204).end();
  });

  // Stewards can look at the full data, or at exactly what Claude Code would get under the steward's rules.
  router.get('/:id/preview', steward, (req, res) => {
    const member = memberOf(res);
    const dataset = loadStewarded(db, parseId(req.params.id), member);
    const { view, limit } = previewSchema.parse(req.query);
    const columns = getColumns(db, dataset.id);
    const selected =
      view === 'full'
        ? columns.map((c) => ({ position: c.position, name: c.name }))
        : dataset.claudeAccess === 'blocked'
          ? []
          : columns.filter((c) => c.claudeAccess !== 'blocked');
    const { header, rows, totalRows } = projectCsv(dataset, selected, { limit });
    res.json({ columns: header, rows: selected.length ? rows : [], totalRows } satisfies DatasetPreview);
  });

  router.get('/:id/grantees', steward, (req, res) => {
    const member = memberOf(res);
    res.json(eligibleGrantees(db, loadStewarded(db, parseId(req.params.id), member)));
  });

  router.post('/:id/grants', steward, (req, res) => {
    const member = memberOf(res);
    const dataset = loadStewarded(db, parseId(req.params.id), member);
    const { userId } = grantSchema.parse(req.body);
    const grantee = eligibleGrantees(db, dataset).find((g) => g.id === userId);
    if (!grantee) {
      throw new HttpError(
        400,
        'That member cannot be given this dataset. They must be active, in this account, and have a role that can download it.',
        'userId',
      );
    }
    db.transaction(() => {
      db.prepare('INSERT INTO dataset_grants (dataset_id, user_id, granted_by) VALUES (?, ?, ?)').run(
        dataset.id,
        userId,
        member.id,
      );
      recordAudit(db, memberActor(member), {
        action: 'dataset.access_granted',
        entityType: 'dataset',
        entityId: dataset.id,
        summary: `Gave ${grantee.name} (${grantee.roleName}) access to "${dataset.name}"`,
        details: { userId, name: grantee.name, email: grantee.email },
      });
    })();
    res.status(201).json(grantsFor(db, dataset.id));
  });

  router.delete('/:id/grants/:userId', steward, (req, res) => {
    const member = memberOf(res);
    const dataset = loadStewarded(db, parseId(req.params.id), member);
    const userId = parseId(req.params.userId);
    const grant = grantsFor(db, dataset.id).find((g) => g.userId === userId);
    if (!grant) throw notFound('Grant');
    db.transaction(() => {
      db.prepare('DELETE FROM dataset_grants WHERE dataset_id = ? AND user_id = ?').run(dataset.id, userId);
      recordAudit(db, memberActor(member), {
        action: 'dataset.access_revoked',
        entityType: 'dataset',
        entityId: dataset.id,
        summary: `Removed ${grant.name}'s access to "${dataset.name}"`,
        details: { userId, name: grant.name, email: grant.email },
      });
    })();
    res.status(204).end();
  });

  router.get('/:id/download', anyMember, (req, res) => {
    const member = memberOf(res);
    const dataset = loadVisible(db, parseId(req.params.id), member);
    const check = downloadCheck(db, dataset, member);
    if (!check.allowed) throw new HttpError(403, check.reason!);

    const columns = getColumns(db, dataset.id);
    const effective = effectiveColumns(dataset, columns, member, policyNameLookup(db));
    const bundle = buildBundle(dataset, columns, effective, member, stewardOf(db, dataset.accountId));
    recordAudit(db, memberActor(member), {
      action: 'dataset.downloaded',
      entityType: 'dataset',
      entityId: dataset.id,
      summary: `Downloaded "${dataset.name}": ${bundle.summary.claudeCopy ? `Claude Code can read ${bundle.summary.claudeCopy.columns} of ${columns.length} columns` : 'Claude Code blocked from the file'}`,
      details: bundle.summary,
    });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${bundle.fileName}"`);
    res.send(Buffer.from(bundle.zip));
  });

  return router;
}

function describePolicyChange(
  name: string,
  changes: Record<string, unknown>,
  columnChanges: Record<string, Record<string, unknown>>,
): string {
  const parts: string[] = [];
  if (changes.dataTier) parts.push('file classification');
  if (changes.claudeAccess) parts.push('file Claude Code access');
  if (changes.name || changes.description) parts.push('details');
  const columnCount = Object.keys(columnChanges).length;
  if (columnCount) parts.push(`${columnCount} column${columnCount === 1 ? '' : 's'}`);
  return `Updated policy for "${name}": ${parts.join(', ')}`;
}
