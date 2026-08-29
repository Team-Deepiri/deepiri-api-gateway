import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { createLogger } from '@team-deepiri/shared-utils';

const logger = createLogger('announcements');
const router = Router();

export interface Announcement {
  id: string;
  title: string;
  body: string;
  content?: string;
  author?: string;
  authorId?: string;
  source: 'discord' | 'platform' | 'norozo';
  discordMessageId?: string;
  discordChannelId?: string;
  jumpUrl?: string;
  url?: string;
  createdAt: string;
}

const announcements: Announcement[] = [];

// Load from Redis or file if available - in-memory for now; persists only per instance
// In production, this should be backed by Postgres. For now we keep in-memory + optional JSON file fallback.

const NOROZO_WEBHOOK_URL = process.env.NOROZO_ANNOUNCEMENTS_WEBHOOK_URL || process.env.NOROZO_WEBHOOK_URL || process.env.ANNOUNCEMENTS_NOROZO_WEBHOOK_URL || '';
const NOROZO_WEBHOOK_SECRET = process.env.NOROZO_WEBHOOK_SECRET || process.env.ANNOUNCEMENTS_WEBHOOK_SECRET || process.env.PLATFORM_ANNOUNCEMENTS_SECRET || '';
const PLATFORM_WEBHOOK_SECRET = process.env.PLATFORM_ANNOUNCEMENTS_SECRET || NOROZO_WEBHOOK_SECRET || '';

function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  if (!secret) return true;
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  let provided = signature.trim();
  if (provided.startsWith('sha256=')) provided = provided.split('=', 1)[1];
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
  } catch {
    return false;
  }
}

function forwardToNorozo(announcement: Announcement) {
  if (!NOROZO_WEBHOOK_URL) {
    logger.info('NOROZO_WEBHOOK_URL not set, skipping forward');
    return;
  }
  const payload = {
    title: announcement.title,
    body: announcement.body,
    content: announcement.body,
    author: announcement.author || 'Platform',
    url: announcement.url || '',
    source: 'platform',
    announcement_id: announcement.id,
    createdAt: announcement.createdAt,
  };
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (NOROZO_WEBHOOK_SECRET) {
    const sig = crypto.createHmac('sha256', NOROZO_WEBHOOK_SECRET).update(raw).digest('hex');
    headers['X-Norozo-Signature'] = `sha256=${sig}`;
    headers['X-Platform-Signature'] = `sha256=${sig}`;
  }
  axios.post(NOROZO_WEBHOOK_URL, payload, { headers, timeout: 8000 }).then(() => {
    logger.info(`Forwarded platform announcement ${announcement.id} to Norozo`);
  }).catch((err) => {
    logger.warn(`Failed to forward to Norozo: ${err.message}`);
  });
}

// GET /api/announcements - list all, newest first
router.get('/', (req: Request, res: Response) => {
  const sorted = [...announcements].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  res.json({ ok: true, announcements: sorted });
});

// GET /api/announcements/:id
router.get('/:id', (req: Request, res: Response) => {
  const found = announcements.find(a => a.id === req.params.id);
  if (!found) return res.status(404).json({ ok: false, message: 'Not found' });
  res.json({ ok: true, announcement: found });
});

// POST /api/announcements - create from platform UI (auth optional for now)
router.post('/', express.json(), (req: Request, res: Response) => {
  const { title, body, content, author } = req.body || {};
  const text = (body || content || '').toString().trim();
  const t = (title || '').toString().trim() || (text ? text.split('\n')[0].slice(0, 80) : 'Announcement');
  if (!text && !t) return res.status(400).json({ ok: false, message: 'Missing title/body' });

  const ann: Announcement = {
    id: `ann_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: t,
    body: text || t,
    content: text || t,
    author: (author || (req as any).user?.email || (req as any).user?.name || 'Platform').toString(),
    source: 'platform',
    createdAt: new Date().toISOString(),
    url: `/announcements/${Date.now()}`,
  };
  announcements.unshift(ann);
  // keep last 500
  if (announcements.length > 500) announcements.splice(500);

  // fire-and-forget forward to Norozo -> Discord #announcements
  forwardToNorozo(ann);

  res.status(201).json({ ok: true, announcement: ann });
});

// POST /api/webhooks/norozo/announcements - Discord -> Platform (called by Norozo)
// Also aliased as /api/announcements/webhook for compatibility
const norozoHandler = (req: Request, res: Response) => {
  const rawBody = (req as any).rawBody || JSON.stringify(req.body);
  const sig = (req.headers['x-norozo-signature'] || req.headers['x-platform-signature'] || req.headers['x-signature'] || req.headers['x-webhook-signature'] || '') as string;
  if (PLATFORM_WEBHOOK_SECRET && sig && !verifySignature(typeof rawBody === 'string' ? rawBody : JSON.stringify(req.body), sig, PLATFORM_WEBHOOK_SECRET)) {
    return res.status(401).json({ ok: false, message: 'Invalid signature' });
  }
  if (PLATFORM_WEBHOOK_SECRET && !sig) {
    logger.warn('Norozo webhook missing signature header');
  }
  const { title, body, content, author, authorId, discord_message_id, discord_channel_id, jump_url, url } = req.body || {};
  const text = (body || content || '').toString().trim();
  const t = (title || '').toString().trim() || (text ? text.split('\n')[0].slice(0, 80) : 'Announcement');
  if (!text && !t) return res.status(400).json({ ok: false, message: 'Missing title/body' });

  // de-dupe by discordMessageId
  if (discord_message_id && announcements.some(a => a.discordMessageId === String(discord_message_id))) {
    return res.json({ ok: true, deduped: true });
  }

  const ann: Announcement = {
    id: `ann_discord_${discord_message_id || Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title: t,
    body: text || t,
    content: text || t,
    author: (author || 'Discord').toString(),
    authorId: authorId ? String(authorId) : undefined,
    source: 'discord',
    discordMessageId: discord_message_id ? String(discord_message_id) : undefined,
    discordChannelId: discord_channel_id ? String(discord_channel_id) : undefined,
    jumpUrl: jump_url || url || undefined,
    url: url || jump_url || undefined,
    createdAt: new Date().toISOString(),
  };
  announcements.unshift(ann);
  if (announcements.length > 500) announcements.splice(500);

  logger.info(`Ingested Discord announcement ${ann.id} title=${t}`);
  res.json({ ok: true, announcement: ann });
};

router.post('/webhook', express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf.toString('utf8'); } }), norozoHandler);
router.post('/webhooks/norozo/announcements', express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf.toString('utf8'); } }), norozoHandler);

export default router;
