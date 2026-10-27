import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Account, AccountType } from '../../../shared/types';
import { api, ApiRequestError, errorMessage, useApi } from '../api';
import {
  AccountTypeBadge,
  AccountTypePicker,
  EmptyState,
  ErrorBanner,
  Field,
  Loading,
  PageHeader,
} from '../components/ui';
import { formatDate } from '../format';

export default function AccountsPage() {
  const { data: accounts, error, loading } = useApi<Account[]>('/accounts');
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        title="Accounts"
        description="Organizations whose members work with proprietary scientific data. Each account is academic or industry, which decides the roles its members can hold."
        actions={
          !creating && (
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              New account
            </button>
          )
        }
      />
      {creating && <NewAccountForm onCancel={() => setCreating(false)} />}
      <ErrorBanner message={error} />
      {loading && !accounts ? (
        <Loading />
      ) : accounts && accounts.length === 0 ? (
        !creating && (
          <EmptyState title="No accounts yet">
            <p>Create an academic lab or industry organization to start adding members.</p>
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              Create the first account
            </button>
          </EmptyState>
        )
      ) : (
        accounts && (
          <div className="card table-card">
            <table className="table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Type</th>
                  <th className="num">Members</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => (
                  <tr key={account.id}>
                    <td>
                      <Link to={`/accounts/${account.id}`} className="row-title">
                        {account.name}
                      </Link>
                      {account.description && <div className="row-sub">{account.description}</div>}
                    </td>
                    <td>
                      <AccountTypeBadge type={account.type} />
                    </td>
                    <td className="num">{account.userCount}</td>
                    <td className="muted">{formatDate(account.createdAt)}</td>
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

function NewAccountForm({ onCancel }: { onCancel: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('academic');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const account = await api.post<Account>('/accounts', { name, type, description });
      navigate(`/accounts/${account.id}`);
    } catch (err) {
      setError({ message: errorMessage(err), field: err instanceof ApiRequestError ? err.field : undefined });
      setSaving(false);
    }
  }

  return (
    <form className="card form-card" onSubmit={submit}>
      <h2>New account</h2>
      <Field group label="Account type" hint="Can't be changed later. Roles are defined per account type.">
        <AccountTypePicker value={type} onChange={setType} />
      </Field>
      <Field label="Name" error={error?.field === 'name' ? error.message : null}>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={type === 'academic' ? 'e.g. Okafor Structural Biology Lab' : 'e.g. Acme Biologics'}
          required
          maxLength={120}
        />
      </Field>
      <Field label="Description" hint="Optional">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          maxLength={500}
          placeholder="What this group works on"
        />
      </Field>
      {error && error.field !== 'name' && <ErrorBanner message={error.message} />}
      <div className="form-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={saving || !name.trim()}>
          {saving ? 'Creating…' : 'Create account'}
        </button>
      </div>
    </form>
  );
}
