// Adds demo data: two account managers, an academic and an industry account, custom roles, a custom policy,
// members in every role (all able to sign in), and a CSV dataset per account with column policies and a grant.
// It only adds what is missing, so it is safe to run again on a database that already has demo data.
// Everything goes through the real API so validation and audit log entries match normal use.
//
// These credentials are for local demos only. Never reuse them on a server others can reach.
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Account, Dataset, Manager, Policy, Role, SessionInfo, User } from '../../shared/types';
import { createApp } from './app';
import { toCsv } from './csv';
import { openDatabase } from './db';

/** Every demo manager and member signs in with this password. */
export const DEMO_PASSWORD = '1234ABCDe';

export const DEMO_MANAGERS = [
  { name: 'Morgan Admin', email: 'morgan@demo.test' },
  { name: 'Riley Ops', email: 'riley@demo.test' },
];

const CUSTOM_POLICY = {
  name: 'Export lab notebooks',
  description: 'Download electronic lab notebook entries as PDF.',
  category: 'Sharing & export',
  dataTier: 'internal',
  risk: 'medium',
};

const CUSTOM_ROLES = [
  {
    name: 'Postdoctoral Researcher',
    accountType: 'academic',
    description: 'Runs projects in the lab under the PI. Can use cloud AI only on scrubbed internal data.',
    policyCodes: ['data.public.read', 'data.internal.read', 'ai.cloud.public', 'ai.cloud.internal_scrubbed', 'share.aggregate_export'],
  },
  {
    name: 'Graduate Student',
    accountType: 'academic',
    description: 'Works on a thesis project. Read access to public and internal data.',
    policyCodes: ['data.public.read', 'data.internal.read', 'ai.cloud.public'],
  },
  {
    name: 'Senior Scientist',
    accountType: 'industry',
    description: 'Leads experiments on a program. Restricted data stays on local models.',
    policyCodes: [
      'data.public.read',
      'data.internal.read',
      'data.restricted.read',
      'ai.cloud.public',
      'ai.cloud.internal_scrubbed',
      'ai.local.restricted',
      'share.aggregate_export',
      'custom.export_lab_notebooks',
    ],
  },
] as const;

// Small deterministic random generator so the demo data is the same on every run.
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(rand: () => number, items: readonly T[]) => items[Math.floor(rand() * items.length)];

function kinaseScreenCsv(): string {
  const rand = random(7);
  const compounds = [
    ['CMP-10421', 'CC(=O)Nc1ccc(O)cc1'],
    ['CMP-10458', 'Cc1ccc(NC(=O)c2ccc(CN3CCN(C)CC3)cc2)cc1Nc1nccc(-c2cccnc2)n1'],
    ['CMP-10477', 'COc1cc2ncnc(Nc3ccc(F)c(Cl)c3)c2cc1OCCCN1CCOCC1'],
    ['CMP-10502', 'CN1CCN(CC1)c1ccc(cc1)C(=O)Nc1ccc(C)c(c1)Nc1nccc(n1)-c1cccnc1'],
    ['CMP-10533', 'O=C(Nc1ccccc1)c1ccc(cc1)N1CCOCC1'],
    ['CMP-10561', 'Cc1cnc(Nc2ccc(cc2)N2CCNCC2)nc1Nc1cccc(c1)S(=O)(=O)N'],
  ];
  const targets = ['KIN-ALPHA', 'KIN-BETA', 'KIN-GAMMA'];
  const scientists = ['J. Alvarez', 'R. Chen', 'S. Okoye'];
  const notes = ['', '', '', 'Precipitate at top concentration', 'Repeat with fresh stock', 'Promising, follow up in cell assay', 'Edge effect on plate'];
  const rows: string[][] = [
    ['sample_id', 'compound_id', 'smiles', 'target', 'assay', 'concentration_um', 'inhibition_pct', 'ic50_nm', 'run_date', 'scientist', 'notes'],
  ];
  for (let i = 1; i <= 36; i++) {
    const [compound, smiles] = pick(rand, compounds);
    const concentration = pick(rand, [0.1, 1, 10]);
    const inhibition = Math.min(99.5, Math.max(0, 20 + rand() * 80 * Math.log10(concentration * 10 + 1)));
    rows.push([
      `KS7-${String(i).padStart(3, '0')}`,
      compound,
      smiles,
      pick(rand, targets),
      pick(rand, ['TR-FRET', 'ADP-Glo']),
      String(concentration),
      inhibition.toFixed(1),
      (5 + rand() * 900).toFixed(1),
      `2026-09-${String(1 + Math.floor(rand() * 28)).padStart(2, '0')}`,
      pick(rand, scientists),
      pick(rand, notes),
    ]);
  }
  return toCsv(rows);
}

function transporterBindingCsv(): string {
  const rand = random(11);
  const residues = 'ACDEFGHIKLMNPQRSTVWY';
  const sequence = (length: number) => Array.from({ length }, () => pick(rand, residues.split(''))).join('');
  const rows: string[][] = [['construct_id', 'protein_sequence', 'mutation', 'ligand', 'kd_nm', 'temperature_c', 'notes']];
  for (let i = 1; i <= 24; i++) {
    rows.push([
      `TB-${String(i).padStart(2, '0')}`,
      `M${sequence(58)}`,
      pick(rand, ['WT', 'L112A', 'F240W', 'D79N', 'G301S']),
      pick(rand, ['LIG-A7', 'LIG-B2', 'LIG-C9', 'LIG-D4']),
      (0.5 + rand() * 450).toFixed(2),
      pick(rand, ['4', '20', '37']),
      pick(rand, ['', '', 'Low expression', 'Aggregated after 24 h', 'Use for cryo-EM grid']),
    ]);
  }
  return toCsv(rows);
}

type ColumnPolicy = { classification?: 'public' | 'internal' | 'restricted'; claudeAccess?: 'allowed' | 'masked' | 'blocked'; description?: string };

// Each account is created by a different manager so the audit log shows both.
const DEMO_ACCOUNTS = [
  {
    createdBy: 0,
    account: { name: 'Okafor Structural Biology Lab', type: 'academic', description: 'Cryo-EM structures of membrane transporters.' },
    members: [
      { name: 'Ada Okafor', email: 'ada.okafor@demo.test', role: 'Principal Investigator' },
      { name: 'Sam Rivera', email: 'sam.rivera@demo.test', role: 'Postdoctoral Researcher' },
      { name: 'Priya Nair', email: 'priya.nair@demo.test', role: 'Graduate Student' },
      { name: 'Grace Mensah', email: 'grace.mensah@demo.test', role: 'Data Steward' },
      { name: 'Leo Park', email: 'leo.park@demo.test', role: 'Research Scientist' },
    ],
    dataset: {
      steward: 'grace.mensah@demo.test',
      sharedWith: ['leo.park@demo.test'],
      name: 'Transporter binding assays',
      description: 'Binding affinities for transporter constructs against the lab ligand panel.',
      fileName: 'transporter_binding.csv',
      csv: transporterBindingCsv,
      columns: {
        protein_sequence: { classification: 'restricted', claudeAccess: 'blocked', description: 'Unpublished construct sequence' },
        ligand: { claudeAccess: 'masked', description: 'Internal ligand code' },
        notes: { claudeAccess: 'blocked', description: 'Free text; may name collaborators' },
      } as Record<string, ColumnPolicy>,
    },
  },
  {
    createdBy: 1,
    account: { name: 'Acme Biologics', type: 'industry', description: 'Antibody discovery for autoimmune targets.' },
    members: [
      { name: 'Dana Lee', email: 'dana.lee@demo.test', role: 'Director' },
      { name: 'Jordan Kim', email: 'jordan.kim@demo.test', role: 'Senior Scientist' },
      { name: 'Omar Haddad', email: 'omar.haddad@demo.test', role: 'Data Steward' },
      { name: 'Mia Torres', email: 'mia.torres@demo.test', role: 'Research Scientist' },
    ],
    dataset: {
      steward: 'omar.haddad@demo.test',
      sharedWith: ['mia.torres@demo.test'],
      name: 'Kinase inhibitor screen batch 7',
      description: 'Primary biochemical screen of the KS7 compound set against three kinase targets.',
      fileName: 'kinase_screen_batch7.csv',
      csv: kinaseScreenCsv,
      columns: {
        compound_id: { claudeAccess: 'masked', description: 'Internal compound code' },
        smiles: { classification: 'restricted', claudeAccess: 'blocked', description: 'Compound structure' },
        // The steward would allow pseudonyms, but research scientists can't send restricted data to cloud AI.
        target: { classification: 'restricted', claudeAccess: 'masked', description: 'Program target' },
        scientist: { claudeAccess: 'masked', description: 'Who ran the assay' },
        notes: { claudeAccess: 'blocked', description: 'Free text from the lab notebook' },
      } as Record<string, ColumnPolicy>,
    },
  },
] as const;

type Client = <T>(method: string, url: string, body?: unknown) => Promise<T>;

function createClient(baseUrl: string): Client {
  let cookie = '';
  return async <T>(method: string, url: string, body?: unknown) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(baseUrl + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const data = res.status === 204 ? undefined : await res.json();
    if (!res.ok) throw new Error(`${method} ${url} failed (${res.status}): ${data?.error}`);
    return data as T;
  };
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dbPath = process.env.DB_PATH ?? path.join(root, 'data', 'governance.db');

const db = openDatabase(dbPath);
const server = createApp(db).listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
const added: string[] = [];

try {
  const [first, second] = DEMO_MANAGERS;
  const morgan = createClient(baseUrl);
  const session = await morgan<SessionInfo>('GET', '/auth/session');
  if (session.needsSetup) {
    await morgan('POST', '/auth/setup', { ...first, password: DEMO_PASSWORD });
    added.push(`manager ${first.email}`);
  } else {
    await morgan('POST', '/auth/login', { email: first.email, password: DEMO_PASSWORD }).catch(() => {
      throw new Error(`Could not sign in as ${first.email} with the demo password. Run "npm run db:reset" to start over.`);
    });
  }
  const managers = await morgan<Manager[]>('GET', '/managers');
  if (!managers.some((m) => m.email === second.email)) {
    await morgan('POST', '/managers', { ...second, password: DEMO_PASSWORD });
    added.push(`manager ${second.email}`);
  }
  const riley = createClient(baseUrl);
  await riley('POST', '/auth/login', { email: second.email, password: DEMO_PASSWORD });
  const managerClients = [morgan, riley];

  let policies = await morgan<Policy[]>('GET', '/policies');
  if (!policies.some((p) => p.code === 'custom.export_lab_notebooks')) {
    await morgan('POST', '/policies', CUSTOM_POLICY);
    policies = await morgan<Policy[]>('GET', '/policies');
    added.push('custom policy custom.export_lab_notebooks');
  }
  const policyId = (code: string) => policies.find((p) => p.code === code)!.id;

  let roles = await morgan<Role[]>('GET', '/roles');
  for (const role of CUSTOM_ROLES) {
    if (roles.some((r) => r.name === role.name && r.accountType === role.accountType)) continue;
    await morgan('POST', '/roles', {
      name: role.name,
      accountType: role.accountType,
      description: role.description,
      policyIds: role.policyCodes.map(policyId),
    });
    added.push(`role ${role.name}`);
  }
  roles = await morgan<Role[]>('GET', '/roles');

  const accounts = await morgan<Account[]>('GET', '/accounts');
  const users = await morgan<User[]>('GET', '/users');
  for (const { createdBy, account, members, dataset } of DEMO_ACCOUNTS) {
    const client = managerClients[createdBy];
    const existing = accounts.find((a) => a.name === account.name);
    const accountId = existing?.id ?? (await client<Account>('POST', '/accounts', account)).id;
    if (!existing) added.push(`account ${account.name}`);

    for (const member of members) {
      const roleId = roles.find((r) => r.name === member.role && r.accountType === account.type)!.id;
      const user = users.find((u) => u.email === member.email);
      if (!user) {
        await client('POST', '/users', { accountId, roleId, name: member.name, email: member.email, password: DEMO_PASSWORD });
        added.push(`member ${member.email}`);
      } else if (!user.canSignIn) {
        await client('PATCH', `/users/${user.id}`, { password: DEMO_PASSWORD });
        added.push(`sign-in for ${member.email}`);
      }
    }

    const steward = createClient(baseUrl);
    await steward('POST', '/auth/login', { email: dataset.steward, password: DEMO_PASSWORD });
    const datasets = await steward<Dataset[]>('GET', '/datasets');
    if (datasets.some((d) => d.name === dataset.name)) continue;

    const created = await steward<Dataset>('POST', '/datasets', {
      name: dataset.name,
      description: dataset.description,
      fileName: dataset.fileName,
      csv: dataset.csv(),
    });
    await steward('PATCH', `/datasets/${created.id}`, {
      columns: created.columns
        .filter((c) => dataset.columns[c.name])
        .map((c) => ({ position: c.position, ...dataset.columns[c.name] })),
    });
    const memberIds = await morgan<User[]>('GET', `/users?accountId=${accountId}`);
    for (const email of dataset.sharedWith) {
      await steward('POST', `/datasets/${created.id}/grants`, { userId: memberIds.find((u) => u.email === email)!.id });
    }
    added.push(`dataset "${dataset.name}" shared with ${dataset.sharedWith.join(', ')}`);
  }

  console.log(added.length ? `Added to ${dbPath}:\n  ${added.join('\n  ')}\n` : `Demo data already complete in ${dbPath}\n`);
  console.log(`Everyone below signs in with the demo password in server/src/seed-demo.ts.\n`);
  console.log('Account managers:');
  for (const m of DEMO_MANAGERS) console.log(`  ${m.name.padEnd(14)} ${m.email}`);
  for (const { account, members } of DEMO_ACCOUNTS) {
    console.log(`\n${account.name} (${account.type}):`);
    for (const m of members) console.log(`  ${m.role.padEnd(24)} ${m.name.padEnd(13)} ${m.email}`);
  }
} finally {
  server.close();
  db.close();
}
