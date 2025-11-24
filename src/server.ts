import express, { Express, Request, Response, ErrorRequestHandler } from 'express';
import { createProxyMiddleware, Options } from 'http-proxy-middleware';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import winston from 'winston';

dotenv.config();

const app: Express = express();
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
}

// Service URLs
const SERVICES: ServiceUrls = {
  auth: process.env.AUTH_SERVICE_URL || 'http://auth-service:5001',
  task: process.env.TASK_ORCHESTRATOR_URL || 'http://task-orchestrator:5002',
  engagement: process.env.ENGAGEMENT_SERVICE_URL || 'http://engagement-service:5003',
  analytics: process.env.PLATFORM_ANALYTICS_SERVICE_URL || 'http://platform-analytics-service:5004',
  notification: process.env.NOTIFICATION_SERVICE_URL || 'http://notification-service:5005',
  integration: process.env.EXTERNAL_BRIDGE_SERVICE_URL || 'http://external-bridge-service:5006',
  challenge: process.env.CHALLENGE_SERVICE_URL || 'http://challenge-service:5007',
  realtime: process.env.REALTIME_GATEWAY_URL || 'http://realtime-gateway:5008',
  cyrex: process.env.CYREX_URL || 'http://cyrex:8000'
};

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

// Health check needs to come BEFORE proxy routes
app.get('/health', (req: Request, res: Response) => {
  res.json({ 
    status: 'healthy', 
    service: 'api-gateway',
    services: Object.keys(SERVICES),
    timestamp: new Date().toISOString() 
  });
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

// Proxy routes with proper body restreaming
// http-proxy-middleware handles body streaming automatically, but we need to
// restream if express.json() has already consumed the stream
const createProxy = (target: string, pathRewrite?: { [key: string]: string }): Options => ({
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
const authProxyOptions = createProxy(SERVICES.auth, { '^/': '/auth/' });
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

app.listen(PORT, () => {
  logger.info(`API Gateway running on port ${PORT}`);
  logger.info('Proxying to services:', SERVICES);
}).on('error', (error: any) => {
  logger.error('Server error:', error);
  if (error.code === 'EADDRINUSE') {
    logger.error(`Port ${PORT} is already in use. Please stop the other service or change the PORT.`);
    process.exit(1);
  }
});

export default app;

