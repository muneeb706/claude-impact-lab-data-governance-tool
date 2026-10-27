import type Database from 'better-sqlite3';
import type { AccountType, DataTier, RiskLevel } from '../../shared/types';

interface PolicySeed {
  code: string;
  name: string;
  description: string;
  category: string;
  dataTier: DataTier | null;
  risk: RiskLevel;
}

interface RoleSeed {
  name: string;
  accountType: AccountType;
  description: string;
  policyCodes: string[];
}

// The baked-in policy catalog. Account managers build roles from this list and
// can add custom policies alongside it. Codes are stable identifiers; names and
// descriptions may be edited here and are re-synced on every start.
export const POLICY_CATALOG: PolicySeed[] = [
  // Data access
  {
    code: 'data.public.read',
    name: 'Read public data',
    description: 'View published papers, public datasets and approved external material.',
    category: 'Data access',
    dataTier: 'public',
    risk: 'low',
  },
  {
    code: 'data.internal.read',
    name: 'Read internal data',
    description: 'View lab notebooks, protocols, meeting notes and pre-publication drafts.',
    category: 'Data access',
    dataTier: 'internal',
    risk: 'medium',
  },
  {
    code: 'data.restricted.read',
    name: 'Read restricted data',
    description: 'View compound structures, sequences, target identities and unpublished results.',
    category: 'Data access',
    dataTier: 'restricted',
    risk: 'high',
  },
  {
    code: 'data.classify',
    name: 'Classify data tiers',
    description: 'Assign or change the public / internal / restricted tier of documents and datasets.',
    category: 'Data access',
    dataTier: null,
    risk: 'medium',
  },

  // AI model use
  {
    code: 'ai.cloud.public',
    name: 'Use cloud AI on public data',
    description: 'Send public-tier content to external cloud models such as Claude.',
    category: 'AI model use',
    dataTier: 'public',
    risk: 'low',
  },
  {
    code: 'ai.cloud.internal_scrubbed',
    name: 'Use cloud AI on scrubbed internal data',
    description:
      'Send internal-tier content to cloud models only after the scrubbing gateway removes structures, compounds and sequences.',
    category: 'AI model use',
    dataTier: 'internal',
    risk: 'medium',
  },
  {
    code: 'ai.cloud.restricted',
    name: 'Use cloud AI on restricted data',
    description:
      'Send restricted content to cloud models. Only appropriate under an enterprise agreement with zero data retention.',
    category: 'AI model use',
    dataTier: 'restricted',
    risk: 'high',
  },
  {
    code: 'ai.local.restricted',
    name: 'Use local models on restricted data',
    description: 'Process restricted content with on-premises or self-hosted models that never leave the network.',
    category: 'AI model use',
    dataTier: 'restricted',
    risk: 'medium',
  },
  {
    code: 'ai.claude_code.repo',
    name: 'Grant Claude Code repository access',
    description: "Allow Claude Code sessions to read the account's code and analysis repositories.",
    category: 'AI model use',
    dataTier: 'internal',
    risk: 'medium',
  },

  // Sharing & export
  {
    code: 'share.aggregate_export',
    name: 'Export aggregate summaries',
    description: 'Export statistics and summaries that contain no raw records.',
    category: 'Sharing & export',
    dataTier: 'internal',
    risk: 'low',
  },
  {
    code: 'share.raw_export',
    name: 'Export raw data',
    description: 'Download or export raw records, structures or sequences.',
    category: 'Sharing & export',
    dataTier: 'restricted',
    risk: 'high',
  },
  {
    code: 'share.external_collaborators',
    name: 'Share with external collaborators',
    description: 'Give collaborators at other institutions or companies access to internal data.',
    category: 'Sharing & export',
    dataTier: 'internal',
    risk: 'medium',
  },
  {
    code: 'share.publication_approval',
    name: 'Approve data for publication',
    description: 'Release internal data to the public tier for papers, preprints or posters.',
    category: 'Sharing & export',
    dataTier: null,
    risk: 'medium',
  },

  // Governance
  {
    code: 'gov.audit.view',
    name: 'View audit log',
    description: 'See who accessed, changed or shared data within the account.',
    category: 'Governance',
    dataTier: null,
    risk: 'low',
  },
  {
    code: 'gov.users.manage',
    name: 'Manage account members',
    description: 'Add, suspend and change the roles of users in the account.',
    category: 'Governance',
    dataTier: null,
    risk: 'medium',
  },
  {
    code: 'gov.exceptions.approve',
    name: 'Approve policy exceptions',
    description: "Approve one-off requests that fall outside a user's role policies.",
    category: 'Governance',
    dataTier: null,
    risk: 'high',
  },
];

// Built-in starting roles: one for academic accounts, one for industry.
// Policies are only assigned when the role is first created, so later edits
// by the account manager are preserved across restarts.
export const SYSTEM_ROLES: RoleSeed[] = [
  {
    name: 'Principal Investigator',
    accountType: 'academic',
    description: 'Leads an academic lab. Owns its data and approves what is published or shared.',
    policyCodes: [
      'data.public.read',
      'data.internal.read',
      'data.restricted.read',
      'data.classify',
      'ai.cloud.public',
      'ai.cloud.internal_scrubbed',
      'ai.local.restricted',
      'ai.claude_code.repo',
      'share.aggregate_export',
      'share.external_collaborators',
      'share.publication_approval',
      'gov.audit.view',
      'gov.users.manage',
    ],
  },
  {
    name: 'Director',
    accountType: 'industry',
    description: 'Leads a research function at a company. Accountable for protecting proprietary programs.',
    policyCodes: [
      'data.public.read',
      'data.internal.read',
      'data.restricted.read',
      'data.classify',
      'ai.cloud.public',
      'ai.cloud.internal_scrubbed',
      'ai.local.restricted',
      'ai.claude_code.repo',
      'share.aggregate_export',
      'share.raw_export',
      'gov.audit.view',
      'gov.users.manage',
      'gov.exceptions.approve',
    ],
  },
];

export function seed(db: Database.Database): void {
  const upsertPolicy = db.prepare(`
    INSERT INTO policies (code, name, description, category, data_tier, risk, is_system, sort_order)
    VALUES (@code, @name, @description, @category, @dataTier, @risk, 1, @sortOrder)
    ON CONFLICT (code) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      category = excluded.category,
      data_tier = excluded.data_tier,
      risk = excluded.risk,
      sort_order = excluded.sort_order
    WHERE policies.is_system = 1
  `);
  const insertRole = db.prepare(`
    INSERT INTO roles (name, account_type, description, is_system)
    VALUES (@name, @accountType, @description, 1)
    ON CONFLICT (name, account_type) DO NOTHING
  `);
  const assignPolicy = db.prepare(`
    INSERT INTO role_policies (role_id, policy_id)
    SELECT ?, id FROM policies WHERE code = ?
  `);

  db.transaction(() => {
    POLICY_CATALOG.forEach((policy, index) => upsertPolicy.run({ ...policy, sortOrder: index }));

    for (const role of SYSTEM_ROLES) {
      const result = insertRole.run(role);
      if (result.changes === 0) continue;
      for (const code of role.policyCodes) assignPolicy.run(result.lastInsertRowid, code);
    }
  })();
}
