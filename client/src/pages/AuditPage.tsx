import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { AuditEntry, Manager } from '../../../shared/types';
import { useApi } from '../api';
import { EmptyState, ErrorBanner, Loading, PageHeader } from '../components/ui';
import { formatDateTime } from '../format';

const FILTERS = [
  { value: '', label: 'All' },
  { value: 'account', label: 'Accounts' },
  { value: 'role', label: 'Roles' },
  { value: 'user', label: 'Members' },
  { value: 'policy', label: 'Policies' },
  { value: 'manager', label: 'Managers' },
];

export default function AuditPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const entityType = searchParams.get('type') ?? '';
  const actorId = searchParams.get('actor') ?? '';
  const [expanded, setExpanded] = useState<number | null>(null);
  const managers = useApi<Manager[]>('/managers');

  const query = new URLSearchParams({ limit: '200' });
  if (entityType) query.set('entityType', entityType);
  if (actorId) query.set('actorId', actorId);
  const { data, error, loading } = useApi<AuditEntry[]>(`/audit?${query}`);

  function setFilter(key: 'type' | 'actor', value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  }

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every change to accounts, roles, members, policies and managers, with the account manager who made it. Newest first."
      />
      <div className="toolbar">
        <div className="segmented" role="tablist" aria-label="Filter by type">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              role="tab"
              aria-selected={entityType === f.value}
              className={entityType === f.value ? 'active' : undefined}
              onClick={() => setFilter('type', f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <select
          aria-label="Filter by account manager"
          className="toolbar-select"
          value={actorId}
          onChange={(e) => setFilter('actor', e.target.value)}
        >
          <option value="">All account managers</option>
          {managers.data?.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
      <ErrorBanner message={error} />
      {loading && !data ? (
        <Loading />
      ) : data && data.length === 0 ? (
        <EmptyState title="Nothing recorded">No changes match these filters yet.</EmptyState>
      ) : (
        data && (
          <div className="card table-card">
            <table className="table audit-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Changed by</th>
                  <th>Action</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {data.map((entry) => (
                  <AuditRow
                    key={entry.id}
                    entry={entry}
                    expanded={expanded === entry.id}
                    onToggle={() => setExpanded(expanded === entry.id ? null : entry.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </>
  );
}

function AuditRow({ entry, expanded, onToggle }: { entry: AuditEntry; expanded: boolean; onToggle: () => void }) {
  const hasDetails = Object.keys(entry.details).length > 0;
  return (
    <>
      <tr className={hasDetails ? 'clickable' : undefined} onClick={hasDetails ? onToggle : undefined}>
        <td className="muted nowrap">{formatDateTime(entry.createdAt)}</td>
        <td>
          <div className="row-title">{entry.actor}</div>
          {entry.actorEmail && <div className="row-sub">{entry.actorEmail}</div>}
        </td>
        <td>
          <code className={`action action-${entry.action.split('.')[1]}`}>{entry.action}</code>
        </td>
        <td>
          {entry.summary}
          {hasDetails && <span className="expand-hint">{expanded ? ' ▾' : ' ▸'}</span>}
        </td>
      </tr>
      {expanded && (
        <tr className="audit-details">
          <td colSpan={4}>
            <pre>{JSON.stringify(entry.details, null, 2)}</pre>
          </td>
        </tr>
      )}
    </>
  );
}
