# Data Governance Tool

Account, role, policy and dataset governance for protecting proprietary scientific data (Claude Impact Lab, Track 3).

- **Account managers** define accounts (academic labs or industry organizations), build **roles** from a catalog of
  built-in and custom **policies**, and give each member of an account one role.
- **Data stewards** upload CSV datasets, set policies on each file and each column (who can see it, and what Claude
  Code may read), and share datasets with research scientists.
- **Research scientists** download shared datasets as a folder that carries its policy with it: the data, a
  Claude Code-safe copy, and Claude Code settings that stop Claude Code from reading what it shouldn't.
- Every change and every download is written to an **audit log** under the name of the person who did it.

Stack: React 18 + Vite (client), Express + better-sqlite3 (API), SQLite for storage. Runs on Node 18.18+.

## Quick start

```bash
npm install
npm run dev        # http://localhost:3000 (API and React app on one port, with hot reload)
```

The database is created at `data/governance.db` on first start. Override with `DB_PATH=/path/to/file.db`, and the port
with `PORT=4000`.

On first visit the app asks you to create the first account manager. After signing in, add other managers under
**Account managers**. Account members sign in on the same page once a manager sets a password for them.

For a quick demo, run `npm run db:demo`. It adds two account managers, an academic and an industry account, custom
roles, a custom policy, members in every role (including a data steward and a research scientist per account), and a
CSV dataset per account with column policies, shared with that account's research scientist. Everyone signs in with the
demo password in [server/src/seed-demo.ts](server/src/seed-demo.ts). It only adds what is missing, so it is safe to run
again.

| Command            | What it does                                                      |
| ------------------ | ----------------------------------------------------------------- |
| `npm run dev`      | Dev server: Express API with Vite middleware                      |
| `npm test`         | API tests (Node test runner, in-memory SQLite)                    |
| `npm run build`    | Typecheck and build the client into `dist/`                       |
| `npm start`        | Serve the API and the built client in production mode             |
| `npm run db:reset` | Delete the database (including managers) and start from first-run setup |
| `npm run db:demo`  | Add any missing demo managers, accounts, roles, members and datasets |

## Concepts

- **Account**: an organization, either `academic` (universities, institutes, labs) or `industry` (companies, biotechs,
  CROs). The type is fixed at creation.
- **Account manager**: a person who signs in to manage accounts, roles, policies and members. Managers are not members
  of any account. They can add other managers, deactivate them (which signs them out), and reset their passwords.
- **Policy**: a single permission, e.g. "Use cloud AI on scrubbed internal data". Each policy has a category, the data
  tier it governs (`public` / `internal` / `restricted`) and a risk level.
  - **Built-in** policies are defined in [server/src/seed.ts](server/src/seed.ts), synced on every start, and read-only.
  - **Custom** policies are created by managers. Their codes always start with `custom.` and never change after
    creation. A custom policy can't be deleted while a role still grants it.
- **Role**: a named set of policies for one account type. Built-in roles:
  - **Principal Investigator** (academic): includes publication approval and sharing with external collaborators.
  - **Director** (industry): includes raw-data export and approving policy exceptions.
  - **Data Steward** (academic and industry): `data.steward`, plus read access to every tier.
  - **Research Scientist** (academic and industry): `data.download`, read access to every tier, and cloud AI for
    public and internal data, but not restricted data.

  Built-in roles can have their policies changed but cannot be renamed or deleted. Custom roles can be deleted once no
  member holds them.
- **Member (user)**: belongs to one account and holds one role of the matching type. Their policies are their role's
  policies. A member can sign in once a manager sets a password for them; suspending a member signs them out.

## Datasets and Claude Code

A **dataset** is a CSV file owned by an account and managed by members whose role includes `data.steward`.

**File policy**: a classification (`public` / `internal` / `restricted`) and whether Claude Code may use the file at all.

**Column policy**: for each column,

- a **classification**, which decides whether a member gets the column in their own copy (their role needs
  `data.<tier>.read`), and
- a **Claude Code access** setting: **Allowed** (real values), **Masked** (consistent pseudonyms such as
  `MASK_4fdf8356ee`, so Claude can still group and join), or **Blocked** (column removed).

Stewards share a dataset with members whose role includes `data.download` and can read the file's classification.

**What a member gets when they download**, column by column:

| Their own copy | Claude Code's copy |
| --- | --- |
| Columns their role can read, with real values | Of those, the columns the steward allowed or masked, and only if their role includes the cloud AI policy for the column's classification (`ai.cloud.public`, `ai.cloud.internal_scrubbed` or `ai.cloud.restricted`) |

The scientist's dataset page shows this for every column, with the reason.

**The download** is a zip with one folder:

```
kinase-inhibitor-screen-batch-7/
  restricted-data/<file>.restricted.csv   the member's own copy; Claude Code is blocked from it
  claude-data/<file>.claude.csv           Claude Code's copy (absent if the file is blocked for Claude Code)
  data-policy.json                        machine-readable policy: issued to, column rules, file checksums
  CLAUDE.md                               instructions Claude Code reads at session start
  README.md                               the same policy for people, and how to use the folder
  .claude/settings.json                   Claude Code settings that enforce the policy
  .claude/hooks/enforce-data-policy.sh    hook run before every Claude Code tool call
```

When Claude Code is started in that folder, `.claude/settings.json` enforces the policy in three layers:

1. **Permission deny rules** for `restricted-data/` and `*.restricted.csv` stop Claude Code's file tools and simple shell
   reads (`cat`, `head`, redirections).
2. **The Bash sandbox** (`denyRead` on `restricted-data/`, unsandboxed retries disabled) blocks every command Claude
   runs, and any program it starts, from reading the folder. It works on macOS, Linux and WSL2.
3. **A PreToolUse hook** rejects any tool call that mentions `restricted-data/` or a `.restricted.csv` file, including
   writing a script that would open one.

Bypass-permissions mode is also disabled in the folder.

**Limits**: the protections apply only when Claude Code is started in the downloaded folder, and only to files that
stay in it. Native Windows has no Bash sandbox, so there the deny rules and the hook are the only layers. The
protections guard Claude Code, not the researcher, who can open every file and could edit the settings. Column names
of blocked columns appear in `CLAUDE.md` and `data-policy.json`; their values never do.

## API

All endpoints are under `/api` and return JSON. Errors look like `{ "error": "message", "field": "email" }`.
Sessions use a cookie with a 12-hour lifetime.

Open to everyone:

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | Includes whether `ANTHROPIC_API_KEY` is set |
| GET | `/auth/session` | `{ manager, member, needsSetup }` |
| POST | `/auth/setup` | First run only: `{ name, email, password }` |
| POST | `/auth/login` / `/auth/logout` | `{ email, password }`, for managers and members |
| POST | `/auth/password` | Signed in: `{ currentPassword, newPassword }`; signs out other sessions |

Account managers only:

| Method | Path | Notes |
| --- | --- | --- |
| GET / POST | `/managers` | POST `{ name, email, password }` |
| PATCH | `/managers/:id` | `{ name?, status?, password? }` (password = reset) |
| GET / POST | `/accounts` | POST `{ name, type, description? }` |
| GET / PATCH / DELETE | `/accounts/:id` | PATCH `{ name?, description? }`; DELETE removes members |
| GET / POST | `/policies` | POST `{ name, description, category, risk, dataTier?, code? }` |
| PATCH / DELETE | `/policies/:id` | Custom policies only |
| GET / POST | `/roles?accountType=` | POST `{ name, accountType, description?, policyIds }` |
| GET / PATCH / DELETE | `/roles/:id` | PATCH `{ name?, description?, policyIds? }` |
| GET / POST | `/users?accountId=` | POST `{ accountId, roleId, name, email, password? }` |
| GET / PATCH / DELETE | `/users/:id` | GET includes effective `policies`; PATCH `{ roleId?, name?, email?, status?, password? }` |
| GET | `/audit?entityType=&actorId=&limit=` | Newest first, with `actorKind`, `actor` and `actorEmail` |

Account members (checked against the member's role policies):

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| GET | `/datasets` | Any member | Stewards: the account's datasets. Others: datasets shared with them |
| POST | `/datasets` | Steward | `{ name, description?, fileName, csv, dataTier? }`, up to 10 MB |
| GET | `/datasets/:id` | Steward or shared member | Includes `effective` column access and `download` for the caller |
| PATCH | `/datasets/:id` | Steward | `{ name?, description?, dataTier?, claudeAccess?, columns?: [{ position, classification?, claudeAccess?, description? }] }` |
| DELETE | `/datasets/:id` | Steward | |
| GET | `/datasets/:id/preview?view=full\|claude` | Steward | First rows of the full data or of Claude Code's view |
| GET | `/datasets/:id/grantees` | Steward | Members the dataset can be shared with |
| POST / DELETE | `/datasets/:id/grants[/:userId]` | Steward | POST `{ userId }` |
| GET | `/datasets/:id/download` | Steward or shared member | The zip described above; recorded in the audit log |

## Project layout

```
client/              React app (Vite root)
  src/pages/         Manager pages: accounts, roles, policy catalog, audit log, account managers
  src/pages/member/  Member pages: datasets list, dataset policy editor and download
server/src/          Express app, SQLite schema + migrations, seed data, auth, CSV, dataset bundles, routes
server/test/         API, dataset and CSV tests
shared/              Types and helpers shared by client and server
```

## Security notes

- Passwords are hashed with scrypt. Only a SHA-256 hash of each session token is stored.
- Session cookies are `HttpOnly` and `SameSite=Lax`. They are marked `Secure` when the request arrives over HTTPS.
- Sign-in errors don't reveal whether an email exists.
- Whoever opens the app first creates the first account manager, so complete setup before exposing the server.
- Dataset CSVs are stored in SQLite. Masking uses an HMAC with a random key per dataset that never leaves the server.

## Not yet built

- Rate limiting for failed sign-ins.
- The gateway features from the Track 3 brief (scanner, scrubbing, route-by-risk). Claude calls will be optional and
  enabled when `ANTHROPIC_API_KEY` is set.
