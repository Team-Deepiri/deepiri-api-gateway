/**
 * One-RTT session bootstrap at the gateway.
 *
 * Client guarantee: one hop to the gateway fans out auth verify ∥ LIS health,
 * which is always faster than two sequential client→gateway→service round-trips.
 * Results are write-through to PrismPipe so subsequent prism calls stay warm.
 */
import type { Request, Response } from 'express';
import { createLogger } from '@team-deepiri/shared-utils';

const logger = createLogger('api-gateway-prism-session');

type Probe = {
  ok: boolean;
  status_code: number;
  body: unknown;
  url: string;
};

async function probeJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Probe> {
  const timeoutMs = init.timeoutMs ?? 1500;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: init.method || 'GET',
      headers: init.headers,
      signal: ctrl.signal,
    });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = { raw: await res.text().catch(() => '') };
    }
    return {
      ok: res.ok,
      status_code: res.status,
      body,
      url,
    };
  } catch (err: any) {
    return {
      ok: false,
      status_code: 0,
      body: { error: String(err?.message || err) },
      url,
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeAuthorization(raw: unknown): string {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (!value.toLowerCase().startsWith('bearer ')) {
    return `Bearer ${value}`;
  }
  return value;
}

export function createPrismSessionHandler(opts: {
  authServiceUrl: string;
  lisServiceUrl: string;
  prismpipeUrl?: string;
}) {
  const authBase = opts.authServiceUrl.replace(/\/$/, '');
  const lisBase = opts.lisServiceUrl.replace(/\/$/, '');
  const prismBase = (opts.prismpipeUrl || '').replace(/\/$/, '');

  return async function prismSessionInline(req: Request, res: Response): Promise<void> {
    const authorization = normalizeAuthorization(
      req.body?.authorization ||
        req.body?.input?.authorization ||
        req.headers.authorization
    );

    const verifyUrl = `${authBase}/auth/verify`;
    const lisUrl = `${lisBase}/health`;

    const [authVerify, lisHealth] = await Promise.all([
      authorization
        ? probeJson(verifyUrl, {
            headers: { Authorization: authorization },
            timeoutMs: 1500,
          })
        : Promise.resolve({
            ok: false,
            status_code: 401,
            body: { error: 'authorization required' },
            url: verifyUrl,
          } as Probe),
      probeJson(lisUrl, { timeoutMs: 800 }),
    ]);

    let user: unknown = null;
    if (authVerify.ok && authVerify.body && typeof authVerify.body === 'object') {
      const body = authVerify.body as Record<string, unknown>;
      user = body.user || body;
    }

    const useful = Boolean(authVerify.ok) && Boolean(lisHealth.ok);
    const session = {
      authenticated: Boolean(authVerify.ok),
      user,
      lis_ready: Boolean(lisHealth.ok),
      useful,
      productivity: {
        client_round_trips_saved: 1,
        parallel_hops: ['auth.verify', 'lis.health'],
        downstream_http_calls: 2,
        guarantee: 'gateway_inline_one_rtt',
      },
    };

    // Write-through so PrismPipe L2/Redis stays coherent for non-gateway callers.
    if (prismBase && authorization) {
      void fetch(`${prismBase}/pipelines/deepiri/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authorization,
          use_computation_sharing: true,
        }),
      }).catch((err) => {
        logger.warn('PrismPipe session write-through failed', {
          error: String(err?.message || err),
        });
      });
    }

    res.status(200).json({
      session,
      report: { useful, required_ok: useful },
      useful,
      path: 'gateway_inline',
    });
  };
}
