import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import type { Account, AuditEntry, Dataset, DatasetPreview, Grantee, Role, SessionInfo, User } from '../../shared/types';
import { createApp } from '../src/app';
import { parseCsv } from '../src/csv';
import { openDatabase, type DB } from '../src/db';

// Test-only credentials.
const MANAGER = { name: 'Morgan Admin', email: 'morgan@example.test', password: 'manager-pass-1' };
const MEMBER_PASSWORD = 'member-pass-1';

const CSV = [
  'sample_id,compound_id,smiles,target,ic50_nm,notes',
  'S-001,CMP-1001,CC(=O)Oc1ccccc1C(=O)O,KINASE-A,12.5,"promising, retest"',
  'S-002,CMP-1002,CN1C=NC2=C1C(=O)N(C(=O)N2C)C,KINASE-B,340,',
  'S-003,CMP-1001,CC(=O)Oc1ccccc1C(=O)O,KINASE-B,15.1,same compound as S-001',
].join('\n');

let db: DB;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let baseUrl: string;

type Client = {
  <T = unknown>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T }>;
  download: (url: string) => Promise<{ status: number; files: Record<string, string> }>;
};

function createClient(): Client {
  let cookie = '';
  const send = async (method: string, url: string, body?: unknown) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(baseUrl + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return res;
  };
  const client = (async (method: string, url: string, body?: unknown) => {
    const res = await send(method, url, body);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }) as Client;
  client.download = async (url) => {
    const res = await send('GET', url);
    if (!res.ok) return { status: res.status, files: {} };
    const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));
    return { status: res.status, files: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strFromU8(v)])) };
  };
  return client;
}

async function signIn(email: string, password = MEMBER_PASSWORD): Promise<Client> {
  const client = createClient();
  const res = await client('POST', '/auth/login', { email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return client;
}

const admin = createClient();
let account: Account;
let steward: Client;
let scientist: Client;
let scientistUser: User;
let datasetId: number;
const users: Record<string, User> = {};

before(async () => {
  db = openDatabase(':memory:');
  server = createApp(db).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  await admin('POST', '/auth/setup', MANAGER);
  account = (await admin<Account>('POST', '/accounts', { name: 'Acme Biologics', type: 'industry' })).body;
  const roles = (await admin<Role[]>('GET', '/roles?accountType=industry')).body;
  const roleId = (name: string) => roles.find((r) => r.name === name)!.id;

  const add = async (key: string, name: string, role: string, password: string | undefined = MEMBER_PASSWORD) => {
    const res = await admin<User>('POST', '/users', {
      accountId: account.id,
      roleId: roleId(role),
      name,
      email: `${key}@example.test`,
      password,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    users[key] = res.body;
  };
  await add('omar', 'Omar Haddad', 'Data Steward');
  await add('mia', 'Mia Torres', 'Research Scientist');
  await add('noah', 'Noah Kim', 'Research Scientist', undefined);
  await add('dana', 'Dana Lee', 'Director');
  scientistUser = users.mia;
});

after(() => {
  server.close();
  db.close();
});

describe('member sign-in', () => {
  test('members sign in with the same form and get their role policies', async () => {
    steward = await signIn('omar@example.test');
    const session = (await steward<SessionInfo>('GET', '/auth/session')).body;
    assert.equal(session.manager, null);
    assert.equal(session.member?.roleName, 'Data Steward');
    assert.ok(session.member?.policyCodes.includes('data.steward'));
    scientist = await signIn('mia@example.test');
  });

  test('members and managers are kept to their own areas', async () => {
    assert.equal((await steward('GET', '/accounts')).status, 403);
    assert.equal((await admin('GET', '/datasets')).status, 403);
  });

  test('a member without a password cannot sign in until a manager sets one', async () => {
    assert.equal((await createClient()('POST', '/auth/login', { email: 'noah@example.test', password: 'x' })).status, 401);
    const res = await admin<User>('PATCH', `/users/${users.noah.id}`, { password: MEMBER_PASSWORD });
    assert.equal(res.body.canSignIn, true);
    await signIn('noah@example.test');
  });

  test('suspending a member signs them out', async () => {
    const noah = await signIn('noah@example.test');
    await admin('PATCH', `/users/${users.noah.id}`, { status: 'suspended' });
    assert.equal((await noah('GET', '/datasets')).status, 401);
    assert.equal((await createClient()('POST', '/auth/login', { email: 'noah@example.test', password: MEMBER_PASSWORD })).status, 403);
    await admin('PATCH', `/users/${users.noah.id}`, { status: 'active' });
  });
});

describe('data steward', () => {
  test('uploads a CSV; columns start at the file classification and readable by Claude Code', async () => {
    assert.equal((await scientist('POST', '/datasets', { name: 'X', fileName: 'x.csv', csv: CSV })).status, 403);
    const bad = await steward<{ field: string }>('POST', '/datasets', { name: 'Bad', fileName: 'bad.csv', csv: 'a,b\n"1,2\n' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.field, 'csv');

    const res = await steward<Dataset>('POST', '/datasets', {
      name: 'Kinase screen batch 7',
      description: 'Primary screen against two kinases.',
      fileName: 'kinase_screen.csv',
      csv: CSV,
    });
    assert.equal(res.status, 201);
    datasetId = res.body.id;
    assert.equal(res.body.rowCount, 3);
    assert.deepEqual(
      res.body.columns.map((c) => [c.name, c.classification, c.claudeAccess]),
      ['sample_id', 'compound_id', 'smiles', 'target', 'ic50_nm', 'notes'].map((n) => [n, 'internal', 'allowed']),
    );
    assert.deepEqual(res.body.columns[1].samples, ['CMP-1001', 'CMP-1002']);
  });

  test('sets file and column policies', async () => {
    const res = await steward<Dataset>('PATCH', `/datasets/${datasetId}`, {
      columns: [
        { position: 1, claudeAccess: 'masked', description: 'Internal compound code' },
        { position: 2, classification: 'restricted' }, // steward allows it, but the scientist's role won't
        { position: 3, claudeAccess: 'blocked' },
        { position: 5, claudeAccess: 'blocked' },
      ],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.columns.map((c) => c.claudeAccess),
      ['allowed', 'masked', 'allowed', 'blocked', 'allowed', 'blocked'],
    );
    assert.equal(res.body.columns[2].classification, 'restricted');
  });

  test("previews the full data and Claude Code's view", async () => {
    const full = (await steward<DatasetPreview>('GET', `/datasets/${datasetId}/preview`)).body;
    assert.equal(full.columns.length, 6);
    assert.equal(full.rows[0][1], 'CMP-1001');

    const claude = (await steward<DatasetPreview>('GET', `/datasets/${datasetId}/preview?view=claude`)).body;
    assert.deepEqual(claude.columns, ['sample_id', 'compound_id', 'smiles', 'ic50_nm']);
    assert.match(claude.rows[0][1], /^MASK_[0-9a-f]{10}$/);
    assert.equal(claude.rows[0][1], claude.rows[2][1], 'same compound gets the same pseudonym');
    assert.notEqual(claude.rows[0][1], claude.rows[1][1]);
  });

  test('can only grant members whose role can download the dataset', async () => {
    const grantees = (await steward<Grantee[]>('GET', `/datasets/${datasetId}/grantees`)).body;
    assert.deepEqual(grantees.map((g) => g.name).sort(), ['Mia Torres', 'Noah Kim']);
    assert.equal((await steward('POST', `/datasets/${datasetId}/grants`, { userId: users.dana.id })).status, 400);
  });
});

describe('research scientist', () => {
  test('cannot see a dataset until it is shared with them', async () => {
    assert.deepEqual((await scientist<Dataset[]>('GET', '/datasets')).body, []);
    assert.equal((await scientist('GET', `/datasets/${datasetId}`)).status, 404);
    assert.equal((await scientist.download(`/datasets/${datasetId}/download`)).status, 404);

    assert.equal((await steward('POST', `/datasets/${datasetId}/grants`, { userId: scientistUser.id })).status, 201);
    assert.equal((await scientist<Dataset[]>('GET', '/datasets')).body.length, 1);
  });

  test("sees their effective access, combining the steward's policy with their role", async () => {
    const dataset = (await scientist<Dataset>('GET', `/datasets/${datasetId}`)).body;
    assert.equal(dataset.grants, undefined, 'scientists do not see who else has access');
    assert.deepEqual(dataset.download, { allowed: true });
    const byName = Object.fromEntries(dataset.effective!.map((c) => [c.name, c]));
    assert.equal(byName.compound_id.claudeAccess, 'masked');
    assert.equal(byName.target.claudeAccess, 'blocked');
    assert.equal(byName.smiles.inYourCopy, true);
    assert.equal(byName.smiles.claudeAccess, 'blocked');
    assert.match(byName.smiles.reason, /Use cloud AI on restricted data/);
  });

  test('downloads a bundle with the policy and Claude Code guardrails baked in', async () => {
    const { status, files } = await scientist.download(`/datasets/${datasetId}/download`);
    assert.equal(status, 200);
    const root = 'kinase-screen-batch-7/';
    assert.deepEqual(Object.keys(files).sort(), [
      `${root}.claude/hooks/enforce-data-policy.sh`,
      `${root}.claude/settings.json`,
      `${root}CLAUDE.md`,
      `${root}README.md`,
      `${root}claude-data/kinase_screen.claude.csv`,
      `${root}data-policy.json`,
      `${root}restricted-data/kinase_screen.restricted.csv`,
    ]);

    const yours = parseCsv(files[`${root}restricted-data/kinase_screen.restricted.csv`]);
    assert.deepEqual(yours[0], ['sample_id', 'compound_id', 'smiles', 'target', 'ic50_nm', 'notes']);
    assert.deepEqual(yours[1], ['S-001', 'CMP-1001', 'CC(=O)Oc1ccccc1C(=O)O', 'KINASE-A', '12.5', 'promising, retest']);
    assert.ok(!files[`${root}restricted-data/kinase_screen.restricted.csv`].includes('MASK_'), 'your copy has real values');

    const claudeCsv = files[`${root}claude-data/kinase_screen.claude.csv`];
    const claude = parseCsv(claudeCsv);
    assert.deepEqual(claude[0], ['sample_id', 'compound_id', 'ic50_nm']);
    for (const secret of ['CMP-1001', 'CC(=O)', 'KINASE-A', 'promising']) {
      assert.ok(!claudeCsv.includes(secret), `Claude Code copy must not contain ${secret}`);
    }

    const settings = JSON.parse(files[`${root}.claude/settings.json`]);
    assert.ok(settings.permissions.deny.includes('Read(/restricted-data/**)'));
    assert.ok(settings.permissions.deny.includes('Read(*.restricted.csv)'));
    assert.equal(settings.permissions.disableBypassPermissionsMode, 'disable');
    assert.equal(settings.sandbox.enabled, true);
    assert.deepEqual(settings.sandbox.filesystem.denyRead, ['./restricted-data']);
    assert.equal(settings.hooks.PreToolUse[0].matcher, '*');

    const policy = JSON.parse(files[`${root}data-policy.json`]);
    assert.equal(policy.issuedTo.email, 'mia@example.test');
    assert.deepEqual(policy.claudeCode.readable, ['claude-data/kinase_screen.claude.csv']);
    assert.deepEqual(
      policy.columns.map((c: { claudeCode: string }) => c.claudeCode),
      ['allowed', 'masked', 'blocked', 'blocked', 'allowed', 'blocked'],
    );
    assert.match(files[`${root}CLAUDE.md`], /`smiles`, `target`, `notes`/);
  });

  test('the hook blocks Claude Code tool calls that touch restricted data', async (t) => {
    const { files } = await scientist.download(`/datasets/${datasetId}/download`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const hook = path.join(dir, 'enforce-data-policy.sh');
    fs.writeFileSync(hook, files['kinase-screen-batch-7/.claude/hooks/enforce-data-policy.sh']);

    const run = (toolName: string, toolInput: Record<string, unknown>, cwd = '/work/kinase-screen-batch-7') =>
      spawnSync('bash', [hook], {
        input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd, tool_name: toolName, tool_input: toolInput }),
        encoding: 'utf8',
      });

    const blocked = [
      run('Read', { file_path: '/work/kinase-screen-batch-7/restricted-data/kinase_screen.restricted.csv' }),
      run('Bash', { command: 'cd restricted-data && head -5 kinase_screen.restricted.csv' }),
      run('Bash', { command: 'python3 -c "import pandas; pandas.read_csv(\'restricted-data/x.csv\')"' }),
      run('Write', { file_path: 'analysis.py', content: "df = pd.read_csv('restricted-data/kinase_screen.restricted.csv')" }),
      run('Grep', { pattern: 'KINASE', path: 'restricted-data' }),
      run('Bash', { command: 'cp ~/Downloads/other.restricted.csv .' }),
      run('Read', { file_path: 'C:\\work\\restricted-data\\kinase_screen.restricted.csv' }),
    ];
    for (const result of blocked) {
      assert.equal(result.status, 2, `expected block, got ${result.status}`);
      assert.match(result.stderr, /Blocked by this folder's data policy/);
    }

    const allowed = [
      run('Read', { file_path: '/work/kinase-screen-batch-7/claude-data/kinase_screen.claude.csv' }),
      run('Grep', { pattern: 'MASK_', path: 'claude-data' }),
      run('Bash', { command: 'ls' }, '/work/restricted-data-export'),
      run('Read', { file_path: 'data-policy.json' }),
    ];
    for (const result of allowed) assert.equal(result.status, 0, result.stderr);
  });

  test('a file-level block leaves Claude Code nothing to read', async () => {
    await steward('PATCH', `/datasets/${datasetId}`, { claudeAccess: 'blocked' });
    const { files } = await scientist.download(`/datasets/${datasetId}/download`);
    assert.ok(!Object.keys(files).some((f) => f.includes('claude-data/')));
    const policy = JSON.parse(files['kinase-screen-batch-7/data-policy.json']);
    assert.equal(policy.claudeCode.fileAccess, 'blocked');
    assert.match(files['kinase-screen-batch-7/CLAUDE.md'], /has not allowed Claude Code to read any data/);
    await steward('PATCH', `/datasets/${datasetId}`, { claudeAccess: 'allowed' });
  });

  test("columns above the member's clearance are left out of their own copy too", async () => {
    const internalOnly = await admin<Role>('POST', '/roles', {
      name: 'Lab Technician',
      accountType: 'industry',
      policyIds: (await admin<{ id: number; code: string }[]>('GET', '/policies')).body
        .filter((p) => ['data.internal.read', 'data.download', 'ai.cloud.internal_scrubbed'].includes(p.code))
        .map((p) => p.id),
    });
    const tech = await admin<User>('POST', '/users', {
      accountId: account.id,
      roleId: internalOnly.body.id,
      name: 'Tom Reyes',
      email: 'tom@example.test',
      password: MEMBER_PASSWORD,
    });
    await steward('POST', `/datasets/${datasetId}/grants`, { userId: tech.body.id });
    const { files } = await (await signIn('tom@example.test')).download(`/datasets/${datasetId}/download`);
    const yours = parseCsv(files['kinase-screen-batch-7/restricted-data/kinase_screen.restricted.csv']);
    assert.ok(!yours[0].includes('smiles'));
    assert.ok(!files['kinase-screen-batch-7/restricted-data/kinase_screen.restricted.csv'].includes('CC(=O)'));
  });

  test('revoking access removes the dataset', async () => {
    assert.equal((await steward('DELETE', `/datasets/${datasetId}/grants/${scientistUser.id}`)).status, 204);
    assert.equal((await scientist('GET', `/datasets/${datasetId}`)).status, 404);
  });
});

test('the audit log records member actions under their names', async () => {
  const { body } = await admin<AuditEntry[]>('GET', '/audit?entityType=dataset&limit=100');
  const actions = body.map((e) => `${e.action} by ${e.actor}`);
  for (const expected of [
    'dataset.uploaded by Omar Haddad',
    'dataset.policy_updated by Omar Haddad',
    'dataset.access_granted by Omar Haddad',
    'dataset.downloaded by Mia Torres',
    'dataset.access_revoked by Omar Haddad',
  ]) {
    assert.ok(actions.includes(expected), `expected "${expected}"`);
  }
  assert.ok(body.every((e) => e.actorKind === 'member' && e.actorId === null));
});
