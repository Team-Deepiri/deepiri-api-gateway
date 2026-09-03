/**
 * Applies every migration in src/migrations/index.ts that hasn't already run,
 * tracked by name in schema_migrations. Called once at startup (server.ts),
 * before the server starts accepting traffic that depends on these tables --
 * replaces the old per-route "ensureXSchema()" lazy pattern, where a table's
 * actual shape depended on which endpoint happened to get hit first after a
 * deploy.
 */
import { createLogger } from '@team-deepiri/shared-utils';
import * as dbService from './services/dbService';
import { migrations } from './migrations';

const logger = createLogger('migrationRunner');

async function ensureMigrationsTable(): Promise<void> {
  await dbService.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function runMigrations(): Promise<void> {
  await ensureMigrationsTable();
  const { result } = await dbService.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(result.rows.map((r) => r.name));

  const pending = migrations.filter((m) => !applied.has(m.name));
  if (pending.length === 0) {
    logger.info('No pending migrations');
    return;
  }

  for (const migration of pending) {
    logger.info(`Applying migration: ${migration.name}`);
    await dbService.query(migration.sql);
    await dbService.query('INSERT INTO schema_migrations (name) VALUES ($1)', [migration.name]);
    logger.info(`Applied migration: ${migration.name}`);
  }
}
