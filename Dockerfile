FROM node:18-alpine

WORKDIR /app

RUN apk add --no-cache curl dumb-init

# Create user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# 🔑 FIX: give nodejs ownership of /app itself
RUN chown -R nodejs:nodejs /app

# Copy lockfiles with correct ownership
COPY --chown=nodejs:nodejs backend/deepiri-api-gateway/package*.json ./

USER nodejs

# Now npm can create node_modules
RUN npm ci --legacy-peer-deps && npm cache clean --force

COPY --chown=nodejs:nodejs backend/deepiri-api-gateway/tsconfig.json ./
COPY --chown=nodejs:nodejs backend/deepiri-api-gateway/src ./src

RUN npm run build && \
    npm prune --production && \
    npm cache clean --force

EXPOSE 5000

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/server.js"]
