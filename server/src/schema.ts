// Each entry upgrades the database by one version, tracked in PRAGMA user_version.
// Never edit a migration once it has been used on real data; append a new one instead.
export const MIGRATIONS: string[] = [
  // 1: initial schema
  `
  CREATE TABLE accounts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    type        TEXT NOT NULL CHECK (type IN ('academic', 'industry')),
    description TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Built-in policies are synced from the seed; custom ones are created by account managers.
  CREATE TABLE policies (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL,
    category    TEXT NOT NULL,
    data_tier   TEXT CHECK (data_tier IN ('public', 'internal', 'restricted')),
    risk        TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
    is_system   INTEGER NOT NULL DEFAULT 0,
    sort_order  INTEGER NOT NULL DEFAULT 0
  );

  -- Roles apply to one kind of account (academic or industry).
  CREATE TABLE roles (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL COLLATE NOCASE,
    account_type TEXT NOT NULL CHECK (account_type IN ('academic', 'industry')),
    description  TEXT NOT NULL DEFAULT '',
    is_system    INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (name, account_type)
  );

  CREATE TABLE role_policies (
    role_id   INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    policy_id INTEGER NOT NULL REFERENCES policies(id) ON DELETE RESTRICT,
    PRIMARY KEY (role_id, policy_id)
  );
  CREATE INDEX role_policies_policy_id ON role_policies(policy_id);

  CREATE TABLE users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX users_account_id ON users(account_id);
  CREATE INDEX users_role_id ON users(role_id);

  -- Account managers sign in to this console. They are not members of any account.
  CREATE TABLE managers (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated')),
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Only a SHA-256 hash of each session token is stored.
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    manager_id INTEGER NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at TEXT NOT NULL
  );
  CREATE INDEX sessions_manager_id ON sessions(manager_id);

  -- actor and actor_email are snapshots so entries stay readable if a manager is renamed.
  CREATE TABLE audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id    INTEGER REFERENCES managers(id) ON DELETE SET NULL,
    actor       TEXT NOT NULL,
    actor_email TEXT,
    action      TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id   INTEGER,
    summary     TEXT NOT NULL,
    details     TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX audit_log_created_at ON audit_log(created_at);
  CREATE INDEX audit_log_actor_id ON audit_log(actor_id);
  `,
];
