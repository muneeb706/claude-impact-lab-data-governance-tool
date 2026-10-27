import express from 'express';
import { requireManager } from './auth';
import type { DB } from './db';
import { errorHandler } from './http';
import { accountsRouter } from './routes/accounts';
import { auditRouter } from './routes/audit';
import { authRouter } from './routes/auth';
import { managersRouter } from './routes/managers';
import { policiesRouter } from './routes/policies';
import { rolesRouter } from './routes/roles';
import { usersRouter } from './routes/users';

export function createApp(db: DB): express.Express {
  const app = express();
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, claudeConfigured: Boolean(process.env.ANTHROPIC_API_KEY) });
  });
  app.use('/api/auth', authRouter(db));

  // Everything below requires a signed-in account manager.
  app.use('/api', requireManager(db));
  app.use('/api/accounts', accountsRouter(db));
  app.use('/api/roles', rolesRouter(db));
  app.use('/api/policies', policiesRouter(db));
  app.use('/api/users', usersRouter(db));
  app.use('/api/managers', managersRouter(db));
  app.use('/api/audit', auditRouter(db));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use('/api', errorHandler);

  return app;
}
