// Types shared by the API server and the React client.

export const ACCOUNT_TYPES = ['academic', 'industry'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const DATA_TIERS = ['public', 'internal', 'restricted'] as const;
export type DataTier = (typeof DATA_TIERS)[number];

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const USER_STATUSES = ['active', 'suspended'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const MANAGER_STATUSES = ['active', 'deactivated'] as const;
export type ManagerStatus = (typeof MANAGER_STATUSES)[number];

/** Custom policy codes always carry this prefix so they can never collide with built-in ones. */
export const CUSTOM_POLICY_PREFIX = 'custom.';
export const MIN_PASSWORD_LENGTH = 8;

export interface Account {
  id: number;
  name: string;
  type: AccountType;
  description: string;
  createdAt: string;
  userCount: number;
}

export interface Policy {
  id: number;
  code: string;
  name: string;
  description: string;
  category: string;
  /** The data tier the policy governs, or null for governance-only policies. */
  dataTier: DataTier | null;
  risk: RiskLevel;
  /** Built-in policies come from the seed and are read-only. */
  isSystem: boolean;
}

export interface Role {
  id: number;
  name: string;
  accountType: AccountType;
  description: string;
  /** Built-in roles cannot be renamed or deleted, but their policies can be changed. */
  isSystem: boolean;
  createdAt: string;
  policyIds: number[];
  userCount: number;
}

export interface User {
  id: number;
  accountId: number;
  accountName: string;
  roleId: number;
  roleName: string;
  name: string;
  email: string;
  status: UserStatus;
  createdAt: string;
}

export interface UserWithPolicies extends User {
  policies: Policy[];
}

/** A person who signs in to this console to manage accounts, roles and policies. */
export interface Manager {
  id: number;
  name: string;
  email: string;
  status: ManagerStatus;
  createdAt: string;
}

export interface SessionInfo {
  manager: Manager | null;
  /** True until the first account manager has been created. */
  needsSetup: boolean;
}

export interface AuditEntry {
  id: number;
  actorId: number | null;
  actor: string;
  actorEmail: string | null;
  action: string;
  entityType: string;
  entityId: number | null;
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ApiError {
  error: string;
  field?: string;
}
