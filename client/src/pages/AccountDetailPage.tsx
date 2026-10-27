import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Account, Role, User, UserWithPolicies } from '../../../shared/types';
import { api, ApiRequestError, errorMessage, useApi } from '../api';
import { PolicyList } from '../components/PolicyChecklist';
import {
  AccountTypeBadge,
  Badge,
  ConfirmButton,
  EmptyState,
  ErrorBanner,
  Field,
  Loading,
  PageHeader,
} from '../components/ui';
import { ACCOUNT_TYPE_LABELS, plural } from '../format';

export default function AccountDetailPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const account = useApi<Account>(`/accounts/${id}`);
  const users = useApi<User[]>(`/users?accountId=${id}`);
  const roles = useApi<Role[]>(account.data ? `/roles?accountType=${account.data.type}` : null);
  const [editing, setEditing] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (account.error) return <ErrorBanner message={account.error} />;
  if (!account.data) return <Loading />;
  const acct = account.data;

  async function refresh() {
    await Promise.all([users.reload(), account.reload(), roles.reload()]);
  }

  async function updateUser(user: User, changes: Partial<Pick<User, 'roleId' | 'status'>>) {
    setActionError(null);
    try {
      await api.patch(`/users/${user.id}`, changes);
      await refresh();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function removeUser(user: User) {
    setActionError(null);
    try {
      await api.delete(`/users/${user.id}`);
      if (selectedUserId === user.id) setSelectedUserId(null);
      await refresh();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function deleteAccount() {
    try {
      await api.delete(`/accounts/${acct.id}`);
      navigate('/accounts');
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <Link to="/accounts">Accounts</Link> /
          </>
        }
        title={
          <span className="title-with-badge">
            {acct.name} <AccountTypeBadge type={acct.type} />
          </span>
        }
        description={acct.description || undefined}
        actions={
          !editing && (
            <>
              <button className="btn" onClick={() => setEditing(true)}>
                Edit details
              </button>
              <ConfirmButton
                onConfirm={deleteAccount}
                confirmLabel={acct.userCount ? `Delete with ${plural(acct.userCount, 'member')}?` : 'Delete account?'}
              >
                Delete account
              </ConfirmButton>
            </>
          )
        }
      />

      {editing && (
        <EditAccountForm
          account={acct}
          onDone={async () => {
            setEditing(false);
            await account.reload();
          }}
        />
      )}

      <ErrorBanner message={actionError ?? users.error ?? roles.error} />

      <div className={`split${selectedUserId ? ' with-panel' : ''}`}>
        <section className="card members-card">
          <div className="card-header">
            <div>
              <h2>Members</h2>
              <p className="muted">
                Each member holds one {ACCOUNT_TYPE_LABELS[acct.type].toLowerCase()} role, which grants their policies.
                Select a name to see them.
              </p>
            </div>
          </div>

          {roles.data && <AddUserForm account={acct} roles={roles.data} onAdded={refresh} />}

          {users.loading && !users.data ? (
            <Loading />
          ) : users.data && users.data.length === 0 ? (
            <EmptyState title="No members yet">Add the first member above.</EmptyState>
          ) : (
            users.data && (
              <table className="table">
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {users.data.map((user) => (
                    <tr key={user.id} className={selectedUserId === user.id ? 'selected' : undefined}>
                      <td>
                        <button
                          className="row-title link-button"
                          title="View effective policies"
                          onClick={() => setSelectedUserId(user.id)}
                        >
                          {user.name}
                        </button>
                        <div className="row-sub">{user.email}</div>
                      </td>
                      <td>
                        <select
                          aria-label={`Role for ${user.name}`}
                          value={user.roleId}
                          onChange={(e) => updateUser(user, { roleId: Number(e.target.value) })}
                        >
                          {roles.data?.map((role) => (
                            <option key={role.id} value={role.id}>
                              {role.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <Badge tone={user.status === 'active' ? 'success' : 'warning'}>{user.status === 'active' ? 'Active' : 'Suspended'}</Badge>
                      </td>
                      <td>
                        <div className="row-actions">
                          <button
                            className="btn btn-small"
                            onClick={() => updateUser(user, { status: user.status === 'active' ? 'suspended' : 'active' })}
                          >
                            {user.status === 'active' ? 'Suspend' : 'Reactivate'}
                          </button>
                          <ConfirmButton className="btn btn-small btn-danger-ghost" onConfirm={() => removeUser(user)} confirmLabel="Remove?">
                            Remove
                          </ConfirmButton>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
        </section>

        {selectedUserId && (
          <UserPolicyPanel
            // Re-mount when the user's role changes so the panel refetches.
            key={`${selectedUserId}-${users.data?.find((u) => u.id === selectedUserId)?.roleId}`}
            userId={selectedUserId}
            onClose={() => setSelectedUserId(null)}
          />
        )}
      </div>
    </>
  );
}

function EditAccountForm({ account, onDone }: { account: Account; onDone: () => void }) {
  const [name, setName] = useState(account.name);
  const [description, setDescription] = useState(account.description);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api.patch(`/accounts/${account.id}`, { name, description });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <form className="card form-card" onSubmit={submit}>
      <h2>Edit account</h2>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
      </Field>
      <Field label="Description">
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={500} />
      </Field>
      <ErrorBanner message={error} />
      <div className="form-actions">
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
          Save
        </button>
      </div>
    </form>
  );
}

function AddUserForm({ account, roles, onAdded }: { account: Account; roles: Role[]; onAdded: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState<number | ''>(roles[0]?.id ?? '');
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.post('/users', { accountId: account.id, roleId: roleId || undefined, name, email });
      setName('');
      setEmail('');
      await onAdded();
    } catch (err) {
      setError({ message: errorMessage(err), field: err instanceof ApiRequestError ? err.field : undefined });
    } finally {
      setSaving(false);
    }
  }

  if (roles.length === 0) {
    return (
      <div className="banner banner-info">
        There are no {ACCOUNT_TYPE_LABELS[account.type].toLowerCase()} roles yet.{' '}
        <Link to={`/roles/new?accountType=${account.type}`}>Create one</Link> before adding members.
      </div>
    );
  }

  return (
    <form className="inline-form" onSubmit={submit}>
      <Field label="Name" error={error?.field === 'name' ? error.message : null}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" required maxLength={120} />
      </Field>
      <Field label="Email" error={error?.field === 'email' ? error.message : null}>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@example.org"
          required
        />
      </Field>
      <Field label="Role" error={error?.field === 'roleId' ? error.message : null}>
        <select value={roleId} onChange={(e) => setRoleId(Number(e.target.value))} required>
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </select>
      </Field>
      <button type="submit" className="btn btn-primary" disabled={saving}>
        {saving ? 'Adding…' : 'Add member'}
      </button>
      {error && !['name', 'email', 'roleId'].includes(error.field ?? '') && (
        <div className="inline-form-error">
          <ErrorBanner message={error.message} />
        </div>
      )}
    </form>
  );
}

function UserPolicyPanel({ userId, onClose }: { userId: number; onClose: () => void }) {
  const { data: user, error } = useApi<UserWithPolicies>(`/users/${userId}`);
  return (
    <aside className="card side-panel" aria-label="Effective policies">
      <div className="card-header">
        <div>
          <div className="eyebrow">Effective policies</div>
          <h2>{user?.name ?? '…'}</h2>
          {user && (
            <p className="muted">
              Granted by the <Link to={`/roles/${user.roleId}`}>{user.roleName}</Link> role
              {user.status === 'suspended' && ' (suspended: none apply until reactivated)'}
            </p>
          )}
        </div>
        <button className="btn btn-small" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <ErrorBanner message={error} />
      {user ? <PolicyList policies={user.policies} /> : !error && <Loading />}
    </aside>
  );
}
