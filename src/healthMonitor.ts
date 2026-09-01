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

// Only services actually deployed alongside this gateway (confirmed via `docker ps`
// on the VM). The full docker-compose.yml defines more (truss, telemetry,
// realtime-gateway, messaging-service, cyrex, language-intelligence-service) that
// aren't running in this deployment — checking those would always report "down"
// and spam #it-notifications / DM Security & Operations Support with false
// criticals for services that were never started here. Setting the matching env
// var opts a service back in once it's actually deployed.
function httpServiceTargets(): ServiceTarget[] {
  const candidates: ServiceTarget[] = [
    { name: 'auth-service', url: `${process.env.AUTH_SERVICE_URL || 'http://auth-service:5001'}/health` },
    { name: 'registry', url: `${process.env.REGISTRY_URL || 'http://registry:5003'}/health` },
    { name: 'external-bridge-service', url: `${process.env.EXTERNAL_BRIDGE_SERVICE_URL || 'http://external-bridge-service:5006'}/health` },
    { name: 'jobs', url: `${process.env.JOBS_URL || 'http://jobs:5007'}/health` },
  ];
  if (process.env.TRUSS_URL) candidates.push({ name: 'truss', url: `${process.env.TRUSS_URL}/health` });
  if (process.env.TELEMETRY_URL) candidates.push({ name: 'telemetry', url: `${process.env.TELEMETRY_URL}/health` });
  if (process.env.MESSAGING_SERVICE_URL) candidates.push({ name: 'messaging-service', url: `${process.env.MESSAGING_SERVICE_URL}/health` });
  if (process.env.CYREX_URL) candidates.push({ name: 'cyrex', url: `${process.env.CYREX_URL}/health` });
  if (process.env.LANGUAGE_INTELLIGENCE_SERVICE_URL) candidates.push({ name: 'language-intelligence-service', url: `${process.env.LANGUAGE_INTELLIGENCE_SERVICE_URL}/health` });
  return candidates;
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
      });
    } else if (state === 'critical') {
      alertNorozo({
        title: `${name} is DOWN`,
        message: `${name} has failed its last ${failureStreaks.get(name)} consecutive health checks (~${((failureStreaks.get(name) || 0) * CHECK_INTERVAL_MS) / 60000} min). Needs attention now.`,
        severity: 'critical',
        service: name,
      });
    } else if (state === 'recovered') {
      alertNorozo({
        title: `${name} recovered`,
        message: `${name} is responding again after ${failureStreaks.get(name) === 0 ? 'a prior outage' : 'downtime'}.`,
        severity: 'info',
        service: name,
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
    });
  }
}

export function startHealthMonitor(): void {
  logger.info('Starting platform health monitor', { intervalMs: CHECK_INTERVAL_MS });
  // Give the pool/redis clients a moment to connect before the first cycle.
  setTimeout(() => void runHealthCheckCycle(), 30_000);
  setInterval(() => void runHealthCheckCycle(), CHECK_INTERVAL_MS);
}
