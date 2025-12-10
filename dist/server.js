"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_proxy_middleware_1 = require("http-proxy-middleware");
const http_1 = require("http");
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const dotenv_1 = __importDefault(require("dotenv"));
const winston_1 = __importDefault(require("winston"));
dotenv_1.default.config();
const app = (0, express_1.default)();
const httpServer = (0, http_1.createServer)(app);
const PORT = parseInt(process.env.PORT || '5000', 10);
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.json(),
    transports: [new winston_1.default.transports.Console({ format: winston_1.default.format.simple() })]
});
// Service URLs
const SERVICES = {
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
app.use((0, helmet_1.default)({
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use((0, cors_1.default)({
    origin: ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
    preflightContinue: false,
    optionsSuccessStatus: 204
}));
// Health check needs to come BEFORE proxy routes
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        service: 'api-gateway',
        services: Object.keys(SERVICES),
        timestamp: new Date().toISOString()
    });
});
// Test endpoint to verify the gateway is working
app.post('/test', (req, res) => {
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
        express_1.default.json({ limit: '10mb', strict: false })(req, res, next);
    }
    catch (error) {
        logger.error('Body parsing error:', error);
        next(error);
    }
});
// Proxy routes with proper body restreaming
// http-proxy-middleware handles body streaming automatically, but we need to
// restream if express.json() has already consumed the stream
const createProxy = (target, pathRewrite) => ({
    target,
    changeOrigin: true,
    pathRewrite,
    timeout: 30000,
    proxyTimeout: 30000,
    selfHandleResponse: false, // Let proxy handle response automatically
    // Preserve CORS headers from the backend service
    // Don't overwrite them - let the backend service handle CORS
    on: {
        proxyReq: (proxyReq, req, res) => {
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
            }
            catch (error) {
                logger.error('Error in onProxyReq:', error);
            }
        },
        proxyRes: (proxyRes, req, res) => {
            // Log response but don't modify CORS headers - let backend service handle them
            logger.info(`Proxy response: ${req.method} ${req.originalUrl || req.path} -> ${proxyRes.statusCode} (target: ${target})`);
        },
        error: (err, req, res) => {
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
    }
});
// Express strips the mount path before passing to middleware
// So '/api/auth/register' becomes '/register' when it reaches the proxy
// PathRewrite must work with the stripped path
// For '/api/auth/register' -> Express strips to '/register' -> rewrite to '/auth/register'
app.use('/api/users', (0, http_proxy_middleware_1.createProxyMiddleware)(createProxy(SERVICES.auth)));
// Auth routes with enhanced logging
const baseAuthProxyOptions = createProxy(SERVICES.auth, { '^/': '/auth/' });
// Override onProxyReq and onProxyRes to add detailed logging
const originalAuthOnProxyReq = baseAuthProxyOptions.on?.proxyReq;
const originalAuthOnProxyRes = baseAuthProxyOptions.on?.proxyRes;
const originalAuthOnError = baseAuthProxyOptions.on?.error;
const authProxyOptions = {
    ...baseAuthProxyOptions,
    on: {
        proxyReq: (proxyReq, req, res) => {
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
                // In v3, handlers may have 4 parameters, but we only have 3
                // Call with the parameters we have - TypeScript will handle the optional 4th param
                originalAuthOnProxyReq(proxyReq, req, res);
            }
        },
        proxyRes: (proxyRes, req, res) => {
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
                // In v3, handlers may have 4 parameters, but we only have 3
                // Call with the parameters we have - TypeScript will handle the optional 4th param
                originalAuthOnProxyRes(proxyRes, req, res);
            }
        },
        error: originalAuthOnError || ((err, req, res) => {
            logger.error('Proxy error:', {
                error: err.message,
                target: SERVICES.auth,
                path: req.originalUrl || req.path,
                method: req.method,
                stack: err.stack
            });
            if (!res.headersSent) {
                res.status(503).json({ error: 'Service unavailable', message: err.message });
            }
        })
    }
};
app.use('/api/auth', (0, http_proxy_middleware_1.createProxyMiddleware)(authProxyOptions));
app.use('/api/tasks', (0, http_proxy_middleware_1.createProxyMiddleware)(createProxy(SERVICES.task, { '^/': '/tasks/' })));
app.use('/api/gamification', (0, http_proxy_middleware_1.createProxyMiddleware)(createProxy(SERVICES.engagement)));
app.use('/api/analytics', (0, http_proxy_middleware_1.createProxyMiddleware)(createProxy(SERVICES.analytics)));
app.use('/api/notifications', (0, http_proxy_middleware_1.createProxyMiddleware)(createProxy(SERVICES.notification)));
app.use('/api/integrations', (0, http_proxy_middleware_1.createProxyMiddleware)(createProxy(SERVICES.integration)));
app.use('/api/challenges', (0, http_proxy_middleware_1.createProxyMiddleware)(createProxy(SERVICES.challenge)));
app.use('/api/agent', (0, http_proxy_middleware_1.createProxyMiddleware)(createProxy(SERVICES.cyrex, { '^/': '/agent/' })));
// Error handling middleware for proxy errors
app.use((err, req, res, next) => {
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
app.use((req, res) => {
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
const socketIoProxy = (0, http_proxy_middleware_1.createProxyMiddleware)({
    target: SERVICES.realtime,
    changeOrigin: true,
    ws: true, // Enable WebSocket proxying
    pathFilter: (pathname, req) => pathname.startsWith('/socket.io')
});
// Apply Socket.IO proxy middleware
app.use(socketIoProxy);
// Handle WebSocket upgrade requests
httpServer.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/socket.io')) {
        logger.info(`WebSocket upgrade request: ${req.url}`);
        socketIoProxy.upgrade(req, socket, head);
    }
    else {
        socket.destroy();
    }
});
httpServer.listen(PORT, () => {
    logger.info(`API Gateway running on port ${PORT}`);
    logger.info('Proxying to services:', SERVICES);
    logger.info('WebSocket support enabled for Socket.IO -> realtime gateway');
}).on('error', (error) => {
    logger.error('Server error:', error);
    if (error.code === 'EADDRINUSE') {
        logger.error(`Port ${PORT} is already in use. Please stop the other service or change the PORT.`);
        process.exit(1);
    }
});
exports.default = app;
//# sourceMappingURL=server.js.map