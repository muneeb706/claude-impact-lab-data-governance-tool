import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { DATA_TIERS, type DataTier, type Dataset } from '../../../../shared/types';
import { api, ApiRequestError, errorMessage, useApi } from '../../api';
import { hasPolicy, useMember } from '../../auth';
import { ClaudeAccessSummary } from '../../components/datasets';
import { EmptyState, ErrorBanner, Field, Loading, PageHeader, TierBadge } from '../../components/ui';
import { formatDate } from '../../format';

const MAX_BYTES = 10 * 1024 * 1024;

export default function DatasetsPage() {
  const member = useMember();
  const isSteward = hasPolicy(member, 'data.steward');
  const canDownload = hasPolicy(member, 'data.download');
  const { data: datasets, error, loading } = useApi<Dataset[]>(isSteward || canDownload ? '/datasets' : null);
  const [uploading, setUploading] = useState(false);

  if (!isSteward && !canDownload) {
    return (
      <>
        <PageHeader title="Datasets" />
        <EmptyState title="No dataset access">
          Your role ({member.roleName}) doesn't include any dataset policies. Ask an account manager if you need access.
        </EmptyState>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Datasets"
        description={
          isSteward
            ? `CSV files owned by ${member.accountName}. Decide who can see each column and what Claude Code may read, then share them with research scientists.`
            : 'Datasets a data steward has shared with you. Each download includes the data policy and the Claude Code settings that enforce it.'
        }
        actions={
          isSteward &&
          !uploading && (
            <button className="btn btn-primary" onClick={() => setUploading(true)}>
              Upload CSV
            </button>
          )
        }
      />
      {uploading && <UploadForm onCancel={() => setUploading(false)} />}
      <ErrorBanner message={error} />
      {loading && !datasets ? (
        <Loading />
      ) : datasets && datasets.length === 0 ? (
        !uploading && (
          <EmptyState title={isSteward ? 'No datasets yet' : 'Nothing shared with you yet'}>
            {isSteward ? (
              <button className="btn btn-primary" onClick={() => setUploading(true)}>
                Upload the first CSV
              </button>
            ) : (
              'When a data steward shares a dataset with you, it appears here.'
            )}
          </EmptyState>
        )
      ) : (
        datasets && (
          <div className="card table-card">
            <table className="table">
              <thead>
                <tr>
                  <th>Dataset</th>
                  <th>Classification</th>
                  <th>Claude Code</th>
                  {isSteward && <th className="num">Shared with</th>}
                  <th className="num">Rows</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {datasets.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <Link to={`/datasets/${d.id}`} className="row-title">
                        {d.name}
                      </Link>
                      <div className="row-sub">{d.fileName}</div>
                    </td>
                    <td>
                      <TierBadge tier={d.dataTier} />
                    </td>
                    <td>
                      <ClaudeAccessSummary dataset={d} />
                    </td>
                    {isSteward && <td className="num">{d.grants?.length ?? 0}</td>}
                    <td className="num">{d.rowCount.toLocaleString()}</td>
                    <td className="muted">{formatDate(d.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </>
  );
}

function UploadForm({ onCancel }: { onCancel: () => void }) {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [dataTier, setDataTier] = useState<DataTier>('internal');
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  function chooseFile(next: File | null) {
    setFile(next);
    setError(null);
    if (next && !name) setName(next.name.replace(/\.csv$/i, '').replace(/[_-]+/g, ' '));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) return setError({ message: 'Choose a CSV file', field: 'csv' });
    if (file.size > MAX_BYTES) return setError({ message: 'The file is larger than 10 MB', field: 'csv' });
    setSaving(true);
    try {
      const csv = await file.text();
      const dataset = await api.post<Dataset>('/datasets', { name, description, fileName: file.name, csv, dataTier });
      navigate(`/datasets/${dataset.id}`);
    } catch (err) {
      setError({ message: errorMessage(err), field: err instanceof ApiRequestError ? err.field : undefined });
      setSaving(false);
    }
  }

  const fieldError = (field: string) => (error?.field === field ? error.message : null);

  return (
    <form className="card form-card" onSubmit={submit}>
      <h2>Upload a CSV</h2>
      <Field
        label="CSV file"
        hint={
          file
            ? `${file.name}, ${Math.ceil(file.size / 1024).toLocaleString()} KB`
            : 'The first row must be the column names. Up to 10 MB.'
        }
        error={fieldError('csv')}
      >
        <input type="file" accept=".csv,text/csv" onChange={(e) => chooseFile(e.target.files?.[0] ?? null)} required />
      </Field>
      <div className="form-row">
        <Field label="Dataset name" error={fieldError('name')}>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </Field>
        <Field label="Classification" hint="Every column starts here. You can change columns one by one next.">
          <select value={dataTier} onChange={(e) => setDataTier(e.target.value as DataTier)}>
            {DATA_TIERS.map((tier) => (
              <option key={tier} value={tier}>
                {tier[0].toUpperCase() + tier.slice(1)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Description" hint="Optional">
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={1000} />
      </Field>
      {error && !['csv', 'name'].includes(error.field ?? '') && <ErrorBanner message={error.message} />}
      <div className="form-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={saving || !file || !name.trim()}>
          {saving ? 'Uploading…' : 'Upload'}
        </button>
      </div>
    </form>
  );
}
