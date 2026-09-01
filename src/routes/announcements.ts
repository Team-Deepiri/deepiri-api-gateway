import { Router, Request, Response } from 'express';
import { userAuthMiddleware } from '../middleware/userAuth.middleware';
import { createLogger } from '@team-deepiri/shared-utils';
import crypto from 'crypto';
import axios from 'axios';
import * as dbService from '../services/dbService';

const router = Router();
const logger = createLogger('announcements');

// Shared secret with Norozo's PLATFORM_ANNOUNCEMENTS_WEBHOOK_SECRET / ANNOUNCEMENTS_INBOUND_SECRET.
const ANNOUNCEMENTS_WEBHOOK_SECRET =
  process.env.PLATFORM_ANNOUNCEMENTS_WEBHOOK_SECRET || process.env.NOROZO_WEBHOOK_SECRET || '';
// Norozo's inbound webhook, e.g. https://<norozo>.onrender.com/announcements/webhook
const NOROZO_ANNOUNCEMENTS_WEBHOOK_URL = process.env.NOROZO_ANNOUNCEMENTS_WEBHOOK_URL || '';

// How long a row is kept before the prune job deletes it.
const ANNOUNCEMENTS_RETENTION_DAYS = parseInt(process.env.ANNOUNCEMENTS_RETENTION_DAYS || '30', 10);
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // check daily; deletes anything older than the retention window

function signBody(rawBody: Buffer | string): string {
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf-8');
  return `sha256=${crypto.createHmac('sha256', ANNOUNCEMENTS_WEBHOOK_SECRET).update(buf).digest('hex')}`;
}

// Same shared secret + host as the announcements bridge — Norozo's /alerts/webhook
// posts security/system notifications into #it-notifications (STAFF_CHANNEL_ID on
// Norozo's side). Fire-and-forget: alerting must never block the request that
// triggered it, and a failed alert shouldn't surface as a 500 to the caller.
function norozoAlertsUrl(): string {
  if (!NOROZO_ANNOUNCEMENTS_WEBHOOK_URL) return '';
  try {
    const u = new URL(NOROZO_ANNOUNCEMENTS_WEBHOOK_URL);
    return `${u.protocol}//${u.host}/alerts/webhook`;
  } catch {
    return '';
  }
}

export function alertNorozo(opts: { title: string; message: string; severity?: 'critical' | 'error' | 'warning' | 'info'; service?: string }): void {
  const url = norozoAlertsUrl();
  if (!url || !ANNOUNCEMENTS_WEBHOOK_SECRET) return;
  const payload = {
    title: opts.title,
    message: opts.message,
    severity: opts.severity || 'warning',
    service: opts.service || 'deepiri-api-gateway',
  };
  const raw = Buffer.from(JSON.stringify(payload), 'utf-8');
  const signature = signBody(raw);
  void axios
    .post(url, raw, { headers: { 'Content-Type': 'application/json', 'X-Norozo-Signature': signature }, timeout: 8_000 })
    .catch((e: any) => logger.error('Failed to forward alert to Discord #it-notifications', { error: e.message }));
}

function verifySignature(rawBody: Buffer, signatureHeader: string): boolean {
  if (!ANNOUNCEMENTS_WEBHOOK_SECRET || !signatureHeader) return false;
  const expected = signBody(rawBody);
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function forwardAnnouncementToDiscord(ann: {
  title: string;
  body: string;
  authorName?: string;
  url?: string;
}): Promise<void> {
  if (!NOROZO_ANNOUNCEMENTS_WEBHOOK_URL || !ANNOUNCEMENTS_WEBHOOK_SECRET) {
    logger.warn('Skipping forward to Discord: NOROZO_ANNOUNCEMENTS_WEBHOOK_URL or shared secret not configured');
    return;
  }
  const payload = {
    title: ann.title,
    body: ann.body,
    author: ann.authorName || 'Platform',
    url: ann.url || '',
  };
  const raw = Buffer.from(JSON.stringify(payload), 'utf-8');
  const signature = signBody(raw);
  try {
    await axios.post(NOROZO_ANNOUNCEMENTS_WEBHOOK_URL, raw, {
      headers: { 'Content-Type': 'application/json', 'X-Norozo-Signature': signature },
      timeout: 10_000,
    });
    logger.info('Forwarded web announcement to Discord via Norozo');
  } catch (e: any) {
    logger.error('Failed to forward announcement to Discord', { error: e.message });
  }
}

interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  author_name: string | null;
  author_id: string | null;
  created_at: string;
  source: 'web' | 'norozo';
  discord_channel_id: string | null;
}

interface Announcement {
  id: string;
  title: string;
  body: string;
  authorName?: string;
  authorId?: string;
  createdAt: string;
  source: 'web' | 'norozo';
  discordChannelId?: string;
}

function toAnnouncement(row: AnnouncementRow): Announcement {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    authorName: row.author_name ?? undefined,
    authorId: row.author_id ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
    source: row.source,
    discordChannelId: row.discord_channel_id ?? undefined,
  };
}

// Postgres, not in-memory + a JSON file — the previous store lost every announcement's
// history on each container recreate (which happens on every deploy), and gave no way
// to bound how much history accumulated. api-gateway already has a pooled Postgres
// connection (dbService) for this exact purpose; no new infra needed. Table is created
// lazily on first use rather than via a migration tool, matching this service's existing
// pattern (no migration framework is wired up here).
let schemaReadyPromise: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await dbService.query(`
        CREATE TABLE IF NOT EXISTS announcements (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          author_name TEXT,
          author_id TEXT,
          source TEXT NOT NULL,
          discord_channel_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await dbService.query(`
        CREATE INDEX IF NOT EXISTS idx_announcements_created_at ON announcements (created_at DESC)
      `);
      const seedCheck = await dbService.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM announcements');
      if (seedCheck.result.rows[0]?.count === '0') {
        await dbService.query(
          `INSERT INTO announcements (id, title, body, author_name, source) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO NOTHING`,
          [
            'seed-1',
            'Welcome to the new Deepiri Platform',
            'This is the new internal hub. Check Team Meetings on your Dashboard (role-filtered), and explore Tools for Registry, Jobs, Documents, and more. Norozo will now auto-forward every post from Discord #announcements here.',
            'Deepiri Team',
            'web',
          ]
        );
      }
      logger.info('Announcements table ready');
    })().catch((e: any) => {
      // Let the next request retry schema setup instead of caching a permanent failure.
      schemaReadyPromise = null;
      throw e;
    });
  }
  return schemaReadyPromise;
}

async function pruneOldAnnouncements(): Promise<void> {
  try {
    await ensureSchema();
    const { result } = await dbService.query(
      `DELETE FROM announcements WHERE created_at < now() - ($1 || ' days')::interval`,
      [ANNOUNCEMENTS_RETENTION_DAYS]
    );
    if (result.rowCount) {
      logger.info('Pruned old announcements', { deleted: result.rowCount, retentionDays: ANNOUNCEMENTS_RETENTION_DAYS });
    }
  } catch (e: any) {
    logger.error('Failed to prune old announcements', { error: e.message });
  }
}

// Run once shortly after startup (DB pool needs a moment to connect) and then daily.
setTimeout(() => void pruneOldAnnouncements(), 30_000);
setInterval(() => void pruneOldAnnouncements(), PRUNE_INTERVAL_MS);

// GET /api/announcements — list
router.get('/announcements', async (req: Request, res: Response) => {
  try {
    await ensureSchema();
    const { result } = await dbService.query<AnnouncementRow>(
      'SELECT * FROM announcements ORDER BY created_at DESC LIMIT 200'
    );
    res.json({ announcements: result.rows.map(toAnnouncement) });
  } catch (e: any) {
    logger.error('Failed to list announcements', { error: e.message });
    res.status(500).json({ error: 'Failed to list announcements' });
  }
});

// POST /api/announcements — create from web (requires auth)
router.post('/announcements', userAuthMiddleware as any, async (req: Request, res: Response) => {
  const { title, body } = req.body || {};
  if (!title || !String(title).trim() || !body || !String(body).trim()) {
    return res.status(400).json({ error: 'Title and body are required' });
  }
  if (String(title).length > 200) return res.status(400).json({ error: 'Title too long (200 max)' });
  if (String(body).length > 4000) return res.status(400).json({ error: 'Body too long (4000 max)' });

  const user: any = (req as any).user;
  const ann: Announcement = {
    id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: String(title).trim(),
    body: String(body).trim(),
    authorName: user?.name || user?.email || 'Unknown',
    authorId: user?.userId || user?.id,
    createdAt: new Date().toISOString(),
    source: 'web',
  };

  try {
    await ensureSchema();
    await dbService.query(
      `INSERT INTO announcements (id, title, body, author_name, author_id, source) VALUES ($1, $2, $3, $4, $5, $6)`,
      [ann.id, ann.title, ann.body, ann.authorName ?? null, ann.authorId ?? null, ann.source]
    );
  } catch (e: any) {
    logger.error('Failed to store web announcement', { error: e.message });
    return res.status(500).json({ error: 'Failed to create announcement' });
  }

  logger.info('Announcement created via web', { id: ann.id, title: ann.title });
  res.status(201).json({ success: true, announcement: ann });

  // Bidirectional bridge: mirror web-created announcements to Discord #announcements.
  // Fire-and-forget — don't block the API response on Discord being reachable.
  void forwardAnnouncementToDiscord({ title: ann.title, body: ann.body, authorName: ann.authorName });
});

// POST /api/webhooks/norozo/announcements — Norozo Discord bot forwards #announcements
// Auth: HMAC-SHA256 over the raw request body, header X-Norozo-Signature: sha256=<hex>,
// keyed with the secret shared via PLATFORM_ANNOUNCEMENTS_WEBHOOK_SECRET — matches
// Norozo's own _forward_announcement_to_platform() and inbound platform_announcement_handler(),
// so both directions of the bridge use the same scheme.
router.post('/webhooks/norozo/announcements', async (req: Request, res: Response) => {
  const sigHeader = String(req.headers['x-norozo-signature'] || req.headers['x-platform-signature'] || '').trim();
  const rawBody: Buffer | undefined = (req as any).rawBody;
  if (!rawBody || !verifySignature(rawBody, sigHeader)) {
    logger.warn('Norozo webhook unauthorized', { hasSignature: !!sigHeader });
    alertNorozo({
      title: 'Rejected inbound Norozo webhook',
      message: `POST /api/webhooks/norozo/announcements rejected (${sigHeader ? 'invalid' : 'missing'} signature) from ${req.ip}`,
      severity: 'warning',
    });
    return res.status(401).json({ error: 'Missing or invalid signature' });
  }

  const { title, body, content, author, author_id: authorId, discord_channel_id: discordChannelId } = req.body || {};
  const finalTitle = String(title || content?.slice(0, 80) || 'Discord Announcement').trim().slice(0, 200);
  const finalBody = String(body || content || '').trim();
  if (!finalBody) return res.status(400).json({ error: 'Body/content is required' });
  if (finalBody.length > 4000) return res.status(400).json({ error: 'Body too long' });

  const ann: Announcement = {
    id: `norozo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: finalTitle,
    body: finalBody,
    authorName: String(author || 'Norozo (Discord #announcements)'),
    authorId: authorId ? String(authorId) : undefined,
    createdAt: new Date().toISOString(),
    source: 'norozo',
    discordChannelId: String(discordChannelId || process.env.ANNOUNCEMENTS_CHANNEL_ID || '1436509524818395156'),
  };

  try {
    await ensureSchema();
    await dbService.query(
      `INSERT INTO announcements (id, title, body, author_name, author_id, source, discord_channel_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ann.id, ann.title, ann.body, ann.authorName ?? null, ann.authorId ?? null, ann.source, ann.discordChannelId ?? null]
    );
  } catch (e: any) {
    logger.error('Failed to store Norozo announcement', { error: e.message });
    return res.status(500).json({ error: 'Failed to create announcement' });
  }

  logger.info('Announcement created via Norozo webhook', { id: ann.id, channelId: ann.discordChannelId });
  res.status(201).json({ success: true, announcement: ann });
});

// --- Norozo bot-state checkpoint -------------------------------------------------
// Render's free-tier disk is ephemeral (wiped on every spin-down/restart), so Norozo
// can't just write a "last online at" checkpoint to its own filesystem and expect it
// to survive. It already has a signed webhook channel into this service (see above),
// so reuse that same HMAC scheme + Postgres pool instead of standing up new infra.
// Tiny generic key/value table — not announcement-specific — in case other bot state
// needs the same durability later.

let stateSchemaReadyPromise: Promise<void> | null = null;

function ensureStateSchema(): Promise<void> {
  if (!stateSchemaReadyPromise) {
    stateSchemaReadyPromise = (async () => {
      await dbService.query(`
        CREATE TABLE IF NOT EXISTS bot_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      logger.info('bot_state table ready');
    })().catch((e: any) => {
      stateSchemaReadyPromise = null;
      throw e;
    });
  }
  return stateSchemaReadyPromise;
}

// GET has no body to HMAC over, so sign a fixed string instead — same secret,
// same timing-safe comparison as the POST routes above.
const STATE_GET_SIGNING_STRING = 'GET /api/webhooks/norozo/state';

// POST /api/webhooks/norozo/state — Norozo checkpoints "last known online at" here
// (and periodically heartbeats it) so a restart knows how far back to catch up,
// instead of relying on 'currently open thread' as a stand-in for 'not yet handled'.
router.post('/webhooks/norozo/state', async (req: Request, res: Response) => {
  const sigHeader = String(req.headers['x-norozo-signature'] || '').trim();
  const rawBody: Buffer | undefined = (req as any).rawBody;
  if (!rawBody || !verifySignature(rawBody, sigHeader)) {
    logger.warn('Norozo state webhook unauthorized', { hasSignature: !!sigHeader });
    alertNorozo({
      title: 'Rejected inbound Norozo state write',
      message: `POST /api/webhooks/norozo/state rejected (${sigHeader ? 'invalid' : 'missing'} signature) from ${req.ip}`,
      severity: 'warning',
    });
    return res.status(401).json({ error: 'Missing or invalid signature' });
  }

  const { key, value } = req.body || {};
  const stateKey = String(key || '').trim();
  const stateValue = String(value ?? '').trim();
  if (!stateKey || !stateValue) {
    return res.status(400).json({ error: 'key and value are required' });
  }
  if (stateKey.length > 200 || stateValue.length > 4000) {
    return res.status(400).json({ error: 'key/value too long' });
  }

  try {
    await ensureStateSchema();
    await dbService.query(
      `INSERT INTO bot_state (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [stateKey, stateValue]
    );
  } catch (e: any) {
    logger.error('Failed to save bot_state', { error: e.message, key: stateKey });
    return res.status(500).json({ error: 'Failed to save state' });
  }

  res.status(200).json({ success: true });
});

// GET /api/webhooks/norozo/state?key=norozo_last_online_at
router.get('/webhooks/norozo/state', async (req: Request, res: Response) => {
  const sigHeader = String(req.headers['x-norozo-signature'] || '').trim();
  const expected = signBody(STATE_GET_SIGNING_STRING);
  const a = Buffer.from(expected);
  const b = Buffer.from(sigHeader);
  if (!sigHeader || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    logger.warn('Norozo state read unauthorized', { hasSignature: !!sigHeader });
    alertNorozo({
      title: 'Rejected inbound Norozo state read',
      message: `GET /api/webhooks/norozo/state rejected (${sigHeader ? 'invalid' : 'missing'} signature) from ${req.ip}`,
      severity: 'warning',
    });
    return res.status(401).json({ error: 'Missing or invalid signature' });
  }

  const stateKey = String(req.query.key || '').trim();
  if (!stateKey) return res.status(400).json({ error: 'key query param is required' });

  try {
    await ensureStateSchema();
    const { result } = await dbService.query<{ value: string; updated_at: string }>(
      'SELECT value, updated_at FROM bot_state WHERE key = $1',
      [stateKey]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ key: stateKey, value: result.rows[0].value, updatedAt: result.rows[0].updated_at });
  } catch (e: any) {
    logger.error('Failed to read bot_state', { error: e.message, key: stateKey });
    res.status(500).json({ error: 'Failed to read state' });
  }
});

export default router;
