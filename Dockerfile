FROM node:18-alpine

WORKDIR /app

RUN apk add --no-cache curl dumb-init

COPY backend/deepiri-api-gateway/package*.json ./
RUN npm install --legacy-peer-deps && npm cache clean --force

COPY backend/deepiri-api-gateway/tsconfig.json ./
COPY backend/deepiri-api-gateway/src ./src

RUN npm run build && \
    npm prune --production && \
    npm cache clean --force

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    mkdir -p logs && chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:5000/health || exit 1

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/server.js"]

