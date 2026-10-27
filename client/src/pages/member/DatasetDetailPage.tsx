import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  COLUMN_CLAUDE_ACCESS,
  DATA_TIERS,
  type ColumnClaudeAccess,
  type DataTier,
  type Dataset,
  type DatasetColumn,
  type DatasetPreview,
  type FileClaudeAccess,
  type Grantee,
} from '../../../../shared/types';
import { api, errorMessage, useApi } from '../../api';
import { hasPolicy, useMember } from '../../auth';
import { CLAUDE_ACCESS_HINTS, CLAUDE_ACCESS_LABELS, ClaudeAccessBadge } from '../../components/datasets';
import { ConfirmButton, ErrorBanner, Loading, PageHeader, TierBadge } from '../../components/ui';
import { formatDate, plural } from '../../format';

const tierLabel = (tier: DataTier) => tier[0].toUpperCase() + tier.slice(1);

export default function DatasetDetailPage() {
  const id = Number(useParams().id);
  const member = useMember();
  const dataset = useApi<Dataset>(`/datasets/${id}`);

  if (dataset.error) return <ErrorBanner message={dataset.error} />;
  if (!dataset.data) return <Loading />;
  const isSteward = hasPolicy(member, 'data.steward') && dataset.data.accountId === member.accountId;
  return isSteward ? (
    <StewardView key={dataset.data.updatedAt} dataset={dataset.data} reload={dataset.reload} />
  ) : (
    <ScientistView dataset={dataset.data} />
  );
}

function DatasetHeader({ dataset, actions }: { dataset: Dataset; actions?: ReactNode }) {
  return (
    <PageHeader
      eyebrow={
        <>
          <Link to="/datasets">Datasets</Link> /
        </>
      }
      title={
        <span className="title-with-badge">
          {dataset.name} <TierBadge tier={dataset.dataTier} />
        </span>
      }
      description={
        <>
          {dataset.description && <span className="block">{dataset.description}</span>}
          <span className="muted">
            {dataset.fileName} · {plural(dataset.rowCount, 'row')} · {plural(dataset.columns.length, 'column')}
            {dataset.uploadedBy && ` · uploaded by ${dataset.uploadedBy} on ${formatDate(dataset.createdAt)}`}
          </span>
        </>
      }
      actions={actions}
    />
  );
}

function DownloadButton({ dataset }: { dataset: Dataset }) {
  if (!dataset.download?.allowed) {
    return (
      <button className="btn" disabled title={dataset.download?.reason}>
        Download unavailable
      </button>
    );
  }
  return (
    <a className="btn btn-primary" href={`/api/datasets/${dataset.id}/download`} download>
      Download for Claude Code
    </a>
  );
}

// ---------- Data steward ----------

type ColumnDraft = Pick<DatasetColumn, 'classification' | 'claudeAccess' | 'description'>;

const draftsOf = (dataset: Dataset): ColumnDraft[] =>
  dataset.columns.map(({ classification, claudeAccess, description }) => ({
    classification,
    claudeAccess,
    description,
  }));

function StewardView({ dataset, reload }: { dataset: Dataset; reload: () => Promise<void> }) {
  const navigate = useNavigate();
  const [dataTier, setDataTier] = useState<DataTier>(dataset.dataTier);
  const [fileAccess, setFileAccess] = useState<FileClaudeAccess>(dataset.claudeAccess);
  const [columns, setColumns] = useState<ColumnDraft[]>(() => draftsOf(dataset));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const changedColumns = dataset.columns
    .map((original, i) => ({ position: original.position, original, draft: columns[i] }))
    .filter(({ original, draft }) =>
      (['classification', 'claudeAccess', 'description'] as const).some((k) => original[k] !== draft[k]),
    );
  const dirty = dataTier !== dataset.dataTier || fileAccess !== dataset.claudeAccess || changedColumns.length > 0;

  const counts = COLUMN_CLAUDE_ACCESS.map(
    (access) => [access, columns.filter((c) => c.claudeAccess === access).length] as const,
  );

  function discard() {
    setDataTier(dataset.dataTier);
    setFileAccess(dataset.claudeAccess);
    setColumns(draftsOf(dataset));
    setError(null);
  }

  function updateColumn(index: number, patch: Partial<ColumnDraft>) {
    setColumns((current) => current.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/datasets/${dataset.id}`, {
        dataTier,
        claudeAccess: fileAccess,
        columns: changedColumns.map(({ position, draft }) => ({ position, ...draft })),
      });
      await reload();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  async function remove() {
    try {
      await api.delete(`/datasets/${dataset.id}`);
      navigate('/datasets');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="steward-view">
      <DatasetHeader
        dataset={dataset}
        actions={
          <>
            <DownloadButton dataset={dataset} />
            <ConfirmButton onConfirm={remove} confirmLabel="Delete dataset?">
              Delete
            </ConfirmButton>
          </>
        }
      />

      <section className="card policy-card">
        <div className="card-header">
          <div>
            <h2>File policy</h2>
            <p className="muted">
              Applies to the whole file. Members need to be able to read this classification to download it.
            </p>
          </div>
        </div>
        <div className="policy-card-body">
          <label className="field">
            <span className="field-label">Classification</span>
            <select value={dataTier} onChange={(e) => setDataTier(e.target.value as DataTier)}>
              {DATA_TIERS.map((tier) => (
                <option key={tier} value={tier}>
                  {tierLabel(tier)}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span className="field-label">Claude Code</span>
            <div className="segmented segmented-fill" role="radiogroup" aria-label="Claude Code access to this file">
              {(['allowed', 'blocked'] as const).map((access) => (
                <button
                  key={access}
                  type="button"
                  role="radio"
                  aria-checked={fileAccess === access}
                  className={fileAccess === access ? `active claude-${access}` : undefined}
                  onClick={() => setFileAccess(access)}
                >
                  {access === 'allowed' ? 'Allowed, by column' : 'Blocked for the whole file'}
                </button>
              ))}
            </div>
            <span className="field-hint">
              {fileAccess === 'allowed'
                ? 'Claude Code gets the columns you allow or mask below.'
                : 'Downloads contain no Claude Code copy at all, whatever the column settings.'}
            </span>
          </div>
        </div>
      </section>

      <div className="section-header">
        <div>
          <h2>Column policies</h2>
          <p className="muted">
            Classification decides which members get a column in their own copy. Claude Code access decides what Claude
            Code gets, and members also need their role to allow cloud AI for that classification.
          </p>
        </div>
      </div>
      <div className={`card table-card${fileAccess === 'blocked' ? ' dimmed-claude' : ''}`}>
        <table className="table column-table">
          <thead>
            <tr>
              <th>Column</th>
              <th>Classification</th>
              <th>Claude Code</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {dataset.columns.map((column, i) => (
              <tr key={column.position}>
                <td>
                  <div className="row-title mono">{column.name}</div>
                  {column.samples && column.samples.length > 0 && (
                    <div className="row-sub samples" title={column.samples.join(', ')}>
                      e.g. {column.samples.join(', ')}
                    </div>
                  )}
                </td>
                <td>
                  <select
                    aria-label={`Classification for ${column.name}`}
                    value={columns[i].classification}
                    onChange={(e) => updateColumn(i, { classification: e.target.value as DataTier })}
                  >
                    {DATA_TIERS.map((tier) => (
                      <option key={tier} value={tier}>
                        {tierLabel(tier)}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <div className="segmented" role="radiogroup" aria-label={`Claude Code access for ${column.name}`}>
                    {COLUMN_CLAUDE_ACCESS.map((access) => (
                      <button
                        key={access}
                        type="button"
                        role="radio"
                        aria-checked={columns[i].claudeAccess === access}
                        title={CLAUDE_ACCESS_HINTS[access]}
                        className={columns[i].claudeAccess === access ? `active claude-${access}` : undefined}
                        onClick={() => updateColumn(i, { claudeAccess: access })}
                      >
                        {CLAUDE_ACCESS_LABELS[access]}
                      </button>
                    ))}
                  </div>
                </td>
                <td>
                  <input
                    aria-label={`Description for ${column.name}`}
                    value={columns[i].description}
                    onChange={(e) => updateColumn(i, { description: e.target.value })}
                    maxLength={300}
                    placeholder="Optional"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {dirty && (
        <div className="save-bar">
          <div className="save-bar-summary">
            <strong>Unsaved policy changes</strong>
            <span className="muted">
              {fileAccess === 'blocked'
                ? 'Claude Code will be blocked from the whole file'
                : `Claude Code: ${counts.map(([access, n]) => `${n} ${CLAUDE_ACCESS_LABELS[access].toLowerCase()}`).join(', ')}`}
            </span>
            {error && <span className="save-bar-error">{error}</span>}
          </div>
          <div className="form-actions">
            <button type="button" className="btn" onClick={discard}>
              Discard
            </button>
            <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save policy'}
            </button>
          </div>
        </div>
      )}
      {!dirty && <ErrorBanner message={error} />}

      <Preview datasetId={dataset.id} />
      <AccessCard dataset={dataset} onChange={reload} />
    </div>
  );
}

function Preview({ datasetId }: { datasetId: number }) {
  const [view, setView] = useState<'full' | 'claude'>('full');
  const { data, error } = useApi<DatasetPreview>(`/datasets/${datasetId}/preview?view=${view}&limit=25`);
  return (
    <section className="card preview-card">
      <div className="card-header">
        <div>
          <h2>Preview</h2>
          <p className="muted">
            {view === 'full'
              ? 'The data as uploaded.'
              : 'What Claude Code gets under your saved policy, before each member’s role is applied.'}
            {data && ` First ${Math.min(25, data.totalRows)} of ${plural(data.totalRows, 'row')}.`}
          </p>
        </div>
        <div className="segmented" role="tablist" aria-label="Preview">
          <button
            role="tab"
            aria-selected={view === 'full'}
            className={view === 'full' ? 'active' : undefined}
            onClick={() => setView('full')}
          >
            Full data
          </button>
          <button
            role="tab"
            aria-selected={view === 'claude'}
            className={view === 'claude' ? 'active' : undefined}
            onClick={() => setView('claude')}
          >
            Claude Code view
          </button>
        </div>
      </div>
      <ErrorBanner message={error} />
      {data &&
        (data.columns.length === 0 ? (
          <p className="preview-empty muted">Claude Code gets no data from this file.</p>
        ) : (
          <div className="preview-scroll">
            <table className="table preview-table">
              <thead>
                <tr>
                  {data.columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((value, c) => (
                      <td key={c} className={value.startsWith('MASK_') ? 'masked-value' : undefined}>
                        {value}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}

function AccessCard({ dataset, onChange }: { dataset: Dataset; onChange: () => Promise<void> }) {
  const grantees = useApi<Grantee[]>(`/datasets/${dataset.id}/grantees`);
  const [selected, setSelected] = useState<number | ''>('');
  const [error, setError] = useState<string | null>(null);

  async function grant() {
    if (!selected) return;
    setError(null);
    try {
      await api.post(`/datasets/${dataset.id}/grants`, { userId: selected });
      setSelected('');
      await Promise.all([onChange(), grantees.reload()]);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function revoke(userId: number) {
    setError(null);
    try {
      await api.delete(`/datasets/${dataset.id}/grants/${userId}`);
      await Promise.all([onChange(), grantees.reload()]);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2>Access</h2>
          <p className="muted">
            Members you share this with can download it. Only active members whose role includes "Download granted
            datasets" and can read {dataset.dataTier} data are listed.
          </p>
        </div>
      </div>
      <div className="grant-form">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value ? Number(e.target.value) : '')}
          aria-label="Member to share with"
        >
          <option value="">{grantees.data?.length ? 'Choose a member…' : 'No other eligible members'}</option>
          {grantees.data?.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} ({g.roleName})
            </option>
          ))}
        </select>
        <button className="btn btn-primary" onClick={grant} disabled={!selected}>
          Share
        </button>
      </div>
      <ErrorBanner message={error ?? grantees.error} />
      {dataset.grants && dataset.grants.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th>Member</th>
              <th>Role</th>
              <th>Shared</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {dataset.grants.map((g) => (
              <tr key={g.userId}>
                <td>
                  <div className="row-title">{g.name}</div>
                  <div className="row-sub">{g.email}</div>
                </td>
                <td>{g.roleName}</td>
                <td className="muted">
                  {formatDate(g.createdAt)}
                  {g.grantedBy && ` by ${g.grantedBy}`}
                </td>
                <td>
                  <div className="row-actions">
                    <ConfirmButton
                      className="btn btn-small btn-danger-ghost"
                      confirmLabel="Remove?"
                      onConfirm={() => revoke(g.userId)}
                    >
                      Remove access
                    </ConfirmButton>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="card-empty muted">Not shared with anyone yet.</p>
      )}
    </section>
  );
}

// ---------- Research scientist ----------

function ScientistView({ dataset }: { dataset: Dataset }) {
  const effective = dataset.effective ?? [];
  const yours = effective.filter((c) => c.inYourCopy).length;
  const count = (access: ColumnClaudeAccess) => effective.filter((c) => c.claudeAccess === access).length;
  const folder = dataset.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  return (
    <>
      <DatasetHeader dataset={dataset} actions={<DownloadButton dataset={dataset} />} />
      {!dataset.download?.allowed && <div className="banner banner-error">{dataset.download?.reason}</div>}

      <div className="stat-row">
        <div className="card stat">
          <div className="stat-label">Your copy</div>
          <div className="stat-value">{plural(yours, 'column')}</div>
          <div className="stat-note muted">For you only. Claude Code is blocked from it.</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Claude Code</div>
          <div className="stat-value">
            {count('allowed') + count('masked') === 0
              ? 'No access'
              : `${plural(count('allowed') + count('masked'), 'column')}`}
          </div>
          <div className="stat-note muted">
            {count('masked') > 0 && `${count('masked')} masked · `}
            {count('blocked')} withheld
          </div>
        </div>
      </div>

      <div className="section-header">
        <div>
          <h2>Column policy for you</h2>
          <p className="muted">The data steward's policy for each column, combined with what your role allows.</p>
        </div>
      </div>
      <div className="card table-card">
        <table className="table">
          <thead>
            <tr>
              <th>Column</th>
              <th>Classification</th>
              <th>In your copy</th>
              <th>Claude Code</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {effective.map((c) => (
              <tr key={c.name}>
                <td className="row-title mono">{c.name}</td>
                <td>
                  <TierBadge tier={c.classification} />
                </td>
                <td>{c.inYourCopy ? 'Yes' : <span className="muted">No</span>}</td>
                <td>
                  <ClaudeAccessBadge access={c.claudeAccess} />
                </td>
                <td className="muted">{c.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="card how-to">
        <h2>Using it with Claude Code</h2>
        <ol>
          <li>Download and unzip the file.</li>
          <li>
            Start Claude Code from the unzipped folder, so it picks up the folder's settings:
            <pre>{`cd ${folder}\nclaude`}</pre>
          </li>
          <li>
            Ask Claude about the data. It works from <code>claude-data/</code>; your full copy in{' '}
            <code>restricted-data/</code> stays off limits.
          </li>
        </ol>
        <p className="muted">
          The folder's settings block Claude Code's file tools from <code>restricted-data/</code>, run its shell
          commands in a sandbox that can't read it, and check every tool call with a hook. Details are in the README
          inside the download.
        </p>
      </section>
    </>
  );
}
