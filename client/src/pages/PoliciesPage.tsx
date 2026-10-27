import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { slugifyPolicyCode } from '../../../shared/policyCode';
import {
  CUSTOM_POLICY_PREFIX,
  DATA_TIERS,
  RISK_LEVELS,
  type DataTier,
  type Policy,
  type RiskLevel,
  type Role,
} from '../../../shared/types';
import { api, ApiRequestError, errorMessage, useApi } from '../api';
import {
  Badge,
  ConfirmButton,
  ErrorBanner,
  Field,
  Loading,
  PageHeader,
  RiskBadge,
  TierBadge,
} from '../components/ui';
import { groupByCategory } from '../format';

type Editing = { mode: 'new' } | { mode: 'edit'; policy: Policy } | null;

export default function PoliciesPage() {
  const policies = useApi<Policy[]>('/policies');
  const roles = useApi<Role[]>('/roles');
  const [editing, setEditing] = useState<Editing>(null);
  // Shown on the row itself, since the user is usually scrolled down to it.
  const [rowError, setRowError] = useState<{ policyId: number; message: string } | null>(null);

  async function remove(policy: Policy) {
    setRowError(null);
    try {
      await api.delete(`/policies/${policy.id}`);
      await policies.reload();
    } catch (err) {
      setRowError({ policyId: policy.id, message: errorMessage(err) });
    }
  }

  function startEditing(next: Editing) {
    setRowError(null);
    setEditing(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const categories = [...new Set(policies.data?.map((p) => p.category))];

  return (
    <>
      <PageHeader
        title="Policy catalog"
        description="The policies that roles are made from: built-in ones, plus custom policies added by account managers. Tiers follow the public / internal / restricted data classification."
        actions={
          !editing && (
            <button className="btn btn-primary" onClick={() => startEditing({ mode: 'new' })}>
              New policy
            </button>
          )
        }
      />
      {editing && (
        <PolicyForm
          key={editing.mode === 'edit' ? editing.policy.id : 'new'}
          policy={editing.mode === 'edit' ? editing.policy : undefined}
          categories={categories}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await policies.reload();
          }}
        />
      )}
      <ErrorBanner message={policies.error ?? roles.error} />
      {!policies.data || !roles.data ? (
        <Loading />
      ) : (
        groupByCategory(policies.data).map(([category, items]) => (
          <section key={category} className="card catalog-group">
            <h2>{category}</h2>
            <table className="table">
              <thead>
                <tr>
                  <th>Policy</th>
                  <th>Tier</th>
                  <th>Risk</th>
                  <th>Granted to</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {items.map((policy) => {
                  const grantedTo = roles.data!.filter((r) => r.policyIds.includes(policy.id));
                  return (
                    <tr key={policy.id}>
                      <td>
                        <div className="row-title">
                          {policy.name} {!policy.isSystem && <Badge tone="custom">Custom</Badge>}
                        </div>
                        <div className="row-sub">{policy.description}</div>
                        <code className="policy-code">{policy.code}</code>
                        {rowError?.policyId === policy.id && <div className="row-error">{rowError.message}</div>}
                      </td>
                      <td>{policy.dataTier ? <TierBadge tier={policy.dataTier} /> : <span className="muted">n/a</span>}</td>
                      <td>
                        <RiskBadge risk={policy.risk} />
                      </td>
                      <td>
                        <div className="chips">
                          {grantedTo.length === 0 ? (
                            <span className="muted">No roles</span>
                          ) : (
                            grantedTo.map((role) => (
                              <Link key={role.id} to={`/roles/${role.id}`} className={`chip chip-${role.accountType}`}>
                                {role.name}
                              </Link>
                            ))
                          )}
                        </div>
                      </td>
                      <td>
                        {!policy.isSystem && (
                          <div className="row-actions">
                            <button className="btn btn-small" onClick={() => startEditing({ mode: 'edit', policy })}>
                              Edit
                            </button>
                            <ConfirmButton
                              className="btn btn-small btn-danger-ghost"
                              confirmLabel="Delete?"
                              onConfirm={() => remove(policy)}
                            >
                              Delete
                            </ConfirmButton>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        ))
      )}
    </>
  );
}

function PolicyForm({
  policy,
  categories,
  onCancel,
  onSaved,
}: {
  policy?: Policy;
  categories: string[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(policy?.name ?? '');
  const [codeSuffix, setCodeSuffix] = useState('');
  const [codeEdited, setCodeEdited] = useState(false);
  const [description, setDescription] = useState(policy?.description ?? '');
  const [category, setCategory] = useState(policy?.category ?? '');
  const [dataTier, setDataTier] = useState<DataTier | ''>(policy?.dataTier ?? '');
  const [risk, setRisk] = useState<RiskLevel>(policy?.risk ?? 'medium');
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // Until the code is edited by hand, it follows the name.
  const suffix = codeEdited ? codeSuffix : slugifyPolicyCode(name).slice(CUSTOM_POLICY_PREFIX.length);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const fields = { name, description, category, dataTier: dataTier || null, risk };
    try {
      if (policy) await api.patch(`/policies/${policy.id}`, fields);
      else await api.post('/policies', { ...fields, code: CUSTOM_POLICY_PREFIX + suffix });
      onSaved();
    } catch (err) {
      setError({ message: errorMessage(err), field: err instanceof ApiRequestError ? err.field : undefined });
      setSaving(false);
    }
  }

  const fieldError = (field: string) => (error?.field === field ? error.message : null);

  return (
    <form className="card form-card" onSubmit={submit}>
      <h2>{policy ? `Edit ${policy.name}` : 'New custom policy'}</h2>
      <div className="form-row">
        <Field label="Policy name" error={fieldError('name')}>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={80}
            placeholder="e.g. Export lab notebooks"
          />
        </Field>
        {policy ? (
          <Field label="Code" hint="Codes never change, so integrations can rely on them.">
            <input value={policy.code} disabled />
          </Field>
        ) : (
          <Field label="Code" hint="A stable identifier for integrations." error={fieldError('code')}>
            <div className="input-addon">
              <span>{CUSTOM_POLICY_PREFIX}</span>
              <input
                value={suffix}
                onChange={(e) => {
                  setCodeEdited(true);
                  setCodeSuffix(e.target.value.toLowerCase());
                }}
                required
                maxLength={80 - CUSTOM_POLICY_PREFIX.length}
                pattern="[a-z0-9_]+(\.[a-z0-9_]+)*"
                title="Lowercase letters, digits, _ and ."
                placeholder="export_lab_notebooks"
              />
            </div>
          </Field>
        )}
      </div>
      <Field label="Description" hint="What does this policy allow a member to do?" error={fieldError('description')}>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} required maxLength={300} />
      </Field>
      <div className="form-row form-row-3">
        <Field label="Category" hint="Pick an existing one or type a new one." error={fieldError('category')}>
          <input
            list="policy-categories"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            required
            maxLength={60}
          />
          <datalist id="policy-categories">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>
        <Field label="Data tier" hint="Which data this policy governs, if any.">
          <select value={dataTier} onChange={(e) => setDataTier(e.target.value as DataTier | '')}>
            <option value="">None</option>
            {DATA_TIERS.map((tier) => (
              <option key={tier} value={tier}>
                {tier[0].toUpperCase() + tier.slice(1)}
              </option>
            ))}
          </select>
        </Field>
        <Field group label="Risk">
          <div className="segmented segmented-fill" role="radiogroup" aria-label="Risk">
            {RISK_LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={risk === level}
                className={risk === level ? `active risk-${level}` : undefined}
                onClick={() => setRisk(level)}
              >
                {level[0].toUpperCase() + level.slice(1)}
              </button>
            ))}
          </div>
        </Field>
      </div>
      {error && !['name', 'code', 'description', 'category'].includes(error.field ?? '') && (
        <ErrorBanner message={error.message} />
      )}
      <div className="form-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={saving || !name.trim()}>
          {saving ? 'Saving…' : policy ? 'Save changes' : 'Create policy'}
        </button>
      </div>
    </form>
  );
}
