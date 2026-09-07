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
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '@team-deepiri/shared-utils';
import * as dbService from './services/dbService';
import * as redisService from './services/redisService';
import { alertNorozo } from './routes/announcements';

const execAsync = promisify(exec);
const logger = createLogger('healthMonitor');

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 min -- also the finest VM-resource alert cadence (emergency tier)
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

// --- VM compute resource monitoring -------------------------------------------
// Posts VM-level CPU/memory/disk health into #it-notifications (via the same
// alertNorozo() pipe as the service checks above), on a cadence that tightens
// as things get worse: routine every 6h, every 1h once "pretty poor", every
// 30min once "really poor", every 5min (this cycle's own interval -- as fast
// as this loop runs at all) once it's a full emergency. An escalation (severity
// getting worse) always posts immediately rather than waiting out the previous,
// looser cadence; a de-escalation back to fully healthy also posts immediately,
// once, so IT knows to stand down.

export type VmSeverity = 'ok' | 'degraded' | 'bad' | 'emergency';
const VM_SEVERITY_RANK: Record<VmSeverity, number> = { ok: 0, degraded: 1, bad: 2, emergency: 3 };
const VM_SEVERITY_CADENCE_MS: Record<VmSeverity, number> = {
  ok: 6 * 60 * 60 * 1000,
  degraded: 60 * 60 * 1000,
  bad: 30 * 60 * 1000,
  emergency: 5 * 60 * 1000,
};

export interface VmResourceSnapshot {
  loadAvg1: number;
  cpuCount: number;
  loadPerCore: number;
  memUsedPct: number;
  memTotalGB: number;
  memUsedGB: number;
  diskUsedPct: number;
  diskTotalGB: number;
  diskUsedGB: number;
}

async function readDiskUsage(): Promise<{ usedPct: number; totalGB: number; usedGB: number } | null> {
  try {
    // POSIX output mode (-P) so the header/columns are stable across df implementations.
    const { stdout } = await execAsync('df -Pk /');
    const lines = stdout.trim().split('\n');
    const cols = lines[lines.length - 1].trim().split(/\s+/);
    const totalKB = parseInt(cols[1], 10);
    const usedKB = parseInt(cols[2], 10);
    if (!Number.isFinite(totalKB) || totalKB <= 0 || !Number.isFinite(usedKB)) return null;
    return { usedPct: (usedKB / totalKB) * 100, totalGB: totalKB / 1024 / 1024, usedGB: usedKB / 1024 / 1024 };
  } catch (e: any) {
    logger.error('Failed to read disk usage for VM resource check', { error: e.message });
    return null;
  }
}

async function readVmSnapshot(): Promise<VmResourceSnapshot | null> {
  const disk = await readDiskUsage();
  if (!disk) return null;
  const cpuCount = os.cpus().length || 1;
  const loadAvg1 = os.loadavg()[0];
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const memUsed = memTotal - memFree;
  return {
    loadAvg1,
    cpuCount,
    loadPerCore: loadAvg1 / cpuCount,
    memUsedPct: (memUsed / memTotal) * 100,
    memTotalGB: memTotal / 1024 / 1024 / 1024,
    memUsedGB: memUsed / 1024 / 1024 / 1024,
    diskUsedPct: disk.usedPct,
    diskTotalGB: disk.totalGB,
    diskUsedGB: disk.usedGB,
  };
}

export function classifyVmSeverity(s: VmResourceSnapshot): VmSeverity {
  if (s.loadPerCore >= 3 || s.memUsedPct >= 95 || s.diskUsedPct >= 95) return 'emergency';
  if (s.loadPerCore >= 1.5 || s.memUsedPct >= 85 || s.diskUsedPct >= 90) return 'bad';
  if (s.loadPerCore >= 0.7 || s.memUsedPct >= 75 || s.diskUsedPct >= 80) return 'degraded';
  return 'ok';
}

function formatVmMetrics(s: VmResourceSnapshot): string {
  return (
    `Load: ${s.loadAvg1.toFixed(2)} (${(s.loadPerCore * 100).toFixed(0)}% of ${s.cpuCount} cores)\n` +
    `Memory: ${s.memUsedGB.toFixed(1)}GB / ${s.memTotalGB.toFixed(1)}GB (${s.memUsedPct.toFixed(0)}%)\n` +
    `Disk: ${s.diskUsedGB.toFixed(0)}GB / ${s.diskTotalGB.toFixed(0)}GB (${s.diskUsedPct.toFixed(0)}%)`
  );
}

let vmLastPostedAt = 0;
let vmLastSeverity: VmSeverity = 'ok';

async function checkVmResources(): Promise<void> {
  const snapshot = await readVmSnapshot();
  if (!snapshot) return;
  const severity = classifyVmSeverity(snapshot);
  const now = Date.now();
  const escalating = VM_SEVERITY_RANK[severity] > VM_SEVERITY_RANK[vmLastSeverity];
  const recoveringToOk = severity === 'ok' && vmLastSeverity !== 'ok';
  const cooldownElapsed = now - vmLastPostedAt >= VM_SEVERITY_CADENCE_MS[severity];

  if (!escalating && !recoveringToOk && !cooldownElapsed) return;

  const metrics = formatVmMetrics(snapshot);
  if (recoveringToOk) {
    alertNorozo({
      title: 'VM resources back to normal',
      message: `Compute usage has returned to normal levels.\n${metrics}`,
      severity: 'info',
      service: 'vm-resources',
      steps: 'No action needed.',
    });
  } else if (severity === 'emergency') {
    alertNorozo({
      title: 'VM resources critical -- get in there now',
      message: `The VM is in an emergency resource state.\n${metrics}`,
      severity: 'critical',
      service: 'vm-resources',
      steps:
        '1. SSH to the VM (159.195.234.19) now and check `top`/`docker stats --no-stream`.\n' +
        '2. If memory/disk is the issue: `docker system prune` (careful with volumes) or find/kill the runaway container.\n' +
        '3. If load is the issue: identify the hot process via `top`/`htop` and decide whether to restart it.\n' +
        '4. This will keep alerting every 5 minutes until it drops out of emergency.',
    });
  } else if (severity === 'bad') {
    alertNorozo({
      title: 'VM resources running poor -- get in there',
      message: `Compute usage is high and worth addressing soon.\n${metrics}`,
      severity: 'error',
      service: 'vm-resources',
      steps:
        '1. Check `docker stats --no-stream` on the VM (159.195.234.19) for the heaviest container.\n' +
        '2. Not yet an emergency, but will escalate if it keeps climbing.',
    });
  } else if (severity === 'degraded') {
    alertNorozo({
      title: 'VM resources elevated',
      message: `Compute usage is higher than normal.\n${metrics}`,
      severity: 'warning',
      service: 'vm-resources',
      steps: 'No immediate action needed -- worth a glance if this persists.',
    });
  } else {
    alertNorozo({
      title: 'VM compute health',
      message: `Routine status -- everything normal.\n${metrics}`,
      severity: 'info',
      service: 'vm-resources',
      steps: 'No action needed -- routine update.',
    });
  }

  vmLastPostedAt = now;
  vmLastSeverity = severity;
}

export function startHealthMonitor(): void {
  logger.info('Starting platform health monitor', { intervalMs: CHECK_INTERVAL_MS });
  // Give the pool/redis clients a moment to connect before the first cycle.
  setTimeout(() => void runHealthCheckCycle(), 30_000);
  setInterval(() => void runHealthCheckCycle(), CHECK_INTERVAL_MS);
  setTimeout(() => void checkVmResources(), 45_000);
  setInterval(() => void checkVmResources(), CHECK_INTERVAL_MS);
}
