import { Router, Request, Response } from 'express';
import { userAuthMiddleware } from '../middleware/userAuth.middleware';
import { createLogger } from '@team-deepiri/shared-utils';
import fs from 'fs';
import path from 'path';

const router = Router();
const logger = createLogger('announcements');

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

const STORE_PATH = process.env.ANNOUNCEMENTS_STORE_PATH || '/tmp/announcements.json';

// In-memory store
let announcements: Announcement[] = [];

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf-8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) announcements = data;
    }
  } catch (e: any) {
    logger.warn('Failed to load announcements store', { error: e.message });
  }
}

function saveStore() {
  try {
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(announcements, null, 2));
  } catch (e: any) {
    logger.warn('Failed to save announcements store', { error: e.message });
  }
}

// Seed with a welcome announcement if empty (so dashboard not blank)
function ensureSeed() {
  if (announcements.length === 0) {
    announcements.push({
      id: 'seed-1',
      title: 'Welcome to the new Deepiri Platform',
      body: 'This is the new internal hub. Check Team Meetings on your Dashboard (role-filtered), and explore Tools for Registry, Jobs, Documents, and more. Norozo will now auto-forward every post from Discord #announcements here.',
      authorName: 'Deepiri Team',
      createdAt: new Date().toISOString(),
      source: 'web',
    });
    saveStore();
  }
}

loadStore();
ensureSeed();

// GET /api/announcements — list
router.get('/announcements', (req: Request, res: Response) => {
  const sorted = [...announcements].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  res.json({ announcements: sorted });
});

// POST /api/announcements — create from web (requires auth)
router.post('/announcements', userAuthMiddleware as any, (req: Request, res: Response) => {
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
  announcements.unshift(ann);
  // keep last 200
  if (announcements.length > 200) announcements = announcements.slice(0, 200);
  saveStore();
  logger.info('Announcement created via web', { id: ann.id, title: ann.title });
  res.status(201).json({ success: true, announcement: ann });
});

// POST /api/webhooks/norozo/announcements — Norozo Discord bot forwards #announcements
// Header: X-Norozo-Secret: <NOROZO_WEBHOOK_SECRET or DISCORD_BOT_TOKEN>
router.post('/webhooks/norozo/announcements', (req: Request, res: Response) => {
  const secret = String(req.headers['x-norozo-secret'] || req.headers['x-norozo-token'] || '').trim();
  const expected = String(process.env.NOROZO_WEBHOOK_SECRET || process.env.DISCORD_BOT_TOKEN || '').trim();
  // If expected is set, enforce; if not set, allow but warn (so local dev still works)
  if (expected && secret !== expected) {
    logger.warn('Norozo webhook unauthorized', { hasSecret: !!secret });
    return res.status(401).json({ error: 'Invalid Norozo secret' });
  }

  const { title, body, content, authorName, author, channelId } = req.body || {};
  // Norozo may send { title, body } or { content } (Discord message content)
  const finalTitle = String(title || content?.slice(0, 80) || 'Discord Announcement').trim().slice(0, 200);
  const finalBody = String(body || content || '').trim();
  if (!finalBody) return res.status(400).json({ error: 'Body/content is required' });
  if (finalBody.length > 4000) return res.status(400).json({ error: 'Body too long' });

  const ann: Announcement = {
    id: `norozo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: finalTitle,
    body: finalBody,
    authorName: String(authorName || author || 'Norozo (Discord #announcements)'),
    createdAt: new Date().toISOString(),
    source: 'norozo',
    discordChannelId: String(channelId || process.env.ANNOUNCEMENTS_CHANNEL_ID || '1436509524818395156'),
  };
  announcements.unshift(ann);
  if (announcements.length > 200) announcements = announcements.slice(0, 200);
  saveStore();
  logger.info('Announcement created via Norozo webhook', { id: ann.id, channelId: ann.discordChannelId });
  res.status(201).json({ success: true, announcement: ann });
});

export default router;
