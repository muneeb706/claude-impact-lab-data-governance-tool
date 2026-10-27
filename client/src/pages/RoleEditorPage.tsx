import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ACCOUNT_TYPES, type AccountType, type Policy, type Role } from '../../../shared/types';
import { api, ApiRequestError, errorMessage, useApi } from '../api';
import { PolicyChecklist } from '../components/PolicyChecklist';
import {
  AccountTypeBadge,
  AccountTypePicker,
  Badge,
  ConfirmButton,
  ErrorBanner,
  Field,
  Loading,
  PageHeader,
} from '../components/ui';
import { plural } from '../format';

export default function RoleEditorPage() {
  const { id } = useParams();
  const role = useApi<Role>(id ? `/roles/${id}` : null);
  const policies = useApi<Policy[]>('/policies');

  if (role.error || policies.error) return <ErrorBanner message={role.error ?? policies.error} />;
  if ((id && !role.data) || !policies.data) return <Loading />;
  return <RoleForm key={id ?? 'new'} role={role.data} policies={policies.data} />;
}

function RoleForm({ role, policies }: { role?: Role; policies: Policy[] }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedType = searchParams.get('accountType') as AccountType | null;

  const [name, setName] = useState(role?.name ?? '');
  const [accountType, setAccountType] = useState<AccountType>(
    role?.accountType ?? (requestedType && ACCOUNT_TYPES.includes(requestedType) ? requestedType : 'academic'),
  );
  const [description, setDescription] = useState(role?.description ?? '');
  const [selected, setSelected] = useState<Set<number>>(new Set(role?.policyIds));
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(timer);
  }, [saved]);

  const selectedPolicies = policies.filter((p) => selected.has(p.id));
  const highRisk = selectedPolicies.filter((p) => p.risk === 'high');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const policyIds = [...selected];
    try {
      if (role) {
        await api.patch<Role>(`/roles/${role.id}`, { name, description, policyIds });
        setSaved(true);
      } else {
        await api.post<Role>('/roles', { name, accountType, description, policyIds });
        navigate('/roles');
      }
    } catch (err) {
      setError({ message: errorMessage(err), field: err instanceof ApiRequestError ? err.field : undefined });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!role) return;
    try {
      await api.delete(`/roles/${role.id}`);
      navigate('/roles');
    } catch (err) {
      setError({ message: errorMessage(err) });
    }
  }

  return (
    <form onSubmit={submit} className="role-editor">
      <PageHeader
        eyebrow={
          <>
            <Link to="/roles">Roles</Link> /
          </>
        }
        title={
          role ? (
            <span className="title-with-badge">
              {role.name} <AccountTypeBadge type={role.accountType} />
              {role.isSystem && <Badge>Built-in</Badge>}
            </span>
          ) : (
            'New role'
          )
        }
        description={
          role
            ? `${plural(role.userCount, 'member')} currently ${role.userCount === 1 ? 'has' : 'have'} this role. Policy changes apply to them immediately.`
            : 'Name the role, choose the account type it applies to, then select its policies from the catalog.'
        }
        actions={
          role &&
          !role.isSystem && (
            <ConfirmButton
              onConfirm={remove}
              disabled={role.userCount > 0}
              confirmLabel="Delete role?"
            >
              {role.userCount > 0 ? 'In use, cannot delete' : 'Delete role'}
            </ConfirmButton>
          )
        }
      />

      <div className="card form-card">
        {!role && (
          <Field group label="Applies to" hint="Members of accounts of this type can be given this role.">
            <AccountTypePicker value={accountType} onChange={setAccountType} />
          </Field>
        )}
        <Field
          label="Role name"
          hint={role?.isSystem ? 'Built-in roles keep their name.' : undefined}
          error={error?.field === 'name' ? error.message : null}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={80}
            disabled={role?.isSystem}
            placeholder={accountType === 'academic' ? 'e.g. Postdoctoral Researcher' : 'e.g. Senior Scientist'}
          />
        </Field>
        <Field label="Description" hint="Optional">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={500} />
        </Field>
      </div>

      <div className="section-header">
        <div>
          <h2>Policies</h2>
          <p className="muted">Choose what members with this role are allowed to do.</p>
        </div>
      </div>
      <PolicyChecklist policies={policies} selected={selected} onChange={setSelected} />

      <div className="save-bar">
        <div className="save-bar-summary">
          <strong>{plural(selected.size, 'policy', 'policies')} selected</strong>
          {highRisk.length > 0 && (
            <span className="save-bar-warning">
              Includes {plural(highRisk.length, 'high-risk policy', 'high-risk policies')}: {highRisk.map((p) => p.name).join(', ')}
            </span>
          )}
          {error && error.field !== 'name' && <span className="save-bar-error">{error.message}</span>}
          {saved && <span className="save-bar-success">Saved</span>}
        </div>
        <div className="form-actions">
          <Link to="/roles" className="btn">
            {role ? 'Back' : 'Cancel'}
          </Link>
          <button type="submit" className="btn btn-primary" disabled={saving || !name.trim()}>
            {saving ? 'Saving…' : role ? 'Save changes' : 'Create role'}
          </button>
        </div>
      </div>
    </form>
  );
}
