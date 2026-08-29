import { Router, Request, Response } from 'express';
import { summarizeMember, routeAIRequest, estimateTokens, buildMemberContext } from '../services/aiProviderRouter';
import { createLogger } from '@team-deepiri/shared-utils';

const logger = createLogger('ai');
const router = Router();

// GET /api/ai/providers - list configured providers (no keys)
router.get('/providers', (req: Request, res: Response) => {
  const providers = [];
  if (process.env.OPENROUTER_API_KEY) providers.push({ name: 'openrouter-primary', model: process.env.OPENROUTER_MODEL_A || process.env.OPENROUTER_MODEL || 'openrouter/auto' });
  if (process.env.OPENROUTER_MODEL_B) providers.push({ name: 'openrouter-secondary', model: process.env.OPENROUTER_MODEL_B });
  if (process.env.GEMINI_API_KEY && providers.length < 2) providers.push({ name: 'gemini', model: process.env.GEMINI_MODEL || 'gemini-2.0-flash' });
  if (providers.length === 0) providers.push({ name: 'mock', model: 'mock' });
  res.json({ ok: true, providers, sorge: { tokenization: 'sorge/file_splitter + repo_context', chunkBudget: 8000 } });
});

// POST /api/ai/summarize-member - summarize team member (requires auth optionally)
router.post('/summarize-member', async (req: Request, res: Response) => {
  try {
    const member = req.body?.member || req.body;
    if (!member || typeof member !== 'object') return res.status(400).json({ ok: false, message: 'member object required' });
    const result = await summarizeMember(member);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    logger.error(`summarize-member failed: ${err.message}`);
    res.status(500).json({ ok: false, message: err.message });
  }
});

// POST /api/ai/route - generic provider router (for auto-fill etc)
router.post('/route', async (req: Request, res: Response) => {
  try {
    const { prompt, context, maxTokens } = req.body || {};
    if (!prompt) return res.status(400).json({ ok: false, message: 'prompt required' });
    const ctx = typeof context === 'string' ? context : buildMemberContext(context || {});
    const result = await routeAIRequest(prompt, ctx, { maxTokens });
    res.json({ ok: true, ...result, tokens: result.tokensUsed });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// POST /api/ai/autofill - auto-fill missing team member fields
router.post('/autofill', async (req: Request, res: Response) => {
  try {
    const { member, fields } = req.body || {};
    if (!member) return res.status(400).json({ ok: false, message: 'member required' });
    const tokensBefore = estimateTokens(JSON.stringify(member));
    const ctx = buildMemberContext(member);
    const prompt = `Auto-fill missing fields [${(fields || ['bio', 'skills', 'availability']).join(', ')}] for this team member. Return JSON only with those keys. Member: ${JSON.stringify(member).slice(0, 6000)}`;
    const result = await routeAIRequest(prompt, ctx, { maxTokens: 500 });
    let filled: any = {};
    try { filled = JSON.parse(result.content); } catch { filled = { raw: result.content }; }
    res.json({ ok: true, autofill: filled, provider: result.provider, tokensBefore, tokensAfter: estimateTokens(result.content) });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

export default router;
