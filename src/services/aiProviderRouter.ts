import axios from 'axios';
import crypto from 'crypto';
import { createLogger } from '@team-deepiri/shared-utils';

const logger = createLogger('aiProviderRouter');

export interface AIProviderConfig {
  name: string;
  model: string;
  endpoint: string;
  apiKey: string;
  maxContextTokens: number;
  qualityPrior: number;
}

export interface AIRouteResult {
  provider: string;
  model: string;
  content: string;
  tokensUsed: number;
  latencyMs: number;
  fallbackUsed?: boolean;
}

// ---- Sorge-inspired tokenization & context packing (vendored minimal) ----

export function estimateTokens(text: string): number {
  // Mirrors bot/diff_parser.estimate_tokens: ~4 chars per token, with overhead
  if (!text) return 0;
  return Math.ceil(text.length / 4) + 8;
}

export function chunkContext(text: string, budgetTokens: number): string[] {
  const total = estimateTokens(text);
  if (total <= budgetTokens) return [text];
  // Split by paragraphs, pack greedily like FileSplitter._pack_group
  const paras = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let cur = '';
  let curTokens = 0;
  for (const p of paras) {
    const t = estimateTokens(p);
    if (t > budgetTokens) {
      // large para: split by sentences
      const sentences = p.split(/(?<=[.!?])\s+/);
      for (const s of sentences) {
        const st = estimateTokens(s);
        if (curTokens + st > budgetTokens && cur) {
          chunks.push(cur);
          cur = s;
          curTokens = st;
        } else {
          cur = cur ? `${cur}\n\n${s}` : s;
          curTokens += st;
        }
        if (curTokens >= budgetTokens) {
          chunks.push(cur);
          cur = '';
          curTokens = 0;
        }
      }
      continue;
    }
    if (curTokens + t > budgetTokens && cur) {
      chunks.push(cur);
      cur = p;
      curTokens = t;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
      curTokens += t;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export function buildMemberContext(member: any): string {
  // Compact evidence cards like repo_context.format_context_pack
  const parts: string[] = ['MEMBER_CONTEXT compact:'];
  if (member.github) parts.push(`github:${member.github} commits:${member.commits || 0} prs:${member.prs || 0}`);
  if (member.plakyTasks) parts.push(`plaky:${member.plakyTasks.slice(0, 5).map((t: any) => t.title || t.name).join(', ')}`);
  if (member.roles) parts.push(`roles:${Array.isArray(member.roles) ? member.roles.join(',') : member.roles}`);
  if (member.bio) parts.push(`bio:${member.bio.slice(0, 300)}`);
  // fingerprint for cache key
  const fp = crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12);
  parts.push(`fp:${fp}`);
  return parts.join('\n');
}

function resolveProviders(): AIProviderConfig[] {
  // Two providers: primary OpenRouter, secondary fallback (also OpenRouter alternate model or Gemini)
  const openrouterKey = process.env.OPENROUTER_API_KEY || process.env.SORGE_OPENROUTER_API_KEY || process.env.AI_API_KEY || '';
  const openrouterModelA = process.env.OPENROUTER_MODEL_A || process.env.OPENROUTER_MODEL || 'openrouter/auto';
  const openrouterModelB = process.env.OPENROUTER_MODEL_B || 'google/gemini-2.0-flash-001';
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

  const providers: AIProviderConfig[] = [];
  if (openrouterKey) {
    providers.push({
      name: 'openrouter-primary',
      model: openrouterModelA,
      endpoint: process.env.OPENROUTER_ENDPOINT || 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: openrouterKey,
      maxContextTokens: parseInt(process.env.OPENROUTER_MAX_TOKENS || '8000', 10),
      qualityPrior: 0.85,
    });
    // second model on same endpoint counts as second provider for fallback
    if (openrouterModelB && openrouterModelB !== openrouterModelA) {
      providers.push({
        name: 'openrouter-secondary',
        model: openrouterModelB,
        endpoint: process.env.OPENROUTER_ENDPOINT || 'https://openrouter.ai/api/v1/chat/completions',
        apiKey: openrouterKey,
        maxContextTokens: parseInt(process.env.OPENROUTER_MAX_TOKENS || '8000', 10),
        qualityPrior: 0.7,
      });
    }
  }
  if (geminiKey && providers.length < 2) {
    providers.push({
      name: 'gemini',
      model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      apiKey: geminiKey,
      maxContextTokens: 16000,
      qualityPrior: 0.75,
    });
  }
  // Deterministic fallback: if no keys, return mock provider for dev (no network)
  if (providers.length === 0) {
    logger.warn('No AI provider keys set; using mock provider');
  }
  return providers;
}

async function callProvider(provider: AIProviderConfig, prompt: string, context: string, maxTokens: number): Promise<string> {
  if (!provider.apiKey) throw new Error(`Missing API key for ${provider.name}`);
  const body: any = {
    model: provider.model,
    messages: [
      { role: 'system', content: 'You are a concise team assistant. Summarize the member and auto-fill missing fields in JSON.' },
      { role: 'user', content: `${context}\n\nTASK: ${prompt}` },
    ],
    max_tokens: Math.min(maxTokens, 1200),
    temperature: 0.4,
  };
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${provider.apiKey}`,
  };
  if (provider.endpoint.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = process.env.PLATFORM_URL || 'https://platform.deepiri.com';
    headers['X-Title'] = 'Deepiri Platform';
  }
  const res = await axios.post(provider.endpoint, body, { headers, timeout: 15000 });
  const data: any = res.data;
  // OpenAI-compatible shape
  if (data.choices && data.choices[0]?.message?.content) return data.choices[0].message.content;
  if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) return data.candidates[0].content.parts[0].text;
  if (typeof data.content === 'string') return data.content;
  return JSON.stringify(data).slice(0, 2000);
}

export async function routeAIRequest(prompt: string, memberContext: string, opts?: { maxTokens?: number }): Promise<AIRouteResult> {
  const maxTokens = opts?.maxTokens || 800;
  const providers = resolveProviders();
  if (providers.length === 0) {
    // mock for dev / tests
    const mock = `Mock summary for member context (${estimateTokens(memberContext)} tokens): ${memberContext.slice(0, 200)}... Prompt: ${prompt.slice(0, 200)}`;
    return { provider: 'mock', model: 'mock', content: mock, tokensUsed: estimateTokens(mock), latencyMs: 5 };
  }

  // Sorge-style: build context pack, chunk if over budget, transfer via fingerprint
  const primary = providers[0];
  const budget = primary.maxContextTokens - maxTokens - 500; // reserve
  const chunks = chunkContext(memberContext, budget);
  const contextToSend = chunks[0] + (chunks.length > 1 ? `\n\n[truncated ${chunks.length - 1} chunks omitted; ${estimateTokens(memberContext)}→${estimateTokens(chunks[0])} tokens]` : '');

  let lastErr: any = null;
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    const start = Date.now();
    try {
      const content = await callProvider(p, prompt, contextToSend, maxTokens);
      const latency = Date.now() - start;
      logger.info(`AI route success ${p.name}/${p.model} ${latency}ms tokens=${estimateTokens(contextToSend)}`);
      return { provider: p.name, model: p.model, content, tokensUsed: estimateTokens(content), latencyMs: latency, fallbackUsed: i > 0 };
    } catch (err: any) {
      lastErr = err;
      const msg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
      logger.warn(`AI provider ${p.name} failed: ${msg} (status ${err.response?.status})`);
      if (err.response?.status === 429) {
        // rate limited, try next provider immediately
        continue;
      }
      if (i === providers.length - 1) throw err;
    }
  }
  throw lastErr || new Error('All AI providers failed');
}

// High-level helper for team member summarization + auto-fill
export async function summarizeMember(member: any): Promise<{ summary: string; autofill: Record<string, any>; provider: string; tokens: number }> {
  const ctx = buildMemberContext(member);
  const prompt = `Summarize this team member in 3 bullet points (strengths, recent activity, next steps) and auto-fill a JSON object with keys: displayName, bio, skills (array), availability (string), suggestedRole. Return JSON with keys summary (string) and autofill (object). Member data: ${JSON.stringify(member).slice(0, 8000)}`;
  const result = await routeAIRequest(prompt, ctx, { maxTokens: 700 });
  let autofill: Record<string, any> = {};
  let summary = result.content;
  try {
    const parsed = JSON.parse(result.content);
    if (parsed.summary) summary = parsed.summary;
    if (parsed.autofill) autofill = parsed.autofill;
    else if (parsed.skills || parsed.bio) autofill = parsed;
  } catch {
    // content is plain text; synthesize autofill
    autofill = { raw: result.content.slice(0, 500) };
  }
  return { summary, autofill, provider: result.provider, tokens: result.tokensUsed };
}
