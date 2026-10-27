import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { MIN_PASSWORD_LENGTH, type Manager } from '../../../shared/types';
import { api, ApiRequestError, errorMessage, useApi } from '../api';
import { useManager } from '../auth';
import { Badge, ConfirmButton, ErrorBanner, Field, Loading, PageHeader } from '../components/ui';
import { formatDate } from '../format';

export default function ManagersPage() {
  const me = useManager();
  const { data: managers, error, reload } = useApi<Manager[]>('/managers');
  const [adding, setAdding] = useState(false);
  const [resettingId, setResettingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function setStatus(manager: Manager, status: Manager['status']) {
    setActionError(null);
    setNotice(null);
    try {
      await api.patch(`/managers/${manager.id}`, { status });
      await reload();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  return (
    <>
      <PageHeader
        title="Account managers"
        description="People who can sign in to this console. Every change they make is recorded in the audit log under their name."
        actions={
          !adding && (
            <button className="btn btn-primary" onClick={() => setAdding(true)}>
              Add manager
            </button>
          )
        }
      />
      {adding && (
        <AddManagerForm
          onCancel={() => setAdding(false)}
          onAdded={async (manager) => {
            setAdding(false);
            setNotice(`${manager.name} can now sign in with the temporary password you set.`);
            await reload();
          }}
        />
      )}
      {notice && <div className="banner banner-success">{notice}</div>}
      <ErrorBanner message={actionError ?? error} />
      {!managers ? (
        <Loading />
      ) : (
        <div className="card table-card">
          <table className="table">
            <thead>
              <tr>
                <th>Manager</th>
                <th>Status</th>
                <th>Added</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {managers.map((manager) => {
                const isMe = manager.id === me.id;
                return (
                  <ManagerRow
                    key={manager.id}
                    manager={manager}
                    isMe={isMe}
                    resetting={resettingId === manager.id}
                    onReset={() => setResettingId(resettingId === manager.id ? null : manager.id)}
                    onResetDone={(message) => {
                      setResettingId(null);
                      setNotice(message);
                    }}
                    onStatus={(status) => setStatus(manager, status)}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ManagerRow({
  manager,
  isMe,
  resetting,
  onReset,
  onResetDone,
  onStatus,
}: {
  manager: Manager;
  isMe: boolean;
  resetting: boolean;
  onReset: () => void;
  onResetDone: (message: string) => void;
  onStatus: (status: Manager['status']) => void;
}) {
  const active = manager.status === 'active';
  return (
    <>
      <tr className={active ? undefined : 'row-inactive'}>
        <td>
          <div className="row-title">
            {manager.name} {isMe && <Badge tone="custom">You</Badge>}
          </div>
          <div className="row-sub">{manager.email}</div>
        </td>
        <td>
          <Badge tone={active ? 'success' : 'warning'}>{active ? 'Active' : 'Deactivated'}</Badge>
        </td>
        <td className="muted">{formatDate(manager.createdAt)}</td>
        <td>
          <div className="row-actions">
            <Link to={`/audit?actor=${manager.id}`} className="btn btn-small">
              Activity
            </Link>
            {isMe ? (
              <Link to="/password" className="btn btn-small">
                Change password
              </Link>
            ) : (
              <>
                {active && (
                  <button className="btn btn-small" onClick={onReset}>
                    {resetting ? 'Cancel reset' : 'Reset password'}
                  </button>
                )}
                {active ? (
                  <ConfirmButton
                    className="btn btn-small btn-danger-ghost"
                    confirmLabel="Deactivate?"
                    onConfirm={() => onStatus('deactivated')}
                  >
                    Deactivate
                  </ConfirmButton>
                ) : (
                  <button className="btn btn-small" onClick={() => onStatus('active')}>
                    Reactivate
                  </button>
                )}
              </>
            )}
          </div>
        </td>
      </tr>
      {resetting && (
        <tr className="row-expansion">
          <td colSpan={4}>
            <ResetPasswordForm manager={manager} onDone={onResetDone} />
          </td>
        </tr>
      )}
    </>
  );
}

function AddManagerForm({ onCancel, onAdded }: { onCancel: () => void; onAdded: (manager: Manager) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onAdded(await api.post<Manager>('/managers', { name, email, password }));
    } catch (err) {
      setError({ message: errorMessage(err), field: err instanceof ApiRequestError ? err.field : undefined });
      setSaving(false);
    }
  }

  const fieldError = (field: string) => (error?.field === field ? error.message : null);

  return (
    <form className="card form-card" onSubmit={submit}>
      <h2>Add account manager</h2>
      <div className="form-row">
        <Field label="Name" error={fieldError('name')}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </Field>
        <Field label="Email" error={fieldError('email')}>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
      </div>
      <Field
        label="Temporary password"
        hint={`At least ${MIN_PASSWORD_LENGTH} characters. Share it with them privately; they can change it after signing in.`}
        error={fieldError('password')}
      >
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={MIN_PASSWORD_LENGTH}
        />
      </Field>
      {error && !['name', 'email', 'password'].includes(error.field ?? '') && <ErrorBanner message={error.message} />}
      <div className="form-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Adding…' : 'Add manager'}
        </button>
      </div>
    </form>
  );
}

function ResetPasswordForm({ manager, onDone }: { manager: Manager; onDone: (message: string) => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.patch(`/managers/${manager.id}`, { password });
      onDone(`Password reset for ${manager.name}. They have been signed out everywhere.`);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <form className="reset-form" onSubmit={submit}>
      <Field label={`New temporary password for ${manager.name}`} error={error}>
        <input
          type="password"
          autoComplete="new-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={MIN_PASSWORD_LENGTH}
        />
      </Field>
      <button type="submit" className="btn btn-primary" disabled={saving}>
        {saving ? 'Saving…' : 'Set password'}
      </button>
    </form>
  );
}
