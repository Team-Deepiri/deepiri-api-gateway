import { Router, Request, Response } from 'express';
import { createLogger } from '@team-deepiri/shared-utils';
import crypto from 'crypto';
import * as dbService from '../services/dbService';

const router = Router();
const logger = createLogger('member-email');

// Shared secret with Norozo's PLATFORM_ANNOUNCEMENTS_WEBHOOK_SECRET /
// ANNOUNCEMENTS_WEBHOOK_SECRET — same trust boundary as the announcements
// and pr-staleness webhooks (platform.deepiri.com <-> Norozo).
const MEMBER_EMAIL_WEBHOOK_SECRET =
  process.env.PLATFORM_ANNOUNCEMENTS_WEBHOOK_SECRET ||
  process.env.PLATFORM_WEBHOOK_SECRET ||
  process.env.ANNOUNCEMENTS_WEBHOOK_SECRET ||
  '';

function signBody(rawBody: Buffer | string, secret: string): string {
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf-8');
  return `sha256=${crypto.createHmac('sha256', secret).update(buf).digest('hex')}`;
}

function verifySignature(rawBody: Buffer, signatureHeader: string): boolean {
  if (!MEMBER_EMAIL_WEBHOOK_SECRET || !signatureHeader) return false;
  const expected = signBody(rawBody, MEMBER_EMAIL_WEBHOOK_SECRET);
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Match member_email_store.py's GET signing string: the HMAC is over the
// literal GET target string (method + path + query), not a body.
const GET_SIGNING_PREFIX = 'GET /api/webhooks/norozo/member-email?discord_id=';

function verifyGetSignature(discordId: string, signatureHeader: string): boolean {
  if (!MEMBER_EMAIL_WEBHOOK_SECRET || !signatureHeader) return false;
  const signingString = `${GET_SIGNING_PREFIX}${discordId}`;
  const expected = signBody(signingString, MEMBER_EMAIL_WEBHOOK_SECRET);
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

interface MemberEmailRow {
  discord_id: string;
  discord_username: string | null;
  email: string | null;
  real_name: string | null;
  github_username: string | null;
  updated_at: string;
}

interface MemberProfile {
  discordId: string;
  discordUsername?: string;
  email?: string;
  realName?: string;
  githubUsername?: string;
  updatedAt?: string;
}

function toProfile(row: MemberEmailRow): MemberProfile {
  const profile: MemberProfile = { discordId: row.discord_id };
  if (row.discord_username) profile.discordUsername = row.discord_username;
  if (row.email) profile.email = row.email;
  if (row.real_name) profile.realName = row.real_name;
  if (row.github_username) profile.githubUsername = row.github_username;
  profile.updatedAt = new Date(row.updated_at).toISOString();
  return profile;
}

// Postgres store, mirroring the announcements webhook: table created lazily on
// first use (this service has no migration framework), upserted on every write.
let schemaReadyPromise: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await dbService.query(`
        CREATE TABLE IF NOT EXISTS member_emails (
          discord_id TEXT PRIMARY KEY,
          discord_username TEXT,
          email TEXT,
          real_name TEXT,
          github_username TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await dbService.query(`
        CREATE INDEX IF NOT EXISTS idx_member_emails_email ON member_emails (email)
        WHERE email IS NOT NULL
      `);
      await dbService.query(`
        CREATE INDEX IF NOT EXISTS idx_member_emails_github ON member_emails (github_username)
        WHERE github_username IS NOT NULL
      `);
      logger.info('member_emails table ready');
    })().catch((e: any) => {
      schemaReadyPromise = null; // retry on next request instead of caching a failure
      throw e;
    });
  }
  return schemaReadyPromise;
}

router.get('/webhooks/norozo/member-email', async (req: Request, res: Response) => {
  const discordId = String(req.query.discord_id || '').trim();
  if (!discordId) return res.status(400).json({ error: 'discord_id query param is required' });
  const sigHeader = String(req.headers['x-norozo-signature'] || req.headers['x-platform-signature'] || '').trim();
  if (!MEMBER_EMAIL_WEBHOOK_SECRET || !verifyGetSignature(discordId, sigHeader)) {
    logger.warn('member-email GET unauthorized', { hasSignature: !!sigHeader, discordId });
    return res.status(401).json({ error: 'Missing or invalid signature' });
  }
  try {
    await ensureSchema();
    const { result } = await dbService.query<MemberEmailRow>(
      'SELECT * FROM member_emails WHERE discord_id = $1',
      [discordId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    return res.json({ ...toProfile(result.rows[0]) });
  } catch (e: any) {
    logger.error('Failed to load member-email profile', { error: e.message, discordId });
    return res.status(500).json({ error: 'Failed to load member-email profile' });
  }
});

router.post('/webhooks/norozo/member-email', async (req: Request, res: Response) => {
  const sigHeader = String(req.headers['x-norozo-signature'] || req.headers['x-platform-signature'] || '').trim();
  const rawBody: Buffer | undefined = (req as any).rawBody;
  if (!rawBody || !verifySignature(rawBody, sigHeader)) {
    logger.warn('member-email webhook unauthorized', { hasSignature: !!sigHeader });
    return res.status(401).json({ error: 'Missing or invalid signature' });
  }

  const { discord_id: discordIdRaw, discord_username, email, real_name, github_username } = req.body || {};
  const discordId = String(discordIdRaw || '').trim();
  if (!discordId) return res.status(400).json({ error: 'discord_id is required' });
  const emailValue = email ? String(email).trim() : null;
  const usernameValue = discord_username ? String(discord_username).trim() : null;
  const realNameValue = real_name ? String(real_name).trim() : null;
  const githubValue = github_username ? String(github_username).trim() : null;
  const EMAIL_RE = /^[\w.+-]+@[\w-]+\.[\w.-]+$/;
  if (emailValue && (emailValue.length > 254 || !EMAIL_RE.test(emailValue))) {
    return res.status(400).json({ error: 'email does not look valid' });
  }

  try {
    await ensureSchema();
    const { result } = await dbService.query(
      `INSERT INTO member_emails (discord_id, discord_username, email, real_name, github_username, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (discord_id) DO UPDATE SET
         discord_username = COALESCE(EXCLUDED.discord_username, member_emails.discord_username),
         email = COALESCE(EXCLUDED.email, member_emails.email),
         real_name = COALESCE(EXCLUDED.real_name, member_emails.real_name),
         github_username = COALESCE(EXCLUDED.github_username, member_emails.github_username),
         updated_at = now()`,
      [discordId, usernameValue, emailValue, realNameValue, githubValue]
    );
    logger.info('member-email upserted', { discordId, email: emailValue !== null, github: githubValue !== null });
    return res.status(200).json({ success: true, discordId });
  } catch (e: any) {
    logger.error('Failed to upsert member-email', { error: e.message, discordId });
    return res.status(500).json({ error: 'Failed to save member-email' });
  }
});

export default router;