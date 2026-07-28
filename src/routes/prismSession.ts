/**
 * One-RTT session bootstrap at the gateway (fully local auth).
 *
 * JWT is verified in-process (same secret/claims as auth-service). Only LIS
 * /health is a downstream hop. PrismPipe write-through is opt-in — login
 * birth-warm already populates the shared cache.
 */
import type { Request, Response } from 'express';
import { createLogger } from '@team-deepiri/shared-utils';
import { verifyLocalBearerToken } from '../auth/localJwt';

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

function writeThroughEnabled(): boolean {
  return process.env.PRISMPIPE_SESSION_WRITE_THROUGH === 'true';
}

export function createPrismSessionHandler(opts: {
  lisServiceUrl: string;
  prismpipeUrl?: string;
}) {
  const lisBase = opts.lisServiceUrl.replace(/\/$/, '');
  const prismBase = (opts.prismpipeUrl || '').replace(/\/$/, '');

  return async function prismSessionInline(req: Request, res: Response): Promise<void> {
    const authorization = normalizeAuthorization(
      req.body?.authorization ||
        req.body?.input?.authorization ||
        req.headers.authorization
    );

    const jwtResult = verifyLocalBearerToken(authorization);
    const lisUrl = `${lisBase}/health`;

    const authVerify =
      jwtResult.ok === false
        ? {
            ok: false as const,
            status_code: jwtResult.status,
            body: { error: jwtResult.error },
            url: 'local:jwt',
          }
        : {
            ok: true as const,
            status_code: 200,
            body: {
              success: true,
              user: {
                id: jwtResult.payload.userId,
                email: jwtResult.payload.email,
              },
            },
            url: 'local:jwt',
          };

    const lisHealth = await probeJson(lisUrl, { timeoutMs: 800 });

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
        parallel_hops: ['local.jwt_verify', 'lis.health'],
        downstream_http_calls: 1,
        guarantee: 'gateway_local_jwt_one_rtt',
      },
    };

    if (!authVerify.ok) {
      logger.warn('Inline session local JWT verify failed', {
        error: (authVerify.body as { error?: string })?.error,
      });
    }

    if (writeThroughEnabled() && prismBase && authorization && useful) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      void fetch(`${prismBase}/pipelines/deepiri/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authorization,
          use_computation_sharing: true,
        }),
        signal: ctrl.signal,
      })
        .catch((err) => {
          logger.warn('PrismPipe session write-through failed', {
            error: String(err?.message || err),
          });
        })
        .finally(() => clearTimeout(timer));
    }

    res.status(200).json({
      session,
      report: { useful, required_ok: useful },
      useful,
      path: 'gateway_local_jwt',
    });
  };
}
