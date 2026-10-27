// Loads demo data into an empty database: two account managers who can sign in, one academic and one
// industry account, custom roles, a custom policy, and members in every role.
// Everything goes through the real API so validation and audit log entries match normal use.
//
// These credentials are for local demos only. Never reuse them on a server others can reach.
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Account, Policy, Role } from '../../shared/types';
import { createApp } from './app';
import { openDatabase } from './db';

export const DEMO_MANAGERS = [
  { name: 'Morgan Admin', email: 'morgan@demo.test', password: '1234ABCDe' },
  { name: 'Riley Ops', email: 'riley@demo.test', password: '1234ABCDe' },
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

// Each account is created by a different manager so the audit log shows both.
const DEMO_ACCOUNTS = [
  {
    createdBy: 0,
    account: {
      name: 'Okafor Structural Biology Lab',
      type: 'academic',
      description: 'Cryo-EM structures of membrane transporters.',
    },
    members: [
      { name: 'Ada Okafor', email: 'ada.okafor@demo.test', role: 'Principal Investigator' },
      { name: 'Sam Rivera', email: 'sam.rivera@demo.test', role: 'Postdoctoral Researcher' },
      { name: 'Priya Nair', email: 'priya.nair@demo.test', role: 'Graduate Student' },
    ],
  },
  {
    createdBy: 1,
    account: { name: 'Acme Biologics', type: 'industry', description: 'Antibody discovery for autoimmune targets.' },
    members: [
      { name: 'Dana Lee', email: 'dana.lee@demo.test', role: 'Director' },
      { name: 'Jordan Kim', email: 'jordan.kim@demo.test', role: 'Senior Scientist' },
    ],
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
const { n: existing } = db.prepare('SELECT (SELECT COUNT(*) FROM managers) + (SELECT COUNT(*) FROM accounts) AS n').get() as {
  n: number;
};
if (existing > 0) {
  db.close();
  console.error(`${dbPath} already has data. Run "npm run db:reset" first if you want to replace it with demo data.`);
  process.exit(1);
}

const server = createApp(db).listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

try {
  const [first, second] = DEMO_MANAGERS;
  const morgan = createClient(baseUrl);
  await morgan('POST', '/auth/setup', first);
  await morgan('POST', '/managers', second);
  const riley = createClient(baseUrl);
  await riley('POST', '/auth/login', { email: second.email, password: second.password });
  const managers = [morgan, riley];

  await morgan('POST', '/policies', CUSTOM_POLICY);
  const policies = await morgan<Policy[]>('GET', '/policies');
  const policyId = (code: string) => policies.find((p) => p.code === code)!.id;

  for (const role of CUSTOM_ROLES) {
    await morgan('POST', '/roles', {
      name: role.name,
      accountType: role.accountType,
      description: role.description,
      policyIds: role.policyCodes.map(policyId),
    });
  }
  const roles = await morgan<Role[]>('GET', '/roles');
  const roleId = (name: string) => roles.find((r) => r.name === name)!.id;

  for (const { createdBy, account, members } of DEMO_ACCOUNTS) {
    const client = managers[createdBy];
    const created = await client<Account>('POST', '/accounts', account);
    for (const member of members) {
      await client('POST', '/users', { accountId: created.id, roleId: roleId(member.role), name: member.name, email: member.email });
    }
  }

  console.log(`Loaded demo data into ${dbPath}\n`);
  console.log('Account managers (can sign in; passwords are in server/src/seed-demo.ts):');
  for (const m of DEMO_MANAGERS) console.log(`  ${m.name.padEnd(14)} ${m.email}`);
  console.log('\nAccount members (records only; members do not sign in yet):');
  for (const { account, members } of DEMO_ACCOUNTS) {
    console.log(`  ${account.name} (${account.type})`);
    for (const m of members) console.log(`    ${m.role.padEnd(24)} ${m.name.padEnd(12)} ${m.email}`);
  }
} finally {
  server.close();
  db.close();
}
