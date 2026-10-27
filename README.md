# Data Governance Tool

Account, role and policy management for protecting proprietary scientific data (Claude Impact Lab, Track 3).

**Account managers** sign in, define accounts (academic labs or industry organizations), build **roles** from a catalog
of built-in and custom **policies**, and give each member of an account one role. Every change is written to an
**audit log** under the name of the manager who made it.

Stack: React 18 + Vite (client), Express + better-sqlite3 (API), SQLite for storage. Runs on Node 18.18+.

## Quick start

```bash
npm install
npm run dev        # http://localhost:3000 (API and React app on one port, with hot reload)
```

The database is created at `data/governance.db` on first start. Override with `DB_PATH=/path/to/file.db`, and the port
with `PORT=4000`.

On first visit the app asks you to create the first account manager. After signing in, add other managers under
**Account managers**.

For a quick demo, run `npm run db:demo` before starting the server. It creates two account managers (sign-in details in
[server/src/seed-demo.ts](server/src/seed-demo.ts)), an academic and an industry account, custom roles, a custom policy,
and members in every role. It refuses to run if the database already has data.

| Command            | What it does                                                      |
| ------------------ | ----------------------------------------------------------------- |
| `npm run dev`      | Dev server: Express API with Vite middleware                      |
| `npm test`         | API tests (Node test runner, in-memory SQLite)                    |
| `npm run build`    | Typecheck and build the client into `dist/`                       |
| `npm start`        | Serve the API and the built client in production mode             |
| `npm run db:reset` | Delete the database (including managers) and start from first-run setup |
| `npm run db:demo`  | Load demo managers, accounts, roles and members into an empty database |

## Concepts

- **Account**: an organization, either `academic` (universities, institutes, labs) or `industry` (companies, biotechs,
  CROs). The type is fixed at creation.
- **Account manager**: a person who signs in to this console. Managers are not members of any account. They can add
  other managers, deactivate them (which signs them out), and reset their passwords.
- **Policy**: a single permission, e.g. "Use cloud AI on scrubbed internal data". Each policy has a category, the data
  tier it governs (`public` / `internal` / `restricted`) and a risk level.
  - **Built-in** policies are defined in [server/src/seed.ts](server/src/seed.ts), synced on every start, and read-only.
  - **Custom** policies are created by managers. Their codes always start with `custom.` and never change after
    creation. A custom policy can't be deleted while a role still grants it.
- **Role**: a named set of policies for one account type. Two built-in roles are seeded:
  - **Principal Investigator** (academic): includes publication approval and sharing with external collaborators.
  - **Director** (industry): includes raw-data export and approving policy exceptions.

  Built-in roles can have their policies changed but cannot be renamed or deleted. Custom roles can be deleted once no
  member holds them.
- **Member (user)**: belongs to one account and holds one role of the matching type. Their effective policies are
  their role's policies.

## API

All endpoints are under `/api` and return JSON. Errors look like `{ "error": "message", "field": "email" }`.

Everything except `/health` and `/auth/*` requires a signed-in manager (session cookie, 12-hour lifetime).

| Method                   | Path                          | Notes                                              |
| ------------------------ | ----------------------------- | -------------------------------------------------- |
| GET                      | `/auth/session`               | `{ manager, needsSetup }`                          |
| POST                     | `/auth/setup`                 | First run only: `{ name, email, password }`        |
| POST                     | `/auth/login` / `/auth/logout`| `{ email, password }`                              |
| POST                     | `/auth/password`              | `{ currentPassword, newPassword }`; signs out other sessions |
| GET / POST               | `/managers`                   | POST `{ name, email, password }`                   |
| PATCH                    | `/managers/:id`               | `{ name?, status?, password? }` (password = reset) |
| GET / POST               | `/accounts`                   | POST `{ name, type, description? }`                |
| GET / PATCH / DELETE     | `/accounts/:id`               | PATCH `{ name?, description? }`; DELETE removes members |
| GET / POST               | `/policies`                   | POST `{ name, description, category, risk, dataTier?, code? }` |
| PATCH / DELETE           | `/policies/:id`               | Custom policies only                               |
| GET / POST               | `/roles?accountType=`         | POST `{ name, accountType, description?, policyIds }` |
| GET / PATCH / DELETE     | `/roles/:id`                  | PATCH `{ name?, description?, policyIds? }`        |
| GET / POST               | `/users?accountId=`           | POST `{ accountId, roleId, name, email }`          |
| GET / PATCH / DELETE     | `/users/:id`                  | GET includes effective `policies`; PATCH `{ roleId?, name?, email?, status? }` |
| GET                      | `/audit?entityType=&actorId=&limit=` | Newest first, with `actor` / `actorEmail`   |
| GET                      | `/health`                     | Includes whether `ANTHROPIC_API_KEY` is set        |

## Project layout

```
client/            React app (Vite root)
  src/pages/       Accounts, account detail, roles, role editor, policy catalog, audit log
server/src/        Express app, SQLite schema + migrations, seed data, auth, routes
server/test/       API tests
shared/            Types and helpers shared by client and server
```

## Security notes

- Passwords are hashed with scrypt. Only a SHA-256 hash of each session token is stored.
- Session cookies are `HttpOnly` and `SameSite=Lax`. They are marked `Secure` when the request arrives over HTTPS.
- Sign-in errors don't reveal whether an email exists.
- Whoever opens the app first creates the first account manager, so complete setup before exposing the server.

## Not yet built

- Rate limiting for failed sign-ins.
- Sign-in for account members (PIs, Directors) to manage their own accounts.
- The gateway features from the Track 3 brief (scanner, scrubbing, route-by-risk). Claude calls will be optional and
  enabled when `ANTHROPIC_API_KEY` is set.
