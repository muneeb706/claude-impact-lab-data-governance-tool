import type { ColumnClaudeAccess, Dataset } from '../../../shared/types';

export const CLAUDE_ACCESS_LABELS: Record<ColumnClaudeAccess, string> = {
  allowed: 'Allowed',
  masked: 'Masked',
  blocked: 'Blocked',
};

export const CLAUDE_ACCESS_HINTS: Record<ColumnClaudeAccess, string> = {
  allowed: 'Claude Code reads real values',
  masked: 'Claude Code sees consistent pseudonyms',
  blocked: 'Column is removed for Claude Code',
};

export function ClaudeAccessBadge({ access }: { access: ColumnClaudeAccess }) {
  return <span className={`badge badge-claude-${access}`}>{CLAUDE_ACCESS_LABELS[access]}</span>;
}

/** "Blocked", or "4 of 6 columns (1 masked)" under the steward's rules. */
export function ClaudeAccessSummary({ dataset }: { dataset: Dataset }) {
  if (dataset.claudeAccess === 'blocked') return <ClaudeAccessBadge access="blocked" />;
  const readable = dataset.columns.filter((c) => c.claudeAccess !== 'blocked');
  const masked = readable.filter((c) => c.claudeAccess === 'masked').length;
  return (
    <span className="muted">
      {readable.length} of {dataset.columns.length} columns{masked > 0 && ` (${masked} masked)`}
    </span>
  );
}
