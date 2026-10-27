import crypto from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import type {
  ColumnClaudeAccess,
  DataTier,
  DatasetColumn,
  EffectiveColumn,
  FileClaudeAccess,
  MemberSession,
} from '../../shared/types';
import { parseTable, toCsv } from './csv';
import type { DB } from './db';

/** A dataset as stored, including its CSV content. */
export interface DatasetRecord {
  id: number;
  accountId: number;
  accountName: string;
  name: string;
  description: string;
  fileName: string;
  content: string;
  sha256: string;
  rowCount: number;
  byteSize: number;
  dataTier: DataTier;
  claudeAccess: FileClaudeAccess;
  maskKey: string;
  uploadedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export const RESTRICTED_DIR = 'restricted-data';
export const CLAUDE_DIR = 'claude-data';
export const MASK_PREFIX = 'MASK_';

// Using a column's data with Claude Code needs the AI policy for that column's classification.
const AI_POLICY_FOR_TIER: Record<DataTier, string> = {
  public: 'ai.cloud.public',
  internal: 'ai.cloud.internal_scrubbed',
  restricted: 'ai.cloud.restricted',
};

export function getDatasetRecord(db: DB, id: number): DatasetRecord | undefined {
  return db
    .prepare(
      `SELECT d.id, d.account_id AS accountId, a.name AS accountName, d.name, d.description, d.file_name AS fileName,
              d.content, d.sha256, d.row_count AS rowCount, d.byte_size AS byteSize, d.data_tier AS dataTier,
              d.claude_access AS claudeAccess, d.mask_key AS maskKey, u.name AS uploadedBy,
              d.created_at AS createdAt, d.updated_at AS updatedAt
       FROM datasets d JOIN accounts a ON a.id = d.account_id LEFT JOIN users u ON u.id = d.uploaded_by
       WHERE d.id = ?`,
    )
    .get(id) as DatasetRecord | undefined;
}

export function getColumns(db: DB, datasetId: number): DatasetColumn[] {
  return db
    .prepare(
      `SELECT position, name, classification, claude_access AS claudeAccess, description
       FROM dataset_columns WHERE dataset_id = ? ORDER BY position`,
    )
    .all(datasetId) as DatasetColumn[];
}

const has = (member: MemberSession, code: string) => member.policyCodes.includes(code);
export const canRead = (member: MemberSession, tier: DataTier) => has(member, `data.${tier}.read`);
export const isStewardOf = (member: MemberSession, accountId: number) =>
  has(member, 'data.steward') && member.accountId === accountId;

/**
 * Works out, column by column, what a member gets when they download:
 * their own copy holds the columns their role can read; Claude Code gets the subset the
 * steward allowed or masked, and only if the member's role allows cloud AI for that classification.
 */
export function effectiveColumns(
  dataset: Pick<DatasetRecord, 'claudeAccess'>,
  columns: DatasetColumn[],
  member: MemberSession,
  policyName: (code: string) => string,
): EffectiveColumn[] {
  return columns.map((column) => {
    const base = { name: column.name, classification: column.classification };
    const blocked = (inYourCopy: boolean, reason: string): EffectiveColumn => ({
      ...base,
      inYourCopy,
      claudeAccess: 'blocked',
      reason,
    });

    if (!canRead(member, column.classification)) {
      return blocked(false, `Your role can't read ${column.classification} data, so this column isn't in your download.`);
    }
    if (dataset.claudeAccess === 'blocked') {
      return blocked(true, 'The data steward blocked Claude Code from this whole file.');
    }
    if (column.claudeAccess === 'blocked') {
      return blocked(true, 'The data steward blocked this column for Claude Code.');
    }
    const aiPolicy = AI_POLICY_FOR_TIER[column.classification];
    if (!has(member, aiPolicy)) {
      return blocked(
        true,
        `Your role doesn't include "${policyName(aiPolicy)}", which is needed to use ${column.classification} data with Claude Code.`,
      );
    }
    if (column.claudeAccess === 'masked') {
      return {
        ...base,
        inYourCopy: true,
        claudeAccess: 'masked',
        reason: 'Claude Code sees consistent pseudonyms instead of real values.',
      };
    }
    return { ...base, inYourCopy: true, claudeAccess: 'allowed', reason: 'Claude Code can read this column.' };
  });
}

/** The same value in the same column always gets the same token, so Claude Code can still group and join. */
export function maskValue(maskKey: string, column: string, value: string): string {
  if (value === '') return '';
  const digest = crypto.createHmac('sha256', maskKey).update(`${column}\u0000${value}`).digest('hex');
  return MASK_PREFIX + digest.slice(0, 10);
}

/** Builds a CSV from selected columns, masking where asked. */
export function projectCsv(
  dataset: Pick<DatasetRecord, 'content' | 'maskKey'>,
  selected: { position: number; name: string; claudeAccess?: ColumnClaudeAccess }[],
  options: { limit?: number } = {},
): { header: string[]; rows: string[][]; csv: string; totalRows: number } {
  const table = parseTable(dataset.content);
  const sourceRows = options.limit === undefined ? table.rows : table.rows.slice(0, options.limit);
  const header = selected.map((c) => c.name);
  const rows = sourceRows.map((row) =>
    selected.map((c) => (c.claudeAccess === 'masked' ? maskValue(dataset.maskKey, c.name, row[c.position]) : row[c.position])),
  );
  return { header, rows, csv: toCsv([header, ...rows]), totalRows: table.rows.length };
}

const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

export function slugify(text: string, fallback: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

function baseFileName(fileName: string): string {
  const withoutExt = fileName.replace(/\.csv$/i, '');
  return withoutExt.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'data';
}

// ---------- Download bundle ----------

export interface Bundle {
  fileName: string;
  zip: Uint8Array;
  summary: {
    folder: string;
    yourCopy: { path: string; columns: number; sha256: string };
    claudeCopy: { path: string; columns: number; masked: number; sha256: string } | null;
    blockedForClaude: string[];
  };
}

export function buildBundle(
  dataset: DatasetRecord,
  columns: DatasetColumn[],
  effective: EffectiveColumn[],
  member: MemberSession,
  steward: string | null,
  issuedAt: Date = new Date(),
): Bundle {
  const folder = slugify(dataset.name, `dataset-${dataset.id}`);
  const base = baseFileName(dataset.fileName);
  const yourPath = `${RESTRICTED_DIR}/${base}.restricted.csv`;
  const claudePath = `${CLAUDE_DIR}/${base}.claude.csv`;

  const withPolicy = columns.map((column, i) => ({ ...column, effective: effective[i] }));
  // The researcher's own copy always has real values; masking applies only to Claude Code's copy.
  const yourColumns = withPolicy
    .filter((c) => c.effective.inYourCopy)
    .map((c) => ({ position: c.position, name: c.name }));
  const claudeColumns = withPolicy
    .filter((c) => c.effective.claudeAccess !== 'blocked')
    .map((c) => ({ ...c, claudeAccess: c.effective.claudeAccess }));
  const blockedForClaude = withPolicy.filter((c) => c.effective.claudeAccess === 'blocked').map((c) => c.name);

  const yourCsv = projectCsv(dataset, yourColumns).csv;
  const claudeCsv = claudeColumns.length > 0 ? projectCsv(dataset, claudeColumns).csv : null;
  const masked = claudeColumns.filter((c) => c.claudeAccess === 'masked').length;

  const summary: Bundle['summary'] = {
    folder,
    yourCopy: { path: yourPath, columns: yourColumns.length, sha256: sha256(yourCsv) },
    claudeCopy: claudeCsv
      ? { path: claudePath, columns: claudeColumns.length, masked, sha256: sha256(claudeCsv) }
      : null,
    blockedForClaude,
  };

  const policy = {
    $comment:
      'Generated by Data Governance. Describes what this download contains and what Claude Code may read. Do not edit.',
    formatVersion: 1,
    dataset: {
      id: dataset.id,
      name: dataset.name,
      description: dataset.description,
      account: dataset.accountName,
      classification: dataset.dataTier,
      steward,
      policyUpdatedAt: dataset.updatedAt,
    },
    issuedTo: { name: member.name, email: member.email, role: member.roleName },
    issuedAt: issuedAt.toISOString(),
    claudeCode: {
      fileAccess: claudeCsv ? 'allowed' : 'blocked',
      readable: claudeCsv ? [claudePath] : [],
      blocked: [`${RESTRICTED_DIR}/`, '*.restricted.csv'],
      maskedValuePrefix: MASK_PREFIX,
    },
    columns: withPolicy.map((c) => ({
      name: c.name,
      classification: c.classification,
      description: c.description,
      inYourCopy: c.effective.inYourCopy,
      claudeCode: c.effective.claudeAccess,
      reason: c.effective.reason,
    })),
    files: [
      { path: yourPath, audience: 'researcher', rows: dataset.rowCount, columns: yourColumns.length, sha256: summary.yourCopy.sha256 },
      ...(claudeCsv
        ? [{ path: claudePath, audience: 'claude-code', rows: dataset.rowCount, columns: claudeColumns.length, sha256: summary.claudeCopy!.sha256 }]
        : []),
    ],
  };

  const files: Record<string, string> = {
    'README.md': readme(dataset, member, steward, issuedAt, folder, summary, withPolicy),
    'CLAUDE.md': claudeMd(dataset, steward, summary),
    'data-policy.json': JSON.stringify(policy, null, 2) + '\n',
    '.claude/settings.json': JSON.stringify(CLAUDE_SETTINGS, null, 2) + '\n',
    '.claude/hooks/enforce-data-policy.sh': HOOK_SCRIPT,
    [yourPath]: yourCsv,
  };
  if (claudeCsv) files[claudePath] = claudeCsv;

  const zip = zipSync(
    Object.fromEntries(Object.entries(files).map(([path, text]) => [`${folder}/${path}`, strToU8(text)])),
    { level: 6, mtime: issuedAt },
  );
  return { fileName: `${folder}.zip`, zip, summary };
}

// Project settings Claude Code applies when started in the bundle folder. Three layers:
// deny rules (file tools and simple shell reads), the OS-level Bash sandbox, and a hook on every tool call.
export const CLAUDE_SETTINGS = {
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  permissions: {
    deny: [
      `Read(/${RESTRICTED_DIR}/**)`,
      `Edit(/${RESTRICTED_DIR}/**)`,
      'Read(*.restricted.csv)',
      'Edit(*.restricted.csv)',
    ],
    disableBypassPermissionsMode: 'disable',
  },
  sandbox: {
    enabled: true,
    allowUnsandboxedCommands: false,
    filesystem: { denyRead: [`./${RESTRICTED_DIR}`] },
  },
  hooks: {
    PreToolUse: [
      {
        matcher: '*',
        hooks: [{ type: 'command', command: 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/enforce-data-policy.sh"' }],
      },
    ],
  },
};

// Matches the folder name only when followed by a path separator, quote, whitespace, shell operator or end,
// so a parent folder such as "restricted-data-export" doesn't trip it.
export const HOOK_SCRIPT = `#!/usr/bin/env bash
# Generated by Data Governance. Do not edit.
# Claude Code sends every tool call to this script as JSON on stdin before running it.
# Exit code 2 blocks the call and shows Claude the message printed to stderr.
if grep -Eq '${RESTRICTED_DIR}([/\\\\" ;&|)]|$)|\\.restricted\\.csv'; then
  echo "Blocked by this folder's data policy: ${RESTRICTED_DIR}/ and *.restricted.csv files are for the researcher only. Use the files in ${CLAUDE_DIR}/ instead." >&2
  exit 2
fi
exit 0
`;

function claudeMd(dataset: DatasetRecord, steward: string | null, summary: Bundle['summary']): string {
  const lines = [
    '# Data policy for this folder',
    '',
    `This folder holds "${dataset.name}" from ${dataset.accountName}${steward ? `, governed by data steward ${steward}` : ''}.`,
    '',
  ];
  if (summary.claudeCopy) {
    lines.push(
      `- Use only \`${summary.claudeCopy.path}\` for analysis.`,
      `- Never read, copy, search, or write code that opens anything in \`${RESTRICTED_DIR}/\` or any file ending in \`.restricted.csv\`. Those files are for the researcher only, and the tools here block attempts.`,
    );
    if (summary.claudeCopy.masked > 0) {
      lines.push(
        `- Values starting with \`${MASK_PREFIX}\` are pseudonyms. The same real value always gets the same pseudonym in this dataset, so you can group and join on them. Don't try to reverse them.`,
      );
    }
  } else {
    lines.push(
      '- The data steward has not allowed Claude Code to read any data in this folder.',
      `- Never read, copy, search, or write code that opens anything in \`${RESTRICTED_DIR}/\` or any file ending in \`.restricted.csv\`. The tools here block attempts.`,
    );
  }
  if (summary.blockedForClaude.length > 0) {
    lines.push(
      `- These columns are withheld from you: ${summary.blockedForClaude.map((c) => `\`${c}\``).join(', ')}. If a question needs them, say so and suggest the researcher handle that part.`,
    );
  }
  lines.push('- The full policy, column by column, is in `data-policy.json`.', '');
  return lines.join('\n');
}

const ACCESS_LABEL: Record<ColumnClaudeAccess, string> = { allowed: 'Allowed', masked: 'Masked', blocked: 'Blocked' };

function readme(
  dataset: DatasetRecord,
  member: MemberSession,
  steward: string | null,
  issuedAt: Date,
  folder: string,
  summary: Bundle['summary'],
  columns: (DatasetColumn & { effective: EffectiveColumn })[],
): string {
  const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    `# ${dataset.name}`,
    '',
    `Issued to ${member.name} (${member.email}, ${member.roleName}) on ${issuedAt.toISOString().slice(0, 10)}, from ${dataset.accountName}.`,
    `Classification: ${dataset.dataTier.toUpperCase()}.${steward ? ` Data steward: ${steward}.` : ''}`,
    '',
    dataset.description,
    '',
    '## What is in this folder',
    '',
    '| Path | For | Columns |',
    '| --- | --- | --- |',
    `| \`${summary.yourCopy.path}\` | You only. Claude Code is blocked from reading it. | ${summary.yourCopy.columns} |`,
    summary.claudeCopy
      ? `| \`${summary.claudeCopy.path}\` | Claude Code (and you) | ${summary.claudeCopy.columns}${summary.claudeCopy.masked ? ` (${summary.claudeCopy.masked} masked)` : ''} |`
      : '| (no Claude Code copy) | The data steward blocked Claude Code from this file. | 0 |',
    '| `data-policy.json` | Machine-readable policy for this download | |',
    '| `CLAUDE.md` | Instructions Claude Code reads at the start of every session | |',
    '| `.claude/` | Claude Code settings that enforce the policy | |',
    '',
    '## Column policy',
    '',
    '| Column | Classification | In your copy | Claude Code | Why |',
    '| --- | --- | --- | --- | --- |',
    ...columns.map(
      (c) =>
        `| ${cell(c.name)} | ${c.classification} | ${c.effective.inYourCopy ? 'Yes' : 'No'} | ${ACCESS_LABEL[c.effective.claudeAccess]} | ${cell(c.effective.reason)} |`,
    ),
    '',
    '## Using this data with Claude Code',
    '',
    '1. Unzip, then start Claude Code from this folder:',
    '',
    '   ```',
    `   cd ${folder}`,
    '   claude',
    '   ```',
    '',
    '   Claude Code only applies `.claude/settings.json` from the folder it starts in. If you start it somewhere else, the protections below do not apply.',
    `2. Keep the files in \`${RESTRICTED_DIR}/\` where they are. Copying them into another project leaves the protections behind.`,
    '',
    '## How the policy is enforced',
    '',
    `- **Permission deny rules** stop Claude Code's file tools (Read, Grep, Glob, Edit) and shell commands such as \`cat\` and \`head\` from opening \`${RESTRICTED_DIR}/\` or any \`*.restricted.csv\` file.`,
    `- **The Bash sandbox** blocks every command Claude runs, and any program those commands start (Python, R, Node), from reading \`${RESTRICTED_DIR}/\`. It works on macOS, Linux and WSL2; Linux and WSL2 need \`bubblewrap\` and \`socat\` installed.`,
    `- **A hook** (\`.claude/hooks/enforce-data-policy.sh\`) rejects any tool call that mentions \`${RESTRICTED_DIR}/\` or a \`.restricted.csv\` file. It needs \`bash\` and \`grep\`.`,
    '- **Bypass permissions mode is disabled** in this folder.',
    '',
    'These protections keep data away from Claude Code. They do not restrict you: you can open every file in this folder yourself.',
    '',
  ];
  return lines.join('\n');
}
