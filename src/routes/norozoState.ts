import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { createLogger } from '@team-deepiri/shared-utils';
import * as dbService from '../services/dbService';

const router = Router();
const logger = createLogger('norozo-state');

// Same shared secret Norozo's state_store.py / pr_staleness_store.py / member_email_store.py
// already sign against (PLATFORM_ANNOUNCEMENTS_WEBHOOK_SECRET, with the older env names as
// fallbacks for whichever one is actually set in Norozo's Render environment).
const NOROZO_WEBHOOK_SECRET =
  process.env.PLATFORM_ANNOUNCEMENTS_WEBHOOK_SECRET ||
  process.env.PLATFORM_WEBHOOK_SECRET ||
  process.env.ANNOUNCEMENTS_WEBHOOK_SECRET ||
  process.env.NOROZO_WEBHOOK_SECRET ||
  '';

function verifySignature(signingBytes: Buffer | string, signatureHeader: string): boolean {
  if (!NOROZO_WEBHOOK_SECRET || !signatureHeader) return false;
  const buf = Buffer.isBuffer(signingBytes) ? signingBytes : Buffer.from(signingBytes, 'utf-8');
  const expected = `sha256=${crypto.createHmac('sha256', NOROZO_WEBHOOK_SECRET).update(buf).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sigHeader(req: Request): string {
  return String(req.headers['x-norozo-signature'] || req.headers['x-platform-signature'] || '').trim();
}

// Lazy schema setup, same pattern as announcements.ts -- no migration framework in this
// service, so tables are created on first use and are safe to CREATE TABLE IF NOT EXISTS
// on every cold start.
let schemaReadyPromise: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await dbService.query(`
        CREATE TABLE IF NOT EXISTS bot_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await dbService.query(`
        CREATE TABLE IF NOT EXISTS pr_staleness_state (
          repo TEXT NOT NULL,
          pr_number INTEGER NOT NULL,
          notified_2week BOOLEAN NOT NULL DEFAULT false,
          notified_1month BOOLEAN NOT NULL DEFAULT false,
          resolved_discord_id TEXT,
          last_author_dm_at TIMESTAMPTZ,
          reviewer_dm_state JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (repo, pr_number)
        )
      `);
      await dbService.query(`
        CREATE TABLE IF NOT EXISTS member_emails (
          discord_id TEXT PRIMARY KEY,
          discord_username TEXT,
          email TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await dbService.query(`
        CREATE INDEX IF NOT EXISTS idx_member_emails_email_lower ON member_emails (lower(email))
      `);
      logger.info('Norozo state tables ready');
    })().catch((e: any) => {
      schemaReadyPromise = null;
      throw e;
    });
  }
  return schemaReadyPromise;
}

// ---------------------------------------------------------------------------
// Generic key/value state -- backs load_state/save_state and the older
// norozo_last_online_at checkpoint in state_store.py. Norozo signs a fixed
// string for the GET side (not including the query key), so verification
// here must match that exact constant rather than trying to bind the
// signature to the requested key.
// ---------------------------------------------------------------------------

router.get('/webhooks/norozo/state', async (req: Request, res: Response) => {
  if (!verifySignature('GET /api/webhooks/norozo/state', sigHeader(req))) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  const key = String(req.query.key || '').trim();
  if (!key) return res.status(400).json({ error: 'Missing key' });

  try {
    await ensureSchema();
    const { result } = await dbService.query<{ value: string }>('SELECT value FROM bot_state WHERE key = $1', [key]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ value: result.rows[0].value });
  } catch (e: any) {
    logger.error('Failed to load bot_state', { key, error: e.message });
    res.status(500).json({ error: 'Failed to load state' });
  }
});

router.post('/webhooks/norozo/state', async (req: Request, res: Response) => {
  const rawBody: Buffer | undefined = (req as any).rawBody;
  if (!rawBody || !verifySignature(rawBody, sigHeader(req))) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  const { key, value } = req.body || {};
  if (!key || typeof value !== 'string') return res.status(400).json({ error: 'Missing key or value' });

  try {
    await ensureSchema();
    await dbService.query(
      `INSERT INTO bot_state (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value]
    );
    res.json({ success: true });
  } catch (e: any) {
    logger.error('Failed to save bot_state', { key, error: e.message });
    res.status(500).json({ error: 'Failed to save state' });
  }
});

// ---------------------------------------------------------------------------
// Per-PR staleness escalation tiers -- backs pr_staleness_store.py.
// ---------------------------------------------------------------------------

router.get('/webhooks/norozo/pr-staleness', async (req: Request, res: Response) => {
  const repo = String(req.query.repo || '');
  const prNumber = String(req.query.pr_number || '');
  const signingString = `GET /api/webhooks/norozo/pr-staleness?repo=${repo}&pr_number=${prNumber}`;
  if (!verifySignature(signingString, sigHeader(req))) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  if (!repo || !prNumber) return res.status(400).json({ error: 'Missing repo or pr_number' });

  try {
    await ensureSchema();
    const { result } = await dbService.query(
      `SELECT notified_2week, notified_1month, resolved_discord_id, last_author_dm_at, reviewer_dm_state
       FROM pr_staleness_state WHERE repo = $1 AND pr_number = $2`,
      [repo, parseInt(prNumber, 10)]
    );
    if (result.rows.length === 0) {
      return res.json({
        notified2Week: false,
        notified1Month: false,
        resolvedDiscordId: null,
        lastAuthorDmAt: null,
        reviewerDmState: {},
      });
    }
    const row = result.rows[0] as any;
    res.json({
      notified2Week: row.notified_2week,
      notified1Month: row.notified_1month,
      resolvedDiscordId: row.resolved_discord_id,
      lastAuthorDmAt: row.last_author_dm_at ? new Date(row.last_author_dm_at).toISOString() : null,
      reviewerDmState: row.reviewer_dm_state || {},
    });
  } catch (e: any) {
    logger.error('Failed to load pr_staleness_state', { repo, prNumber, error: e.message });
    res.status(500).json({ error: 'Failed to load PR staleness state' });
  }
});

router.post('/webhooks/norozo/pr-staleness', async (req: Request, res: Response) => {
  const rawBody: Buffer | undefined = (req as any).rawBody;
  if (!rawBody || !verifySignature(rawBody, sigHeader(req))) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  const { repo, pr_number, notified_2week, notified_1month, resolved_discord_id, last_author_dm_at, reviewer_dm_state } =
    req.body || {};
  if (!repo || pr_number === undefined || pr_number === null) {
    return res.status(400).json({ error: 'Missing repo or pr_number' });
  }

  try {
    await ensureSchema();
    await dbService.query(
      `INSERT INTO pr_staleness_state (repo, pr_number, notified_2week, notified_1month, resolved_discord_id, last_author_dm_at, reviewer_dm_state, updated_at)
       VALUES ($1, $2, COALESCE($3, false), COALESCE($4, false), $5, $6, COALESCE($7, '{}'::jsonb), now())
       ON CONFLICT (repo, pr_number) DO UPDATE SET
         notified_2week = COALESCE($3, pr_staleness_state.notified_2week),
         notified_1month = COALESCE($4, pr_staleness_state.notified_1month),
         resolved_discord_id = COALESCE($5, pr_staleness_state.resolved_discord_id),
         last_author_dm_at = COALESCE($6, pr_staleness_state.last_author_dm_at),
         reviewer_dm_state = COALESCE($7, pr_staleness_state.reviewer_dm_state),
         updated_at = now()`,
      [
        repo,
        pr_number,
        notified_2week ?? null,
        notified_1month ?? null,
        resolved_discord_id ?? null,
        last_author_dm_at ?? null,
        reviewer_dm_state ? JSON.stringify(reviewer_dm_state) : null,
      ]
    );
    res.json({ success: true });
  } catch (e: any) {
    logger.error('Failed to save pr_staleness_state', { repo, pr_number, error: e.message });
    res.status(500).json({ error: 'Failed to save PR staleness state' });
  }
});

router.post('/webhooks/norozo/pr-staleness/claim-1month', async (req: Request, res: Response) => {
  const rawBody: Buffer | undefined = (req as any).rawBody;
  if (!rawBody || !verifySignature(rawBody, sigHeader(req))) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  const { repo, pr_number } = req.body || {};
  if (!repo || pr_number === undefined || pr_number === null) {
    return res.status(400).json({ error: 'Missing repo or pr_number' });
  }

  try {
    await ensureSchema();
    // Ensure the row exists first so the conditional UPDATE below has something to claim.
    await dbService.query(
      `INSERT INTO pr_staleness_state (repo, pr_number) VALUES ($1, $2) ON CONFLICT (repo, pr_number) DO NOTHING`,
      [repo, pr_number]
    );
    // Atomic claim: only the caller that flips notified_1month false -> true gets claimed=true,
    // so two overlapping scan loops can never both post the same PR's announcement.
    const { result } = await dbService.query(
      `UPDATE pr_staleness_state SET notified_1month = true, updated_at = now()
       WHERE repo = $1 AND pr_number = $2 AND notified_1month = false
       RETURNING 1`,
      [repo, pr_number]
    );
    res.json({ claimed: (result.rowCount ?? 0) > 0 });
  } catch (e: any) {
    logger.error('Failed to claim pr_staleness 1-month slot', { repo, pr_number, error: e.message });
    res.status(500).json({ claimed: false });
  }
});

// ---------------------------------------------------------------------------
// Member emails -- backs member_email_store.py (self-reported at onboarding)
// and the reverse by-email lookup pr_staleness_store.py uses to resolve a
// Plaky email back to a Discord id.
// ---------------------------------------------------------------------------

router.get('/webhooks/norozo/member-email', async (req: Request, res: Response) => {
  const discordId = String(req.query.discord_id || '');
  const signingString = `GET /api/webhooks/norozo/member-email?discord_id=${discordId}`;
  if (!verifySignature(signingString, sigHeader(req))) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  if (!discordId) return res.status(400).json({ error: 'Missing discord_id' });

  try {
    await ensureSchema();
    const { result } = await dbService.query<{ email: string }>(
      'SELECT email FROM member_emails WHERE discord_id = $1',
      [discordId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ email: result.rows[0].email });
  } catch (e: any) {
    logger.error('Failed to load member email', { discordId, error: e.message });
    res.status(500).json({ error: 'Failed to load member email' });
  }
});

router.get('/webhooks/norozo/member-email/by-email', async (req: Request, res: Response) => {
  const email = String(req.query.email || '');
  const signingString = `GET /api/webhooks/norozo/member-email/by-email?email=${email}`;
  if (!verifySignature(signingString, sigHeader(req))) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  if (!email) return res.status(400).json({ error: 'Missing email' });

  try {
    await ensureSchema();
    const { result } = await dbService.query<{ discord_id: string }>(
      'SELECT discord_id FROM member_emails WHERE lower(email) = lower($1) LIMIT 1',
      [email]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ discordId: result.rows[0].discord_id });
  } catch (e: any) {
    logger.error('Failed to reverse-lookup member email', { error: e.message });
    res.status(500).json({ error: 'Failed to look up member email' });
  }
});

router.post('/webhooks/norozo/member-email', async (req: Request, res: Response) => {
  const rawBody: Buffer | undefined = (req as any).rawBody;
  if (!rawBody || !verifySignature(rawBody, sigHeader(req))) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  const { discord_id, discord_username, email } = req.body || {};
  if (!discord_id || !email) return res.status(400).json({ error: 'Missing discord_id or email' });

  try {
    await ensureSchema();
    await dbService.query(
      `INSERT INTO member_emails (discord_id, discord_username, email, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (discord_id) DO UPDATE SET discord_username = EXCLUDED.discord_username, email = EXCLUDED.email, updated_at = now()`,
      [String(discord_id), discord_username ?? null, email]
    );
    res.json({ success: true });
  } catch (e: any) {
    logger.error('Failed to save member email', { discord_id, error: e.message });
    res.status(500).json({ error: 'Failed to save member email' });
  }
});

export default router;
