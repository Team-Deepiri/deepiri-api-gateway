/**
 * Tracked SQL migrations, applied once at server startup (see migrationRunner.ts)
 * instead of lazily on first request to each route -- the old pattern meant a
 * table's schema quietly depended on which endpoint happened to get hit first
 * in a given deploy, and a column added in code could sit unapplied against a
 * live table until something exercised that specific route's ensureXSchema().
 *
 * Each entry here is idempotent (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT
 * EXISTS) so it's safe to run against a fresh database or one that already has
 * these tables in some earlier shape. Never edit an already-applied migration's
 * SQL after it's shipped -- schema_migrations tracks it by name, so a changed
 * migration with the same name silently never re-runs; add a new migration
 * instead, the same as any other migration system.
 */

export interface Migration {
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    name: '001_create_announcements',
    sql: `
      CREATE TABLE IF NOT EXISTS announcements (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        author_name TEXT,
        author_id TEXT,
        source TEXT NOT NULL,
        discord_channel_id TEXT,
        color TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_announcements_created_at ON announcements (created_at DESC);
    `,
  },
  {
    name: '002_create_bot_state',
    sql: `
      CREATE TABLE IF NOT EXISTS bot_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    name: '003_create_member_emails',
    sql: `
      CREATE TABLE IF NOT EXISTS member_emails (
        discord_id TEXT PRIMARY KEY,
        discord_username TEXT,
        email TEXT,
        real_name TEXT,
        github_username TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- email used to be NOT NULL -- a row can now exist with just a
      -- self-reported GitHub link (real_name/github_username) before any
      -- email is known, since this is a dynamic identity cache, not just an
      -- email store.
      ALTER TABLE member_emails ALTER COLUMN email DROP NOT NULL;
      ALTER TABLE member_emails ADD COLUMN IF NOT EXISTS real_name TEXT;
      ALTER TABLE member_emails ADD COLUMN IF NOT EXISTS github_username TEXT;
    `,
  },
  {
    name: '004_create_pr_staleness_state',
    sql: `
      CREATE TABLE IF NOT EXISTS pr_staleness_state (
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        notified_2week BOOLEAN NOT NULL DEFAULT false,
        notified_1month BOOLEAN NOT NULL DEFAULT false,
        resolved_discord_id TEXT,
        last_author_dm_at TIMESTAMPTZ,
        reviewer_dm_state JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (repo, pr_number)
      );
      ALTER TABLE pr_staleness_state ADD COLUMN IF NOT EXISTS last_author_dm_at TIMESTAMPTZ;
      ALTER TABLE pr_staleness_state ADD COLUMN IF NOT EXISTS reviewer_dm_state JSONB NOT NULL DEFAULT '{}'::jsonb;
      -- notified_2_5week was dropped from the v1 -> v2 PR-staleness design
      -- (replaced by the recurring last_author_dm_at cadence) but the lazy
      -- CREATE TABLE IF NOT EXISTS pattern never dropped it from tables that
      -- already existed -- exactly the kind of drift tracked migrations exist
      -- to catch.
      ALTER TABLE pr_staleness_state DROP COLUMN IF EXISTS notified_2_5week;
    `,
  },
];
