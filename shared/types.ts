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

/** Whether Claude Code may read a whole dataset file. */
export const FILE_CLAUDE_ACCESS = ['allowed', 'blocked'] as const;
export type FileClaudeAccess = (typeof FILE_CLAUDE_ACCESS)[number];

/** Per column: Claude Code sees real values, consistent pseudonyms, or nothing. */
export const COLUMN_CLAUDE_ACCESS = ['allowed', 'masked', 'blocked'] as const;
export type ColumnClaudeAccess = (typeof COLUMN_CLAUDE_ACCESS)[number];

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
  /** True once an account manager has set a password for this member. */
  canSignIn: boolean;
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

/** A signed-in account member. What they can do comes from their role's policy codes. */
export interface MemberSession {
  id: number;
  name: string;
  email: string;
  accountId: number;
  accountName: string;
  accountType: AccountType;
  roleId: number;
  roleName: string;
  policyCodes: string[];
}

export interface SessionInfo {
  manager: Manager | null;
  member: MemberSession | null;
  /** True until the first account manager has been created. */
  needsSetup: boolean;
}

export interface AuditEntry {
  id: number;
  actorKind: 'manager' | 'member';
  /** The manager's id; null for member actions. */
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

export interface DatasetColumn {
  position: number;
  name: string;
  classification: DataTier;
  claudeAccess: ColumnClaudeAccess;
  description: string;
  /** A few distinct example values, for stewards only. */
  samples?: string[];
}

/** What a specific member gets for one column when they download. */
export interface EffectiveColumn {
  name: string;
  classification: DataTier;
  /** Whether the column is in the member's own copy. */
  inYourCopy: boolean;
  claudeAccess: ColumnClaudeAccess;
  reason: string;
}

export interface DatasetGrant {
  userId: number;
  name: string;
  email: string;
  roleName: string;
  grantedBy: string | null;
  createdAt: string;
}

export interface Dataset {
  id: number;
  accountId: number;
  name: string;
  description: string;
  fileName: string;
  rowCount: number;
  byteSize: number;
  dataTier: DataTier;
  claudeAccess: FileClaudeAccess;
  uploadedBy: string | null;
  createdAt: string;
  updatedAt: string;
  columns: DatasetColumn[];
  /** Stewards only. */
  grants?: DatasetGrant[];
  /** Members downloading only: their effective access, column by column. */
  effective?: EffectiveColumn[];
  /** Members only: whether they may download, and why not if they can't. */
  download?: { allowed: boolean; reason?: string };
}

export interface DatasetPreview {
  columns: string[];
  rows: string[][];
  totalRows: number;
}

export interface Grantee {
  id: number;
  name: string;
  email: string;
  roleName: string;
}
