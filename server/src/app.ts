import express from 'express';
import { requireManager } from './auth';
import type { DB } from './db';
import { errorHandler } from './http';
import { accountsRouter } from './routes/accounts';
import { auditRouter } from './routes/audit';
import { authRouter } from './routes/auth';
import { datasetsRouter } from './routes/datasets';
import { managersRouter } from './routes/managers';
import { policiesRouter } from './routes/policies';
import { rolesRouter } from './routes/roles';
import { usersRouter } from './routes/users';

export function createApp(db: DB): express.Express {
  const app = express();
  // CSV uploads arrive as JSON and need a larger limit; body-parser skips bodies that are already parsed.
  app.use('/api/datasets', express.json({ limit: '12mb' }));
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, claudeConfigured: Boolean(process.env.ANTHROPIC_API_KEY) });
  });
  app.use('/api/auth', authRouter(db));

  // Account members (data stewards, research scientists). Each route checks the member's policies.
  app.use('/api/datasets', datasetsRouter(db));

  // Account managers only.
  const manager = requireManager(db);
  app.use('/api/accounts', manager, accountsRouter(db));
  app.use('/api/roles', manager, rolesRouter(db));
  app.use('/api/policies', manager, policiesRouter(db));
  app.use('/api/users', manager, usersRouter(db));
  app.use('/api/managers', manager, managersRouter(db));
  app.use('/api/audit', manager, auditRouter(db));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use('/api', errorHandler);

  return app;
}
