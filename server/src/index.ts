import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp } from './app';
import { openDatabase } from './db';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DB_PATH ?? path.join(root, 'data', 'governance.db');
const isProduction = process.env.NODE_ENV === 'production';

const db = openDatabase(dbPath);
const app = createApp(db);
const server = http.createServer(app);

if (isProduction) {
  const dist = path.join(root, 'dist');
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  // In development, Vite serves the React client from the same port as the API.
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: path.join(root, 'vite.config.ts'),
    server: { middlewareMode: true, hmr: { server } },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

server.listen(port, () => {
  console.log(`Data governance tool running at http://localhost:${port}`);
  console.log(`SQLite database: ${dbPath}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
