import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS } from './schema';
import { seed } from './seed';

export type DB = Database.Database;

export function openDatabase(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  seed(db);
  return db;
}

function migrate(db: DB): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > MIGRATIONS.length) {
    throw new Error(`Database is at version ${version}, newer than this code supports (${MIGRATIONS.length})`);
  }
  for (let next = version; next < MIGRATIONS.length; next++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[next]);
      db.pragma(`user_version = ${next + 1}`);
    })();
  }
}
