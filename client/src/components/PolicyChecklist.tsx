import type { Policy } from '../../../shared/types';
import { groupByCategory } from '../format';
import { Badge, RiskBadge, TierBadge } from './ui';

export function PolicyChecklist({
  policies,
  selected,
  onChange,
}: {
  policies: Policy[];
  selected: Set<number>;
  onChange: (next: Set<number>) => void;
}) {
  function toggle(ids: number[], on: boolean) {
    const next = new Set(selected);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    onChange(next);
  }

  return (
    <div className="policy-groups">
      {groupByCategory(policies).map(([category, items]) => {
        const ids = items.map((p) => p.id);
        const count = ids.filter((id) => selected.has(id)).length;
        const all = count === ids.length;
        return (
          <fieldset key={category} className="policy-group">
            <legend className="policy-group-header">
              <span className="policy-group-title">{category}</span>
              <span className="muted">
                {count} of {ids.length}
              </span>
              <button type="button" className="link-button" onClick={() => toggle(ids, !all)}>
                {all ? 'Clear' : 'Select all'}
              </button>
            </legend>
            {items.map((policy) => (
              <label key={policy.id} className={`policy-option${selected.has(policy.id) ? ' checked' : ''}`}>
                <input
                  type="checkbox"
                  checked={selected.has(policy.id)}
                  onChange={(e) => toggle([policy.id], e.target.checked)}
                />
                <span className="policy-option-body">
                  <span className="policy-option-title">
                    {policy.name}
                    {!policy.isSystem && <Badge tone="custom">Custom</Badge>}
                    <code>{policy.code}</code>
                  </span>
                  <span className="policy-option-description">{policy.description}</span>
                </span>
                <span className="policy-option-badges">
                  <TierBadge tier={policy.dataTier} />
                  <RiskBadge risk={policy.risk} />
                </span>
              </label>
            ))}
          </fieldset>
        );
      })}
    </div>
  );
}

export function PolicyList({ policies }: { policies: Policy[] }) {
  if (policies.length === 0) return <p className="muted">No policies granted.</p>;
  return (
    <div className="policy-list">
      {groupByCategory(policies).map(([category, items]) => (
        <section key={category}>
          <h4 className="policy-list-category">{category}</h4>
          <ul>
            {items.map((policy) => (
              <li key={policy.id}>
                <div className="policy-list-name">
                  {policy.name} {!policy.isSystem && <Badge tone="custom">Custom</Badge>}
                </div>
                <div className="policy-list-badges">
                  <TierBadge tier={policy.dataTier} />
                  <RiskBadge risk={policy.risk} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
