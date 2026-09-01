/**
 * Periodic health check for every backend service this gateway proxies to,
 * plus Postgres/Redis. Reports state changes and an hourly all-clear summary
 * into #it-notifications via alertNorozo(); a service that's been down for
 * several consecutive checks escalates to 'critical', which additionally DMs
 * the Security & Operations Support role on Norozo's side.
 *
 * Deliberately its own module (not folded into server.ts) so it can be
 * dropped/rewired without touching the proxy wiring.
 */
import axios from 'axios';
import { createLogger } from '@team-deepiri/shared-utils';
import * as dbService from './services/dbService';
import * as redisService from './services/redisService';
import { alertNorozo } from './routes/announcements';

const logger = createLogger('healthMonitor');

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const SUMMARY_INTERVAL_CHECKS = 12; // ~hourly at the interval above
const CONSECUTIVE_FAILURES_FOR_CRITICAL = 3; // ~15 min of continuous downtime

interface ServiceTarget {
  name: string;
  url: string; // health endpoint, or base URL if it has none
}

// truss, telemetry, realtime-gateway, messaging-service, cyrex, and
// language-intelligence-service are deepiri-control-plane services — not part of
// this deployment at all, not just "currently stopped" — so they're not monitored
// here.
function httpServiceTargets(): ServiceTarget[] {
  return [
    { name: 'auth-service', url: `${process.env.AUTH_SERVICE_URL || 'http://auth-service:5001'}/health` },
    { name: 'registry', url: `${process.env.REGISTRY_URL || 'http://registry:5003'}/health` },
    { name: 'external-bridge-service', url: `${process.env.EXTERNAL_BRIDGE_SERVICE_URL || 'http://external-bridge-service:5006'}/health` },
    { name: 'jobs', url: `${process.env.JOBS_URL || 'http://jobs:5007'}/health` },
  ];
}

// name -> consecutive failure count (0 = currently up)
const failureStreaks = new Map<string, number>();
let checkCount = 0;

async function checkHttpService(target: ServiceTarget): Promise<boolean> {
  try {
    const res = await axios.get(target.url, { timeout: 8_000, validateStatus: () => true });
    return res.status >= 200 && res.status < 500;
  } catch {
    return false;
  }
}

async function checkPostgres(): Promise<boolean> {
  try {
    await dbService.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

async function checkRedis(): Promise<boolean> {
  try {
    return await redisService.isHealthy();
  } catch {
    return false;
  }
}

function recordResult(name: string, healthy: boolean): 'ok' | 'recovered' | 'warning' | 'critical' {
  const prevStreak = failureStreaks.get(name) || 0;
  if (healthy) {
    failureStreaks.set(name, 0);
    return prevStreak > 0 ? 'recovered' : 'ok';
  }
  const streak = prevStreak + 1;
  failureStreaks.set(name, streak);
  if (streak === 1) return 'warning'; // first failure — don't cry wolf yet on a single blip
  return streak >= CONSECUTIVE_FAILURES_FOR_CRITICAL ? 'critical' : 'ok';
}

async function runHealthCheckCycle(): Promise<void> {
  checkCount += 1;
  const results: { name: string; healthy: boolean }[] = [];

  const httpTargets = httpServiceTargets();
  const httpResults = await Promise.all(httpTargets.map((t) => checkHttpService(t)));
  httpTargets.forEach((t, i) => results.push({ name: t.name, healthy: httpResults[i] }));

  results.push({ name: 'postgres-platform', healthy: await checkPostgres() });
  results.push({ name: 'redis', healthy: await checkRedis() });

  const downNow: string[] = [];
  for (const { name, healthy } of results) {
    const state = recordResult(name, healthy);
    if (!healthy) downNow.push(name);

    if (state === 'warning') {
      alertNorozo({
        title: `${name} is not responding`,
        message: `${name} failed its health check. Watching for ${CONSECUTIVE_FAILURES_FOR_CRITICAL - 1} more consecutive failure(s) before escalating.`,
        severity: 'warning',
        service: name,
        steps:
          `1. No action needed yet — first failure, could be a blip.\n` +
          `2. If curious now: \`docker logs --tail 50 deepiri-${name}\` on the VM (159.195.234.19).\n` +
          `3. Wait for the next check (~5 min) — either resolves itself or escalates to critical here.`,
      });
    } else if (state === 'critical') {
      alertNorozo({
        title: `${name} is DOWN`,
        message: `${name} has failed its last ${failureStreaks.get(name)} consecutive health checks (~${((failureStreaks.get(name) || 0) * CHECK_INTERVAL_MS) / 60000} min). Needs attention now.`,
        severity: 'critical',
        service: name,
        steps:
          `1. You were DMed for this — acknowledge here so others know it's being worked.\n` +
          `2. SSH to the VM (159.195.234.19), run \`docker ps -a --filter name=deepiri-${name}\` and \`docker logs --tail 100 deepiri-${name}\`.\n` +
          `3. If Postgres/Redis: check those containers first — most other services depend on them and will look "down" as a side effect.\n` +
          `4. If the container exited: \`cd /opt/deepiri/deepiri-platform && docker compose up -d --no-deps ${name}\`.\n` +
          `5. If it's crash-looping: check for a recent deploy/config change to this service before restarting blindly.\n` +
          `6. Once it's back, wait for the "recovered" alert here to confirm before standing down.`,
      });
    } else if (state === 'recovered') {
      alertNorozo({
        title: `${name} recovered`,
        message: `${name} is responding again after ${failureStreaks.get(name) === 0 ? 'a prior outage' : 'downtime'}.`,
        severity: 'info',
        service: name,
        steps: `No action needed. If this followed a critical alert, consider a quick postmortem note on what caused it.`,
      });
    }
  }

  if (checkCount % SUMMARY_INTERVAL_CHECKS === 0) {
    const total = results.length;
    const upCount = total - downNow.length;
    alertNorozo({
      title: 'Platform health summary',
      message:
        downNow.length === 0
          ? `All ${total} services + Postgres + Redis are healthy.`
          : `${upCount}/${total} healthy. Currently down: ${downNow.join(', ')}.`,
      severity: downNow.length === 0 ? 'info' : 'warning',
      service: 'deepiri-platform',
      steps:
        downNow.length === 0
          ? 'No action needed — routine hourly status.'
          : `Currently-down services already have their own alert(s) above with handling steps — this is just the rollup.`,
    });
  }
}

export function startHealthMonitor(): void {
  logger.info('Starting platform health monitor', { intervalMs: CHECK_INTERVAL_MS });
  // Give the pool/redis clients a moment to connect before the first cycle.
  setTimeout(() => void runHealthCheckCycle(), 30_000);
  setInterval(() => void runHealthCheckCycle(), CHECK_INTERVAL_MS);
}
