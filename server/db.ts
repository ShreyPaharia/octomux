import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { childLogger } from './logger.js';
import { octomuxRoot } from './octomux-root.js';
import { SCHEMA, applyPragmas } from './db/schema.js';
import { runMigrations } from './db/migrations.js';

export { SCHEMA } from './db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = childLogger('db');
const isProduction = process.env.NODE_ENV === 'production';

const PROD_DB_DIR = path.join(octomuxRoot(), 'data');
const DEV_DB_DIR = path.join(__dirname, '..', 'data');
const DB_DIR = isProduction ? PROD_DB_DIR : DEV_DB_DIR;
/** Override for docs screenshots / isolated demo data (`scripts/seed-docs-demo.ts`). */
const DB_PATH = process.env.OCTOMUX_DB_PATH ?? path.join(DB_DIR, 'tasks.db');

/** Path to the old package-relative database (for migration detection). */
const OLD_DB_PATH = path.join(__dirname, '..', 'data', 'tasks.db');

/**
 * Absolute path to the octomux data directory (the directory holding the SQLite
 * file). Resolved from the same logic as the DB path so prod (`~/.octomux/data`),
 * dev (`./data`), and `OCTOMUX_DB_PATH` overrides all agree. Single source of
 * truth for consumers that need to report or locate the data dir.
 */
export function getDataDir(): string {
  return path.dirname(DB_PATH);
}

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    fs.mkdirSync(DB_DIR, { recursive: true });

    // In production, check for database at old package-relative location
    if (isProduction && OLD_DB_PATH !== DB_PATH && fs.existsSync(OLD_DB_PATH)) {
      logger.info(
        { old_path: OLD_DB_PATH, new_path: DB_PATH },
        'Found database at old location — copy to new location to migrate',
      );
    }

    db = new Database(DB_PATH);
    // Restrict DB file to owner-only access to protect stored credentials.
    try {
      fs.chmodSync(DB_PATH, 0o600);
    } catch {
      // Best-effort — may fail on non-POSIX systems or virtual filesystems.
    }
    initDb(db);
  }
  return db;
}

/** Replace the singleton db instance (for testing). */
export function setDb(instance: Database.Database): void {
  db = instance;
}

/** Lightweight DB reachability probe used by the health endpoint. */
export function pingDb(): void {
  getDb().prepare('SELECT 1 AS ok').get();
}

/** Initialize a database with schema and pragmas. */
export function initDb(instance: Database.Database): void {
  applyPragmas(instance);
  instance.exec(SCHEMA);
  runMigrations(instance);
}
