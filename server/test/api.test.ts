import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type {
  Account,
  AuditEntry,
  Manager,
  Policy,
  Role,
  SessionInfo,
  User,
  UserWithPolicies,
} from '../../shared/types';
import { createApp } from '../src/app';
import { openDatabase, type DB } from '../src/db';
import { MIGRATIONS } from '../src/schema';
import { POLICY_CATALOG, SYSTEM_ROLES } from '../src/seed';

// Test-only credentials. Also used for local manual testing against a scratch database.
const FIRST_MANAGER = { name: 'Morgan Admin', email: 'morgan@example.test', password: 'correct-horse-battery' };
const SECOND_MANAGER = { name: 'Riley Ops', email: 'riley@example.test', password: 'second-manager-pass' };

let db: DB;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let baseUrl: string;

type Response<T> = { status: number; body: T };
type Client = <T = unknown>(method: string, url: string, body?: unknown) => Promise<Response<T>>;

/** A fetch wrapper that keeps its own session cookie, like a separate browser. */
function createClient(): Client {
  let cookie = '';
  return async (method, url, body) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(baseUrl + url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
}

const anon = () => createClient();
const admin = createClient();

before(async () => {
  db = openDatabase(':memory:');
  server = createApp(db).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(() => {
  server.close();
  db.close();
});

async function signIn(credentials: { email: string; password: string }): Promise<Client> {
  const client = createClient();
  const res = await client('POST', '/auth/login', credentials);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return client;
}

async function policyIdsByCode(codes: string[]): Promise<number[]> {
  const { body } = await admin<Policy[]>('GET', '/policies');
  return codes.map((code) => {
    const policy = body.find((p) => p.code === code);
    assert.ok(policy, `missing policy ${code}`);
    return policy.id;
  });
}

async function systemRole(accountType: 'academic' | 'industry'): Promise<Role> {
  const { body } = await admin<Role[]>('GET', `/roles?accountType=${accountType}`);
  const name = accountType === 'academic' ? 'Principal Investigator' : 'Director';
  const role = body.find((r) => r.isSystem && r.name === name);
  assert.ok(role);
  return role;
}

async function latestAudit(): Promise<AuditEntry> {
  const { body } = await admin<AuditEntry[]>('GET', '/audit?limit=1');
  return body[0];
}

describe('sign-in', () => {
  test('asks for setup on first run and rejects unauthenticated requests', async () => {
    const session = await anon()<SessionInfo>('GET', '/auth/session');
    assert.deepEqual(session.body, { manager: null, member: null, needsSetup: true });
    assert.equal((await anon()('GET', '/accounts')).status, 401);
    assert.equal((await anon()('GET', '/audit')).status, 401);
  });

  test('rejects a weak password during setup', async () => {
    const res = await anon()<{ field: string }>('POST', '/auth/setup', { ...FIRST_MANAGER, password: 'short' });
    assert.equal(res.status, 400);
    assert.equal(res.body.field, 'password');
  });

  test('sets up the first account manager and signs them in', async () => {
    const res = await admin<Manager>('POST', '/auth/setup', FIRST_MANAGER);
    assert.equal(res.status, 201);
    assert.equal(res.body.email, FIRST_MANAGER.email);

    const session = await admin<SessionInfo>('GET', '/auth/session');
    assert.equal(session.body.manager?.email, FIRST_MANAGER.email);
    assert.equal(session.body.needsSetup, false);
    assert.equal((await admin('GET', '/accounts')).status, 200);
  });

  test('allows setup only once', async () => {
    const res = await anon()('POST', '/auth/setup', { ...SECOND_MANAGER, email: 'intruder@example.test' });
    assert.equal(res.status, 409);
  });

  test('signs in with email and password, and signs out', async () => {
    const wrong = await anon()<{ error: string }>('POST', '/auth/login', { ...FIRST_MANAGER, password: 'nope-nope-nope' });
    assert.equal(wrong.status, 401);
    const unknown = await anon()<{ error: string }>('POST', '/auth/login', { email: 'who@example.test', password: 'x' });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.error, wrong.body.error, 'unknown email and wrong password look the same');

    const client = await signIn({ email: FIRST_MANAGER.email.toUpperCase(), password: FIRST_MANAGER.password });
    assert.equal((await client('GET', '/accounts')).status, 200);
    assert.equal((await client('POST', '/auth/logout')).status, 204);
    assert.equal((await client('GET', '/accounts')).status, 401);
  });
});

describe('account managers', () => {
  let riley: Manager;

  test('a manager can add another manager', async () => {
    const res = await admin<Manager>('POST', '/managers', SECOND_MANAGER);
    assert.equal(res.status, 201);
    riley = res.body;
    const dup = await admin<{ field: string }>('POST', '/managers', SECOND_MANAGER);
    assert.equal(dup.status, 409);
    assert.equal(dup.body.field, 'email');
  });

  test('cannot deactivate yourself', async () => {
    const me = (await admin<SessionInfo>('GET', '/auth/session')).body.manager!;
    assert.equal((await admin('PATCH', `/managers/${me.id}`, { status: 'deactivated' })).status, 400);
  });

  test('deactivating a manager signs them out and blocks sign-in', async () => {
    const rileyClient = await signIn(SECOND_MANAGER);
    assert.equal((await admin('PATCH', `/managers/${riley.id}`, { status: 'deactivated' })).status, 200);
    assert.equal((await rileyClient('GET', '/accounts')).status, 401);
    assert.equal((await anon()('POST', '/auth/login', SECOND_MANAGER)).status, 403);

    assert.equal((await admin('PATCH', `/managers/${riley.id}`, { status: 'active' })).status, 200);
    await signIn(SECOND_MANAGER);
  });

  test('resetting another manager\'s password signs them out', async () => {
    const rileyClient = await signIn(SECOND_MANAGER);
    const newPassword = 'temporary-pass-123';
    assert.equal((await admin('PATCH', `/managers/${riley.id}`, { password: newPassword })).status, 200);
    assert.equal((await rileyClient('GET', '/accounts')).status, 401);
    assert.equal((await anon()('POST', '/auth/login', SECOND_MANAGER)).status, 401);
    await signIn({ email: SECOND_MANAGER.email, password: newPassword });
    assert.equal((await admin('PATCH', `/managers/${riley.id}`, { password: SECOND_MANAGER.password })).status, 200);
  });

  test('changing your own password keeps this session and ends the others', async () => {
    const thisSession = await signIn(SECOND_MANAGER);
    const otherSession = await signIn(SECOND_MANAGER);
    const bad = await thisSession<{ field: string }>('POST', '/auth/password', {
      currentPassword: 'wrong-password',
      newPassword: 'another-long-pass',
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.field, 'currentPassword');

    const ok = await thisSession('POST', '/auth/password', {
      currentPassword: SECOND_MANAGER.password,
      newPassword: 'another-long-pass',
    });
    assert.equal(ok.status, 204);
    assert.equal((await thisSession('GET', '/accounts')).status, 200);
    assert.equal((await otherSession('GET', '/accounts')).status, 401);
    SECOND_MANAGER.password = 'another-long-pass';
  });
});

describe('baked-in data', () => {
  test('seeds the full policy catalog as built-in policies', async () => {
    const { status, body } = await admin<Policy[]>('GET', '/policies');
    assert.equal(status, 200);
    assert.deepEqual(
      body.filter((p) => p.isSystem).map((p) => p.code),
      POLICY_CATALOG.map((p) => p.code),
    );
  });

  test('seeds Principal Investigator (academic) and Director (industry) with policies', async () => {
    const pi = await systemRole('academic');
    const director = await systemRole('industry');
    assert.equal(pi.name, 'Principal Investigator');
    assert.equal(director.name, 'Director');
    assert.ok(pi.policyIds.length > 0);
    assert.ok(director.policyIds.length > 0);
  });
});

describe('account management', () => {
  let lab: Account;
  let company: Account;

  test('creates academic and industry accounts', async () => {
    const a = await admin<Account>('POST', '/accounts', { name: 'Okafor Lab', type: 'academic' });
    const b = await admin<Account>('POST', '/accounts', { name: 'Acme Biologics', type: 'industry', description: 'Antibody discovery' });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    lab = a.body;
    company = b.body;
    assert.equal(lab.userCount, 0);
  });

  test('rejects duplicate account names and invalid types', async () => {
    const dup = await admin('POST', '/accounts', { name: 'okafor lab', type: 'academic' });
    assert.equal(dup.status, 409);
    const bad = await admin<{ field: string }>('POST', '/accounts', { name: 'X', type: 'government' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.field, 'type');
  });

  test('creates a custom role from selected policies and assigns it to a user', async () => {
    const policyIds = await policyIdsByCode(['data.public.read', 'data.internal.read', 'ai.cloud.public']);
    const role = await admin<Role>('POST', '/roles', {
      name: 'Graduate Student',
      accountType: 'academic',
      policyIds,
    });
    assert.equal(role.status, 201);
    assert.deepEqual(role.body.policyIds, [...policyIds].sort((a, b) => a - b));
    assert.equal(role.body.isSystem, false);

    const user = await admin<User>('POST', '/users', {
      accountId: lab.id,
      roleId: role.body.id,
      name: 'Sam Rivera',
      email: 'Sam.Rivera@Example.edu ',
    });
    assert.equal(user.status, 201);
    assert.equal(user.body.email, 'sam.rivera@example.edu');
    assert.equal(user.body.roleName, 'Graduate Student');

    const detail = await admin<UserWithPolicies>('GET', `/users/${user.body.id}`);
    assert.deepEqual(
      detail.body.policies.map((p) => p.code),
      ['data.public.read', 'data.internal.read', 'ai.cloud.public'],
    );
  });

  test('only allows roles that match the account type', async () => {
    const director = await systemRole('industry');
    const res = await admin<{ field: string }>('POST', '/users', {
      accountId: lab.id,
      roleId: director.id,
      name: 'Wrong Role',
      email: 'wrong@example.edu',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.field, 'roleId');

    const ok = await admin<User>('POST', '/users', {
      accountId: company.id,
      roleId: director.id,
      name: 'Dana Lee',
      email: 'dana@example.com',
    });
    assert.equal(ok.status, 201);
  });

  test('rejects duplicate emails', async () => {
    const pi = await systemRole('academic');
    const res = await admin<{ field: string }>('POST', '/users', {
      accountId: lab.id,
      roleId: pi.id,
      name: 'Dup',
      email: 'SAM.RIVERA@example.edu',
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.field, 'email');
  });

  test("changing a role's policies changes its users' effective policies", async () => {
    const pi = await systemRole('academic');
    const piUser = await admin<User>('POST', '/users', {
      accountId: lab.id,
      roleId: pi.id,
      name: 'Ada Okafor',
      email: 'ada@example.edu',
    });
    const [restricted] = await policyIdsByCode(['data.restricted.read']);
    const updated = await admin<Role>('PATCH', `/roles/${pi.id}`, {
      policyIds: pi.policyIds.filter((id) => id !== restricted),
    });
    assert.equal(updated.status, 200);

    const detail = await admin<UserWithPolicies>('GET', `/users/${piUser.body.id}`);
    assert.ok(!detail.body.policies.some((p) => p.code === 'data.restricted.read'));
  });

  test('protects built-in roles and roles that are in use', async () => {
    const pi = await systemRole('academic');
    assert.equal((await admin('DELETE', `/roles/${pi.id}`)).status, 400);
    assert.equal((await admin('PATCH', `/roles/${pi.id}`, { name: 'PI' })).status, 400);

    const roles = await admin<Role[]>('GET', '/roles?accountType=academic');
    const grad = roles.body.find((r) => r.name === 'Graduate Student')!;
    assert.equal((await admin('DELETE', `/roles/${grad.id}`)).status, 409);
  });

  test('deleting an account removes its users', async () => {
    assert.equal((await admin('DELETE', `/accounts/${company.id}`)).status, 204);
    const users = await admin<User[]>('GET', `/users?accountId=${company.id}`);
    assert.deepEqual(users.body, []);
  });
});

describe('custom policies', () => {
  let policy: Policy;

  test('creates a custom policy with a generated code', async () => {
    const res = await admin<Policy>('POST', '/policies', {
      name: 'Export lab notebooks',
      description: 'Download electronic lab notebook entries as PDF.',
      category: 'Sharing & export',
      dataTier: 'internal',
      risk: 'medium',
    });
    assert.equal(res.status, 201);
    policy = res.body;
    assert.equal(policy.code, 'custom.export_lab_notebooks');
    assert.equal(policy.isSystem, false);

    const catalog = await admin<Policy[]>('GET', '/policies');
    assert.ok(catalog.body.some((p) => p.id === policy.id));
  });

  test('validates codes and rejects duplicates', async () => {
    const base = { name: 'X', description: 'Y', category: 'Z', risk: 'low' };
    const badCode = await admin<{ field: string }>('POST', '/policies', { ...base, code: 'data.public.read' });
    assert.equal(badCode.status, 400);
    assert.equal(badCode.body.field, 'code');
    const dup = await admin<{ field: string }>('POST', '/policies', { ...base, code: 'custom.export_lab_notebooks' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.field, 'code');
    const custom = await admin<Policy>('POST', '/policies', { ...base, code: 'custom.Sequence.Share', category: 'New area' });
    assert.equal(custom.status, 201);
    assert.equal(custom.body.code, 'custom.sequence.share');
    assert.equal(custom.body.dataTier, null);
    assert.equal((await admin('DELETE', `/policies/${custom.body.id}`)).status, 204);
  });

  test('edits a custom policy but not a built-in one', async () => {
    const res = await admin<Policy>('PATCH', `/policies/${policy.id}`, { risk: 'high', dataTier: 'restricted' });
    assert.equal(res.status, 200);
    assert.equal(res.body.risk, 'high');
    assert.equal(res.body.dataTier, 'restricted');
    assert.equal(res.body.code, 'custom.export_lab_notebooks');

    const [builtIn] = await policyIdsByCode(['data.public.read']);
    assert.equal((await admin('PATCH', `/policies/${builtIn}`, { risk: 'high' })).status, 400);
    assert.equal((await admin('DELETE', `/policies/${builtIn}`)).status, 400);
  });

  test('can be assigned to roles and cannot be deleted while in use', async () => {
    const pi = await systemRole('academic');
    await admin('PATCH', `/roles/${pi.id}`, { policyIds: [...pi.policyIds, policy.id] });
    const users = await admin<User[]>('GET', '/users');
    const ada = users.body.find((u) => u.name === 'Ada Okafor')!;
    const detail = await admin<UserWithPolicies>('GET', `/users/${ada.id}`);
    assert.ok(detail.body.policies.some((p) => p.code === 'custom.export_lab_notebooks'));

    const blocked = await admin<{ error: string }>('DELETE', `/policies/${policy.id}`);
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /Principal Investigator/);

    await admin('PATCH', `/roles/${pi.id}`, { policyIds: pi.policyIds });
    assert.equal((await admin('DELETE', `/policies/${policy.id}`)).status, 204);
  });
});

describe('audit log', () => {
  test('records which manager made each change', async () => {
    const riley = await signIn(SECOND_MANAGER);
    const created = await riley<Account>('POST', '/accounts', { name: 'Riley Test Account', type: 'industry' });
    assert.equal(created.status, 201);

    const entry = await latestAudit();
    assert.equal(entry.action, 'account.created');
    assert.equal(entry.actor, SECOND_MANAGER.name);
    assert.equal(entry.actorEmail, SECOND_MANAGER.email);

    const { body } = await admin<AuditEntry[]>('GET', '/audit?limit=500');
    const actions = new Set(body.map((e) => e.action));
    for (const action of [
      'manager.created',
      'manager.deactivated',
      'manager.password_reset',
      'manager.password_changed',
      'account.created',
      'role.created',
      'role.updated',
      'user.created',
      'policy.created',
      'policy.updated',
      'policy.deleted',
    ]) {
      assert.ok(actions.has(action), `expected ${action} in audit log`);
    }
    assert.ok(body.every((e) => e.actorId !== null && e.actorEmail), 'every entry names a manager');
    const roleUpdate = body.find(
      (e) => e.action === 'role.updated' && (e.details.policiesRemoved as string[] | undefined)?.includes('data.restricted.read'),
    );
    assert.ok(roleUpdate, 'role policy removal is recorded');
    assert.equal(roleUpdate.actor, FIRST_MANAGER.name);
  });

  test('filters by manager', async () => {
    const managers = await admin<Manager[]>('GET', '/managers');
    const riley = managers.body.find((m) => m.email === SECOND_MANAGER.email)!;
    const { body } = await admin<AuditEntry[]>('GET', `/audit?actorId=${riley.id}`);
    assert.ok(body.length > 0);
    assert.ok(body.every((e) => e.actorId === riley.id));
  });
});

test('re-opening a database is idempotent and keeps manager edits and custom policies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-'));
  const file = path.join(dir, 'test.db');
  try {
    const first = openDatabase(file);
    const piId = (first.prepare("SELECT id FROM roles WHERE name = 'Principal Investigator'").get() as { id: number }).id;
    first.prepare('DELETE FROM role_policies WHERE role_id = ?').run(piId);
    first
      .prepare("INSERT INTO policies (code, name, description, category, risk) VALUES ('custom.x', 'X', 'X', 'X', 'low')")
      .run();
    first.close();

    const second = openDatabase(file);
    const counts = second
      .prepare(
        `SELECT (SELECT COUNT(*) FROM policies WHERE is_system = 1) AS builtIn,
                (SELECT COUNT(*) FROM policies WHERE is_system = 0) AS custom,
                (SELECT COUNT(*) FROM roles) AS roles,
                (SELECT COUNT(*) FROM role_policies WHERE role_id = ?) AS piPolicies`,
      )
      .get(piId);
    const version = second.pragma('user_version', { simple: true });
    second.close();
    assert.deepEqual(counts, { builtIn: POLICY_CATALOG.length, custom: 1, roles: SYSTEM_ROLES.length, piPolicies: 0 });
    assert.equal(version, MIGRATIONS.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
