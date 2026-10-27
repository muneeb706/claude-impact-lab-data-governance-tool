import type { AccountType, Policy } from '../../shared/types';

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  academic: 'Academic',
  industry: 'Industry',
};

export const ACCOUNT_TYPE_HINTS: Record<AccountType, string> = {
  academic: 'Universities, institutes and research labs',
  industry: 'Companies, biotechs and CROs',
};

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const formatDate = (iso: string) => dateFormat.format(new Date(iso));
export const formatDateTime = (iso: string) => dateTimeFormat.format(new Date(iso));

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Groups policies by category, keeping catalog order. */
export function groupByCategory(policies: Policy[]): [string, Policy[]][] {
  const groups = new Map<string, Policy[]>();
  for (const policy of policies) {
    const list = groups.get(policy.category) ?? [];
    list.push(policy);
    groups.set(policy.category, list);
  }
  return [...groups.entries()];
}
