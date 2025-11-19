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

app.use(helmet());
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ 
    status: 'healthy', 
    service: 'api-gateway',
    services: Object.keys(SERVICES),
    timestamp: new Date().toISOString() 
  });
});

// Proxy routes
const createProxy = (target: string, pathRewrite?: { [key: string]: string }): Options => ({
  target,
  changeOrigin: true,
  pathRewrite
});

app.use('/api/users', createProxyMiddleware(createProxy(SERVICES.auth, { '^/api/users': '' })));
app.use('/api/tasks', createProxyMiddleware(createProxy(SERVICES.task, { '^/api/tasks': '/tasks' })));
app.use('/api/gamification', createProxyMiddleware(createProxy(SERVICES.engagement, { '^/api/gamification': '' })));
app.use('/api/analytics', createProxyMiddleware(createProxy(SERVICES.analytics, { '^/api/analytics': '' })));
app.use('/api/notifications', createProxyMiddleware(createProxy(SERVICES.notification, { '^/api/notifications': '' })));
app.use('/api/integrations', createProxyMiddleware(createProxy(SERVICES.integration, { '^/api/integrations': '' })));
app.use('/api/challenges', createProxyMiddleware(createProxy(SERVICES.challenge, { '^/api/challenges': '' })));
app.use('/api/agent', createProxyMiddleware(createProxy(SERVICES.cyrex, { '^/api/agent': '/agent' })));

// Error handling middleware for proxy errors
app.use((err: Error, req: Request, res: Response, next: Function) => {
  logger.error('Proxy error:', err);
  if (!res.headersSent) {
    res.status(503).json({ error: 'Service unavailable' });
  }
});

app.listen(PORT, () => {
  logger.info(`API Gateway running on port ${PORT}`);
  logger.info('Proxying to services:', SERVICES);
});

export default app;

