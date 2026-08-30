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

export default router;
