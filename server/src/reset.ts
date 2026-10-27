// Deletes the local SQLite database and recreates it with only the baked-in policies and roles.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dbPath = process.env.DB_PATH ?? path.join(root, 'data', 'governance.db');

for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
openDatabase(dbPath).close();
console.log(`Reset ${dbPath}`);
