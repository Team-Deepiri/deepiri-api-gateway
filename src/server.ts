import express, { Express, Request, Response, ErrorRequestHandler } from 'express';
import { createProxyMiddleware, Options } from 'http-proxy-middleware';
import { createServer, Server as HttpServer } from 'http';
import { Socket } from 'net';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import winston from 'winston';
import promClient from 'prom-client';
import rateLimit from 'express-rate-limit';

// Import our new services for connection pooling
import * as redisService from './services/redisService';
import * as dbService from './services/dbService';
import { Timer, calculateStats, formatDuration } from './utils/timing';
import { cacheMiddleware } from './middleware/cacheMiddleware';
import { validateBodyIfPresent } from './middleware/inputValidation';

// ============================================================================
// PROMETHEUS METRICS SETUP
// ============================================================================

// Collect default Node.js metrics (memory, CPU, event loop, etc.)
promClient.collectDefaultMetrics({ prefix: 'api_gateway_' });

// HTTP request duration histogram
const httpRequestDuration = new promClient.Histogram({
  name: 'api_gateway_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
});

// HTTP request counter
const httpRequestTotal = new promClient.Counter({
  name: 'api_gateway_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code']
});

// Extend Options type to include callback properties that exist at runtime
interface ExtendedProxyOptions extends Options {
  onProxyReq?: (proxyReq: any, req: any, res: any) => void;
  onProxyRes?: (proxyRes: any, req: any, res: any) => void;
  onError?: (err: Error, req: express.Request, res: express.Response) => void;
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

dotenv.config();

const app: Express = express();
const httpServer: HttpServer = createServer(app);
const PORT: number = parseInt(process.env.PORT || '5000', 10);

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [new winston.transports.Console({ format: winston.format.simple() })]
});

interface ServiceUrls {
  auth: string;
  task: string;
  engagement: string;
  analytics: string;
  notification: string;
  integration: string;
  challenge: string;
  realtime: string;
  cyrex: string;
  languageIntelligence: string;
}

// Service URLs with validation
const SERVICES: ServiceUrls = {
  auth: process.env.AUTH_SERVICE_URL || 'http://auth-service:5001',
  task: process.env.TASK_ORCHESTRATOR_URL || 'http://task-orchestrator:5002',
  engagement: process.env.ENGAGEMENT_SERVICE_URL || 'http://engagement-service:5003',
  analytics: process.env.PLATFORM_ANALYTICS_SERVICE_URL || 'http://platform-analytics-service:5004',
  notification: process.env.NOTIFICATION_SERVICE_URL || 'http://notification-service:5005',
  integration: process.env.EXTERNAL_BRIDGE_SERVICE_URL || 'http://external-bridge-service:5006',
  challenge: process.env.CHALLENGE_SERVICE_URL || 'http://challenge-service:5007',
  realtime: process.env.REALTIME_GATEWAY_URL || 'http://realtime-gateway:5008',
  cyrex: process.env.CYREX_URL || 'http://cyrex:8000',
  languageIntelligence: process.env.LANGUAGE_INTELLIGENCE_SERVICE_URL || 'http://language-intelligence-service:5003'
};

// Validate all service URLs are defined
const validateServiceUrls = () => {
  const requiredServices: (keyof ServiceUrls)[] = ['auth', 'task', 'engagement', 'analytics', 'notification', 'integration', 'challenge', 'realtime', 'cyrex', 'languageIntelligence'];
  const missingServices: string[] = [];

  // Log environment variables for debugging
  logger.info('Environment variables check:', {
    AUTH_SERVICE_URL: process.env.AUTH_SERVICE_URL,
    TASK_ORCHESTRATOR_URL: process.env.TASK_ORCHESTRATOR_URL,
    ENGAGEMENT_SERVICE_URL: process.env.ENGAGEMENT_SERVICE_URL,
    PLATFORM_ANALYTICS_SERVICE_URL: process.env.PLATFORM_ANALYTICS_SERVICE_URL,
    NOTIFICATION_SERVICE_URL: process.env.NOTIFICATION_SERVICE_URL,
    EXTERNAL_BRIDGE_SERVICE_URL: process.env.EXTERNAL_BRIDGE_SERVICE_URL,
    CHALLENGE_SERVICE_URL: process.env.CHALLENGE_SERVICE_URL,
    REALTIME_GATEWAY_URL: process.env.REALTIME_GATEWAY_URL,
    CYREX_URL: process.env.CYREX_URL,
    LANGUAGE_INTELLIGENCE_SERVICE_URL: process.env.LANGUAGE_INTELLIGENCE_SERVICE_URL
  });

  for (const service of requiredServices) {
    const serviceUrl = SERVICES[service];
    if (!serviceUrl || (typeof serviceUrl === 'string' && serviceUrl.trim() === '')) {
      missingServices.push(service);
      logger.error(`Service URL missing for ${service}:`, {
        envVar: getEnvVarName(service),
        value: process.env[getEnvVarName(service)],
        default: getDefaultUrl(service),
        resolved: serviceUrl
      });
    }
  }

  if (missingServices.length > 0) {
    logger.error('Missing or empty service URLs:', missingServices);
    logger.error('Current SERVICES configuration:', SERVICES);
    throw new Error(`Missing required service URLs: ${missingServices.join(', ')}`);
  }

  logger.info('All service URLs validated successfully:', SERVICES);
};

// Helper to get environment variable name
const getEnvVarName = (service: keyof ServiceUrls): string => {
  const envMap: Record<keyof ServiceUrls, string> = {
    auth: 'AUTH_SERVICE_URL',
    task: 'TASK_ORCHESTRATOR_URL',
    engagement: 'ENGAGEMENT_SERVICE_URL',
    analytics: 'PLATFORM_ANALYTICS_SERVICE_URL',
    notification: 'NOTIFICATION_SERVICE_URL',
    integration: 'EXTERNAL_BRIDGE_SERVICE_URL',
    challenge: 'CHALLENGE_SERVICE_URL',
    realtime: 'REALTIME_GATEWAY_URL',
    cyrex: 'CYREX_URL',
    languageIntelligence: 'LANGUAGE_INTELLIGENCE_SERVICE_URL'
  };
  return envMap[service];
};

// Helper to get default URL
const getDefaultUrl = (service: keyof ServiceUrls): string => {
  const defaults: Record<keyof ServiceUrls, string> = {
    auth: 'http://auth-service:5001',
    task: 'http://task-orchestrator:5002',
    engagement: 'http://engagement-service:5003',
    analytics: 'http://platform-analytics-service:5004',
    notification: 'http://notification-service:5005',
    integration: 'http://external-bridge-service:5006',
    challenge: 'http://challenge-service:5007',
    realtime: 'http://realtime-gateway:5008',
    cyrex: 'http://cyrex:8000',
    languageIntelligence: 'http://language-intelligence-service:5003'
  };
  return defaults[service];
};

// Validate on startup
validateServiceUrls();

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
  preflightContinue: false,
  optionsSuccessStatus: 204
}));

// HTTP request timing middleware for Prometheus metrics
app.use((req: Request, res: Response, next) => {
  // Skip metrics for the metrics endpoint itself
  if (req.path === '/metrics') {
    return next();
  }
  
  const end = httpRequestDuration.startTimer();
  
  res.on('finish', () => {
    const route = req.route?.path || req.path.split('/').slice(0, 3).join('/') || 'unknown';
    const labels = {
      method: req.method,
      route: route,
      status_code: res.statusCode.toString()
    };
    end(labels);
    httpRequestTotal.inc(labels);
  });
  
  next();
});

// Initialize Redis and DB connection pools
async function initializeServices() {
  try {
    logger.info('Initializing Redis connection pool...');
    await redisService.initRedis();
    logger.info('Redis connection pool ready');
  } catch (error: any) {
    logger.warn('Redis initialization failed (will retry on first use):', error.message);
  }

  try {
    logger.info('Initializing PostgreSQL connection pool...');
    await dbService.initDb();
    logger.info('PostgreSQL connection pool ready');
  } catch (error: any) {
    logger.warn('PostgreSQL initialization failed (will retry on first use):', error.message);
  }
}

// Start initialization (non-blocking)
initializeServices();

// Health check needs to come BEFORE proxy routes
app.get('/health', async (req: Request, res: Response) => {
  const redisHealthy = await redisService.isHealthy();
  const dbHealthy = await dbService.isHealthy();
  
  res.json({ 
    status: 'healthy', 
    service: 'api-gateway',
    services: Object.keys(SERVICES),
    connections: {
      redis: redisHealthy ? 'connected' : 'disconnected',
      database: dbHealthy ? 'connected' : 'disconnected'
    },
    timestamp: new Date().toISOString() 
app.set("trust proxy", 1);

type BucketSpec = { capacity: number; refillRate: number };

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per ms

  constructor(capacity: number, refillRatePerSecond: number) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillRatePerSecond / 1000;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const tokensToAdd = (now - this.lastRefill) * this.refillRate;
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  consume(tokens = 1): boolean {
    this.refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    return false;
  }

  getTokens(): number {
    this.refill();
    return this.tokens;
  }

  getCapacity(): number {
    return this.capacity;
  }

  getRefillRatePerSecond(): number {
    return this.refillRate * 1000;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class RequestQueue {
  private queue: Array<{
    req: Request;
    res: Response;
    next: Function;
    bucket: TokenBucket;
    bucketName: string;
    enqueuedAt: number;
  }> = [];
  private processing = false;

  constructor(
    private readonly maxQueueSize = 100,
    private readonly processDelay = 100,
    private readonly maxWaitMs = 10_000
  ) {}

  enqueue(
    req: Request,
    res: Response,
    next: Function,
    bucket: TokenBucket,
    bucketName: string
  ): boolean {
    if (this.queue.length >= this.maxQueueSize) return false;

    const item = { req, res, next, bucket, bucketName, enqueuedAt: Date.now() };
    this.queue.push(item);

    res.once("close", () => {
      const i = this.queue.indexOf(item);
      if (i !== -1) this.queue.splice(i, 1);
    });

    void this.processQueue();
    return true;
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const now = Date.now();

        // drop all timed-out requests (anywhere in the queue)
        if (this.queue.length > 0) {
          const stillValid: typeof this.queue = [];

          for (const item of this.queue) {
            if (now - item.enqueuedAt > this.maxWaitMs) {
              if (!item.res.headersSent && !item.res.writableEnded) {
                item.res.status(429).json({
                  error: "Service temporarily overloaded",
                  message: "Request timed out in queue. Please try again later.",
                });
              }
              continue;
            }
            stillValid.push(item);
          }

          this.queue = stillValid;
        }

        // drop requests whose client disconnected
        this.queue = this.queue.filter((it) => !it.res.writableEnded);

        if (this.queue.length === 0) break;

        // pick first request whose bucket can consume a token
        const idx = this.queue.findIndex((it) => it.bucket.consume(1));
        if (idx === -1) {
          await sleep(this.processDelay);
          continue;
        }

        const item = this.queue.splice(idx, 1)[0];

        // if client already gone, skip
        if (item.res.writableEnded) {
          await sleep(this.processDelay);
          continue;
        }

        item.next();
        await sleep(this.processDelay);
      }
    } finally {
      this.processing = false;
    }
  }

  getQueueLength(): number {
    return this.queue.length;
  }
}

const intEnv = (val: string | undefined, fallback: number) => {
  const n = Number.parseInt(val ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
};

const THROTTLING_CONFIG = {
  global: {
    capacity: intEnv(process.env.GLOBAL_TOKEN_CAPACITY, 50),
    refillRate: intEnv(process.env.GLOBAL_REFILL_RATE, 10),
  },
  auth: {
    capacity: intEnv(process.env.AUTH_TOKEN_CAPACITY, 20),
    refillRate: intEnv(process.env.AUTH_REFILL_RATE, 2),
  },
  queue: {
    maxSize: intEnv(process.env.MAX_QUEUE_SIZE, 50),
    processDelay: intEnv(process.env.QUEUE_PROCESS_DELAY, 200),
    maxWaitMs: intEnv(process.env.MAX_QUEUE_WAIT_MS, 10_000),
  },
};

const globalTokenBucket = new TokenBucket(THROTTLING_CONFIG.global.capacity, THROTTLING_CONFIG.global.refillRate);
const authTokenBucket = new TokenBucket(THROTTLING_CONFIG.auth.capacity, THROTTLING_CONFIG.auth.refillRate);
const requestQueue = new RequestQueue(THROTTLING_CONFIG.queue.maxSize, THROTTLING_CONFIG.queue.processDelay, THROTTLING_CONFIG.queue.maxWaitMs);

const SERVICE_SPECS: Record<string, BucketSpec> = {
  task: { capacity: 30, refillRate: 5 },
  analytics: { capacity: 25, refillRate: 3 },
  realtime: { capacity: 40, refillRate: 8 },
  notification: { capacity: 35, refillRate: 6 },
  integration: { capacity: 20, refillRate: 2 },
  challenge: { capacity: 25, refillRate: 4 },
  engagement: { capacity: 30, refillRate: 5 },
  cyrex: { capacity: 15, refillRate: 1 },
};

const serviceBuckets: Record<string, TokenBucket> = Object.fromEntries(
  Object.entries(SERVICE_SPECS).map(([name, spec]) => [name, new TokenBucket(spec.capacity, spec.refillRate)])
) as Record<string, TokenBucket>;

const ROUTES: Array<{ prefix: string; name: string; bucket: TokenBucket }> = [
  { prefix: "/api/auth", name: "auth", bucket: authTokenBucket },
  { prefix: "/api/tasks", name: "task", bucket: serviceBuckets.task },
  { prefix: "/api/analytics", name: "analytics", bucket: serviceBuckets.analytics },
  { prefix: "/api/realtime", name: "realtime", bucket: serviceBuckets.realtime },
  { prefix: "/api/notifications", name: "notification", bucket: serviceBuckets.notification },
  { prefix: "/api/integrations", name: "integration", bucket: serviceBuckets.integration },
  { prefix: "/api/challenges", name: "challenge", bucket: serviceBuckets.challenge },
  { prefix: "/api/gamification", name: "engagement", bucket: serviceBuckets.engagement },
  { prefix: "/api/agent", name: "cyrex", bucket: serviceBuckets.cyrex },
];

const getFullPath = (req: Request) => `${req.baseUrl}${req.path}`;
const pickBucket = (fullPath: string) => ROUTES.find((r) => fullPath.startsWith(r.prefix));

const throttlingMiddleware = (req: Request, res: Response, next: Function) => {
  if (req.method === "OPTIONS") return next();

  const clientIP = req.ip || req.socket.remoteAddress || "unknown";
  const fullPath = getFullPath(req);

  const match = pickBucket(fullPath);
  const bucket = match?.bucket ?? globalTokenBucket;
  const bucketName = match?.name ?? "global";

  // Set rate limit headers
  res.set('RateLimit-Limit', bucket.getCapacity().toString());
  res.set('RateLimit-Remaining', Math.floor(bucket.getTokens()).toString());
  res.set('RateLimit-Reset', Math.floor((Date.now() + 1000) / 1000).toString()); // Approximate next second

  if (bucket.consume(1)) {
    if (process.env.RATE_LIMIT_DEBUG === '1') {
      logger.info(`[THROTTLE] Request allowed - IP: ${clientIP}, Path: ${fullPath}, Bucket: ${bucketName}, Tokens left: ${bucket.getTokens()}`);
    }
    return next();
  }

  const queued = requestQueue.enqueue(req, res, next, bucket, bucketName);
  if (queued) {
    if (process.env.RATE_LIMIT_DEBUG === '1') {
      logger.warn(`[THROTTLE] Request queued - IP: ${clientIP}, Path: ${fullPath}, Bucket: ${bucketName}, Queue length: ${requestQueue.getQueueLength()}`);
    }
    return;
  }

  if (process.env.RATE_LIMIT_DEBUG === '1') {
    logger.error(`[THROTTLE] Request rejected - Queue full, IP: ${clientIP}, Path: ${fullPath}, Bucket: ${bucketName}`);
  }
  res.status(429).json({
    error: "Service temporarily overloaded",
    message: "Too many concurrent requests. Please try again later.",
    retryAfter: "5",
  });
};

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: "Too many requests from this IP, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: { error: "Too many authentication attempts from this IP, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
});

app.use("/api", throttlingMiddleware);

app.use("/api/auth", authLimiter);

app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/auth")) return next();
  return generalLimiter(req, res, next);
});

// Test endpoint for rate limiting validation (only enabled in non-prod or with flag)
if (process.env.ENABLE_RL_TEST_ENDPOINT === 'true' || process.env.NODE_ENV !== 'production') {
  app.get('/api/rl-test', (req: Request, res: Response) => {
    res.json({ 
      ok: true, 
      ts: new Date().toISOString(), 
      ip: req.ip 
    });
  });
}

app.get("/health", (req: Request, res: Response) => {
  res.json({
    status: "healthy",
    service: "api-gateway",
    services: Object.keys(SERVICES),
    timestamp: new Date().toISOString(),
    throttling: {
      globalTokens: globalTokenBucket.getTokens(),
      authTokens: authTokenBucket.getTokens(),
      queueLength: requestQueue.getQueueLength(),
    },
  });
});

app.get("/api/throttling/status", (req: Request, res: Response) => {
  const services = Object.fromEntries(
    Object.entries(serviceBuckets).map(([service, bucket]) => [
      service,
      {
        tokens: bucket.getTokens(),
        capacity: bucket.getCapacity(),
        refillRate: `${bucket.getRefillRatePerSecond()} per second`,
      },
    ])
  );

  res.json({
    global: {
      tokens: globalTokenBucket.getTokens(),
      capacity: globalTokenBucket.getCapacity(),
      refillRate: `${globalTokenBucket.getRefillRatePerSecond()} per second`,
    },
    auth: {
      tokens: authTokenBucket.getTokens(),
      capacity: authTokenBucket.getCapacity(),
      refillRate: `${authTokenBucket.getRefillRatePerSecond()} per second`,
    },
    services,
    queue: {
      length: requestQueue.getQueueLength(),
      maxSize: THROTTLING_CONFIG.queue.maxSize,
    },
    timestamp: new Date().toISOString(),
  });
});

// Prometheus metrics endpoint
app.get('/metrics', async (req: Request, res: Response) => {
  try {
    // Update database pool metrics before serving
    dbService.updatePoolMetrics();
    
    res.set('Content-Type', promClient.register.contentType);
    res.end(await promClient.register.metrics());
  } catch (error: any) {
    logger.error('Error generating metrics:', error.message);
    res.status(500).end(error.message);
  }
});

// Test endpoint to verify the gateway is working
app.post('/test', (req: Request, res: Response) => {
  logger.info('Test endpoint called', { body: req.body, headers: req.headers });
  res.json({
    status: 'ok',
    message: 'API Gateway is working',
    receivedBody: req.body,
    timestamp: new Date().toISOString()
  });
});

// Log all incoming requests BEFORE body parsing
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    logger.info(`[INCOMING] ${req.method} ${req.originalUrl || req.path}`, {
      headers: {
        'content-type': req.get('content-type'),
        'content-length': req.get('content-length'),
        'origin': req.get('origin'),
        'user-agent': req.get('user-agent')?.substring(0, 50)
      }
    });
  }
  next();
});

// Don't parse JSON bodies globally - let http-proxy-middleware handle it
// This preserves the request stream for proper proxying
// Only parse for non-proxy routes like /health
app.use((req, res, next) => {
  try {
    // Skip body parsing for API proxy routes - let the proxy handle streaming
    if (req.path.startsWith('/api/')) {
      return next();
    }
    // Parse body only for non-proxy routes (like /health)
    express.json({ limit: '10mb', strict: false })(req, res, next);
  } catch (error) {
    logger.error('Body parsing error:', error);
    next(error);
  }
});
app.use(validateBodyIfPresent());

// Proxy routes with proper body restreaming
// http-proxy-middleware handles body streaming automatically, but we need to
// restream if express.json() has already consumed the stream
const createProxy = (target: string, pathRewrite?: { [key: string]: string }): any => ({
  target,
  changeOrigin: true,
  pathRewrite,
  timeout: 30000,
  proxyTimeout: 30000,
  selfHandleResponse: false, // Let proxy handle response automatically
  // Preserve CORS headers from the backend service
  // Don't overwrite them - let the backend service handle CORS
  onProxyReq: (proxyReq: any, req: any, res: any) => {
    try {
      // Since we skip body parsing for /api/* routes, the request stream is intact
      // http-proxy-middleware will automatically pipe the request stream
      // Log the request for debugging
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const contentType = req.get('content-type') || 'unknown';
        const contentLength = req.get('content-length') || 'unknown';
        logger.info(`Proxying ${req.method} ${req.originalUrl || req.path} to ${target}`, {
          contentType,
          contentLength,
          hasBody: !!req.body
        });
      }
    } catch (error) {
      logger.error('Error in onProxyReq:', error);
    }
  },
  onProxyRes: (proxyRes: any, req: any, res: any) => {
    // Log response but don't modify CORS headers - let backend service handle them
    logger.info(`Proxy response: ${req.method} ${req.originalUrl || req.path} -> ${proxyRes.statusCode} (target: ${target})`);
  },
  onError: (err: any, req: any, res: any) => {
    logger.error('Proxy error:', {
      error: err.message,
      target,
      path: req.originalUrl || req.path,
      method: req.method,
      stack: err.stack
    });
    if (!res.headersSent) {
      res.status(503).json({ error: 'Service unavailable', message: err.message });
    }
  }
});

// Express strips the mount path before passing to middleware
// So '/api/auth/register' becomes '/register' when it reaches the proxy
// PathRewrite must work with the stripped path
// For '/api/auth/register' -> Express strips to '/register' -> rewrite to '/auth/register'
app.use('/api/users', createProxyMiddleware(createProxy(SERVICES.auth)));

// Auth routes with enhanced logging
const authProxyOptions: any = createProxy(SERVICES.auth, { '^/': '/auth/' });
// Override onProxyReq to add detailed logging
const originalAuthOnProxyReq = authProxyOptions.onProxyReq;
const originalAuthOnProxyRes = authProxyOptions.onProxyRes;
authProxyOptions.onProxyReq = (proxyReq: any, req: any, res: any) => {
  const rewrittenPath = req.path.replace(/^\//, '/auth/');
  const contentType = req.get('content-type') || 'unknown';
  const contentLength = req.get('content-length') || 'unknown';
  logger.info(`[AUTH] Proxying ${req.method} ${req.originalUrl || req.path} -> ${SERVICES.auth}${rewrittenPath}`, {
    contentType,
    contentLength,
    headers: {
      'content-type': req.get('content-type'),
      'content-length': req.get('content-length'),
      'authorization': req.get('authorization') ? 'present' : 'missing'
    }
  });
  // Call original handler if it exists
  if (originalAuthOnProxyReq) {
    originalAuthOnProxyReq(proxyReq, req, res);
  }
};
authProxyOptions.onProxyRes = (proxyRes: any, req: any, res: any) => {
  // Log the response
  logger.info(`[AUTH] Response: ${req.method} ${req.originalUrl || req.path} -> ${proxyRes.statusCode}`, {
    statusCode: proxyRes.statusCode,
    headers: {
      'content-type': proxyRes.headers['content-type'],
      'access-control-allow-origin': proxyRes.headers['access-control-allow-origin'],
      'access-control-allow-credentials': proxyRes.headers['access-control-allow-credentials']
    }
  });

  // Ensure CORS headers are properly set from the auth service response
  // Don't overwrite them - let the auth service's CORS middleware handle it
  // But log if they're missing
  if (!proxyRes.headers['access-control-allow-origin']) {
    logger.warn(`[AUTH] Missing CORS headers in response from auth service`);
  }

  // Call original handler if it exists
  if (originalAuthOnProxyRes) {
    originalAuthOnProxyRes(proxyRes, req, res);
  }
};
app.use('/api/auth', createProxyMiddleware(authProxyOptions));

app.use('/api/tasks', createProxyMiddleware(createProxy(SERVICES.task, { '^/': '/tasks/' })));
app.use('/api/gamification', createProxyMiddleware(createProxy(SERVICES.engagement)));
app.use('/api/analytics', createProxyMiddleware(createProxy(SERVICES.analytics)));
app.use('/api/notifications', createProxyMiddleware(createProxy(SERVICES.notification)));
app.use('/api/integrations', createProxyMiddleware(createProxy(SERVICES.integration)));
app.use('/api/challenges', createProxyMiddleware(createProxy(SERVICES.challenge)));
app.use('/api/agent', createProxyMiddleware(createProxy(SERVICES.cyrex, { '^/': '/agent/' })));
app.use('/api/leases', createProxyMiddleware(createProxy(SERVICES.languageIntelligence, { '^/': '/api/v1/leases' })));
app.use('/api/contracts', createProxyMiddleware(createProxy(SERVICES.languageIntelligence, { '^/': '/api/v1/contracts' })));

// Error handling middleware for proxy errors
app.use((err: Error, req: Request, res: Response, next: Function) => {
  logger.error('Proxy error:', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method
  });
  if (!res.headersSent) {
    res.status(503).json({
      error: 'Service unavailable',
      message: err.message,
      path: req.path
    });
  }
});

// ===========================================================================
// PERFORMANCE TEST ENDPOINTS
// These endpoints demonstrate Redis caching and database connection pooling
// ===========================================================================

// Parse JSON for test endpoints
app.use('/api/test', express.json(), validateBodyIfPresent());

/**
 * Test endpoint: Redis cache performance
 * Demonstrates the speed difference between cached and uncached responses
 */
app.get('/api/test/redis-cache', cacheMiddleware({ ttlSeconds: 60 }), async (req: Request, res: Response) => {
  const timer = new Timer();
  
  // Simulate some processing work
  const data = {
    message: 'This response can be cached in Redis',
    timestamp: new Date().toISOString(),
    randomValue: Math.random(),
    processingTimeMs: timer.elapsedMs().toFixed(3)
  };
  
  res.json(data);
});

/**
 * Test endpoint: Direct Redis GET/SET operations
 * Shows raw Redis performance with timing
 */
app.post('/api/test/redis-direct', async (req: Request, res: Response) => {
  const { key, value, iterations = 1 } = req.body;
  
  if (!key) {
    return res.status(400).json({ error: 'key is required' });
  }
  
  const setTimings: bigint[] = [];
  const getTimings: bigint[] = [];
  
  try {
    // Perform SET operations
    for (let i = 0; i < iterations; i++) {
      const setResult = await redisService.set(`test:${key}:${i}`, value || `value-${i}`, 60);
      setTimings.push(setResult.timeNs);
    }
    
    // Perform GET operations  
    for (let i = 0; i < iterations; i++) {
      const getResult = await redisService.get(`test:${key}:${i}`);
      getTimings.push(getResult.timeNs);
    }
    
    const setStats = calculateStats(setTimings);
    const getStats = calculateStats(getTimings);
    
    res.json({
      success: true,
      iterations,
      setOperations: {
        avgMs: setStats.avgMs.toFixed(3),
        minMs: setStats.minMs.toFixed(3),
        maxMs: setStats.maxMs.toFixed(3),
        medianMs: setStats.medianMs.toFixed(3),
        p95Ms: setStats.p95Ms.toFixed(3)
      },
      getOperations: {
        avgMs: getStats.avgMs.toFixed(3),
        minMs: getStats.minMs.toFixed(3),
        maxMs: getStats.maxMs.toFixed(3),
        medianMs: getStats.medianMs.toFixed(3),
        p95Ms: getStats.p95Ms.toFixed(3)
      },
      redisStats: redisService.getStats()
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Test endpoint: Database query with connection pooling
 * Shows database performance with and without Redis cache
 */
app.get('/api/test/db-query', async (req: Request, res: Response) => {
  const useCache = req.query.cache !== 'false';
  const iterations = parseInt(req.query.iterations as string) || 1;
  const cacheKey = 'test:db:current-time';
  
  const timings: bigint[] = [];
  let source: 'cache' | 'database' = 'database';
  let lastResult: any = null;
  
  try {
    for (let i = 0; i < iterations; i++) {
      const timer = new Timer();
      
      if (useCache) {
        // Try cache first
        const cached = await redisService.get(cacheKey);
        if (cached.value !== null) {
          lastResult = JSON.parse(cached.value);
          source = 'cache';
          timings.push(timer.stop());
          continue;
        }
      }
      
      // Query database
      const dbResult = await dbService.query('SELECT NOW() as current_time, pg_database_size(current_database()) as db_size');
      lastResult = dbResult.result.rows[0];
      source = 'database';
      
      // Cache the result
      if (useCache) {
        await redisService.set(cacheKey, JSON.stringify(lastResult), 30);
      }
      
      timings.push(timer.stop());
    }
    
    const stats = calculateStats(timings);
    
    res.json({
      success: true,
      iterations,
      cacheEnabled: useCache,
      source,
      data: lastResult,
      timing: {
        avgMs: stats.avgMs.toFixed(3),
        minMs: stats.minMs.toFixed(3),
        maxMs: stats.maxMs.toFixed(3),
        medianMs: stats.medianMs.toFixed(3),
        p95Ms: stats.p95Ms.toFixed(3)
      },
      stats: {
        redis: redisService.getStats(),
        database: dbService.getStats()
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Test endpoint: Compare cached vs uncached database queries
 * This clearly demonstrates the performance improvement
 */
app.get('/api/test/db-comparison', async (req: Request, res: Response) => {
  const iterations = parseInt(req.query.iterations as string) || 10;
  const cacheKey = 'test:db:comparison';
  
  // Clear any existing cache
  await redisService.del(cacheKey);
  
  const uncachedTimings: bigint[] = [];
  const cachedTimings: bigint[] = [];
  
  try {
    // Run uncached queries
    for (let i = 0; i < iterations; i++) {
      const timer = new Timer();
      await dbService.query('SELECT NOW() as ts, $1 as iteration', [i]);
      uncachedTimings.push(timer.stop());
    }
    
    // Prime the cache with first query
    const primeTimer = new Timer();
    const result = await dbService.query('SELECT NOW() as ts, \'cached\' as type');
    await redisService.set(cacheKey, JSON.stringify(result.result.rows[0]), 60);
    const primeTime = primeTimer.stop();
    
    // Run cached queries
    for (let i = 0; i < iterations; i++) {
      const timer = new Timer();
      await redisService.get(cacheKey);
      cachedTimings.push(timer.stop());
    }
    
    const uncachedStats = calculateStats(uncachedTimings);
    const cachedStats = calculateStats(cachedTimings);
    
    // Calculate improvement
    const improvementFactor = uncachedStats.avgMs / Math.max(cachedStats.avgMs, 0.001);
    const improvementPercent = ((uncachedStats.avgMs - cachedStats.avgMs) / uncachedStats.avgMs) * 100;
    
    res.json({
      success: true,
      iterations,
      uncached: {
        avgMs: uncachedStats.avgMs.toFixed(3),
        minMs: uncachedStats.minMs.toFixed(3),
        maxMs: uncachedStats.maxMs.toFixed(3),
        medianMs: uncachedStats.medianMs.toFixed(3),
        p95Ms: uncachedStats.p95Ms.toFixed(3)
      },
      cached: {
        avgMs: cachedStats.avgMs.toFixed(3),
        minMs: cachedStats.minMs.toFixed(3),
        maxMs: cachedStats.maxMs.toFixed(3),
        medianMs: cachedStats.medianMs.toFixed(3),
        p95Ms: cachedStats.p95Ms.toFixed(3)
      },
      improvement: {
        factor: improvementFactor.toFixed(2) + 'x faster',
        percentReduction: improvementPercent.toFixed(1) + '%',
        absoluteSavingMs: (uncachedStats.avgMs - cachedStats.avgMs).toFixed(3)
      },
      cacheSetupTimeMs: formatDuration(primeTime)
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Test endpoint: Get connection pool statistics
 */
app.get('/api/test/stats', async (req: Request, res: Response) => {
  res.json({
    redis: redisService.getStats(),
    database: dbService.getStats(),
    timestamp: new Date().toISOString()
  });
});

/**
 * Test endpoint: Health check for Redis and Database
 */
app.get('/api/test/health', async (req: Request, res: Response) => {
  const [redisHealthy, dbHealthy] = await Promise.all([
    redisService.isHealthy(),
    dbService.isHealthy()
  ]);
  
  const status = redisHealthy && dbHealthy ? 'healthy' : 'degraded';
  
  res.status(status === 'healthy' ? 200 : 503).json({
    status,
    services: {
      redis: redisHealthy ? 'connected' : 'disconnected',
      database: dbHealthy ? 'connected' : 'disconnected'
    },
    timestamp: new Date().toISOString()
  });
});

// ===========================================================================
// END PERFORMANCE TEST ENDPOINTS
// ===========================================================================

// Catch-all for unhandled routes
app.use((req: Request, res: Response) => {
  logger.warn(`Unhandled route: ${req.method} ${req.path}`);
  res.status(404).json({
    error: 'Not found',
    path: req.path,
    method: req.method
  });
});

// Add unhandled error handlers
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// WebSocket proxy for Socket.IO - route to realtime gateway
// Socket.IO uses /socket.io path for WebSocket connections
// Only create proxy if realtime service URL is defined and valid
let socketIoProxy: ReturnType<typeof createProxyMiddleware> | null = null;

const realtimeUrl = SERVICES.realtime;
logger.info('Checking realtime service URL:', {
  url: realtimeUrl,
  type: typeof realtimeUrl,
  isEmpty: realtimeUrl === '',
  isUndefined: realtimeUrl === undefined,
  isNull: realtimeUrl === null,
  trimmed: typeof realtimeUrl === 'string' ? realtimeUrl.trim() : 'N/A'
});

if (realtimeUrl && typeof realtimeUrl === 'string' && realtimeUrl.trim() !== '') {
  try {
    logger.info(`Initializing Socket.IO proxy to: ${realtimeUrl}`);
    socketIoProxy = createProxyMiddleware({
      target: realtimeUrl.trim(),
      changeOrigin: true,
      ws: true, // Enable WebSocket proxying
      logLevel: 'info',
      onProxyReqWs: (_proxyReq: any, req: any) => {
        logger.info(`Socket.IO WS proxy req -> ${realtimeUrl}: ${req.url}`);
      },
      onError: (err: Error, req: express.Request, res: express.Response) => {
        logger.error('Socket.IO proxy error:', err.message);
        if (!res.headersSent) {
          res.status(503).json({ error: 'Realtime service unavailable' });
        }
      }
    } as any);
    logger.info('Socket.IO proxy initialized successfully');
  } catch (error: any) {
    logger.error('Failed to create Socket.IO proxy:', error.message);
    socketIoProxy = null;
  }
} else {
  logger.warn('REALTIME_GATEWAY_URL not configured or invalid, Socket.IO proxy disabled', {
    realtimeUrl,
    envVar: process.env.REALTIME_GATEWAY_URL
  });
}

// Apply Socket.IO proxy middleware (only if configured)
if (socketIoProxy) {
  app.use(socketIoProxy);

  // Handle WebSocket upgrade requests
  httpServer.on('upgrade', (req, socket: Socket, head) => {
    if (req.url?.startsWith('/socket.io')) {
      logger.info(`WebSocket upgrade request: ${req.url}`);
      (socketIoProxy as any).upgrade(req, socket as any, head);
    } else {
      socket.destroy();
    }
  });
} else {
  // If Socket.IO proxy is not configured, handle WebSocket requests gracefully
  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/socket.io')) {
      logger.warn('WebSocket upgrade requested but realtime service not configured');
      socket.destroy();
    } else {
      socket.destroy();
    }
  });
}

httpServer.listen(PORT, () => {
  logger.info(`API Gateway running on port ${PORT}`);
  logger.info('Proxying to services:', SERVICES);
  logger.info('WebSocket support enabled for Socket.IO -> realtime gateway');
}).on('error', (error: any) => {
  logger.error('Server error:', error);
  if (error.code === 'EADDRINUSE') {
    logger.error(`Port ${PORT} is already in use. Please stop the other service or change the PORT.`);
    process.exit(1);
  }
});

export default app;

