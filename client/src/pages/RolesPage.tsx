import { Link } from 'react-router-dom';
import { ACCOUNT_TYPES, type Policy, type Role } from '../../../shared/types';
import { useApi } from '../api';
import { Badge, ErrorBanner, Loading, PageHeader } from '../components/ui';
import { ACCOUNT_TYPE_HINTS, ACCOUNT_TYPE_LABELS, plural } from '../format';

export default function RolesPage() {
  const roles = useApi<Role[]>('/roles');
  const policies = useApi<Policy[]>('/policies');

  const highRiskIds = new Set(policies.data?.filter((p) => p.risk === 'high').map((p) => p.id));

  return (
    <>
      <PageHeader
        title="Roles"
        description="A role is a set of policies from the catalog. Members of an account are given one role that matches the account's type."
        actions={
          <Link to="/roles/new" className="btn btn-primary">
            New role
          </Link>
        }
      />
      <ErrorBanner message={roles.error ?? policies.error} />
      {!roles.data ? (
        <Loading />
      ) : (
        ACCOUNT_TYPES.map((type) => {
          const list = roles.data!.filter((r) => r.accountType === type);
          return (
            <section key={type} className="role-section">
              <div className="section-header">
                <div>
                  <h2>{ACCOUNT_TYPE_LABELS[type]} roles</h2>
                  <p className="muted">{ACCOUNT_TYPE_HINTS[type]}</p>
                </div>
                <Link to={`/roles/new?accountType=${type}`} className="btn btn-small">
                  Add {ACCOUNT_TYPE_LABELS[type].toLowerCase()} role
                </Link>
              </div>
              <div className="role-grid">
                {list.map((role) => {
                  const highRisk = role.policyIds.filter((id) => highRiskIds.has(id)).length;
                  return (
                    <Link key={role.id} to={`/roles/${role.id}`} className={`card role-card role-card-${type}`}>
                      <div className="role-card-top">
                        <h3>{role.name}</h3>
                        {role.isSystem && <Badge>Built-in</Badge>}
                      </div>
                      {role.description && <p className="role-card-description">{role.description}</p>}
                      <div className="role-card-meta">
                        <span>{plural(role.policyIds.length, 'policy', 'policies')}</span>
                        <span>{plural(role.userCount, 'member')}</span>
                        {highRisk > 0 && <Badge tone="risk-high">{highRisk} high risk</Badge>}
                      </div>
                    </Link>
                  );
                })}
                {list.length === 0 && <p className="muted">No {type} roles yet.</p>}
              </div>
            </section>
          );
        })
      )}
    </>
  );
}
