import { useEffect, useState, type ReactNode } from 'react';
import type { AccountType, DataTier, RiskLevel } from '../../../shared/types';
import { ACCOUNT_TYPE_HINTS, ACCOUNT_TYPE_LABELS } from '../format';

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function AccountTypeBadge({ type }: { type: AccountType }) {
  return <span className={`badge badge-${type}`}>{ACCOUNT_TYPE_LABELS[type]}</span>;
}

export function RiskBadge({ risk }: { risk: RiskLevel }) {
  return <span className={`badge badge-risk-${risk}`}>{risk[0].toUpperCase() + risk.slice(1)} risk</span>;
}

export function TierBadge({ tier }: { tier: DataTier | null }) {
  if (!tier) return null;
  return <span className={`badge badge-tier badge-tier-${tier}`}>{tier}</span>;
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function ErrorBanner({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <div className="banner banner-error" role="alert">
      {message}
    </div>
  );
}

export function Loading() {
  return <div className="loading">Loading…</div>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      {children && <div>{children}</div>}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  group,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  /** For button groups: a <label> would forward clicks on its text to the first button. */
  group?: boolean;
  children: ReactNode;
}) {
  const Tag = group ? 'div' : 'label';
  return (
    <Tag className={`field${error ? ' field-invalid' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint && <span className="field-hint">{hint}</span>}
    </Tag>
  );
}

export function AccountTypePicker({
  value,
  onChange,
  disabled,
}: {
  value: AccountType;
  onChange: (type: AccountType) => void;
  disabled?: boolean;
}) {
  return (
    <div className="type-picker" role="radiogroup" aria-label="Account type">
      {(['academic', 'industry'] as const).map((type) => (
        <button
          key={type}
          type="button"
          role="radio"
          aria-checked={value === type}
          className={`type-option${value === type ? ' selected' : ''}`}
          onClick={() => onChange(type)}
          disabled={disabled}
        >
          <span className="type-option-title">{ACCOUNT_TYPE_LABELS[type]}</span>
          <span className="type-option-hint">{ACCOUNT_TYPE_HINTS[type]}</span>
        </button>
      ))}
    </div>
  );
}

/** A destructive button that asks for a second click before acting. */
export function ConfirmButton({
  children,
  confirmLabel = 'Click again to confirm',
  onConfirm,
  className = 'btn btn-danger-ghost',
  disabled,
}: {
  children: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  className?: string;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <button
      type="button"
      className={`${className}${armed ? ' armed' : ''}`}
      disabled={disabled}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        void onConfirm();
      }}
    >
      {armed ? confirmLabel : children}
    </button>
  );
}
