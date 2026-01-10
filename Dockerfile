FROM node:18-alpine

WORKDIR /app

RUN apk add --no-cache curl dumb-init bash

# Create user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# 🔑 FIX: give nodejs ownership of /app itself
RUN chown -R nodejs:nodejs /app

# Copy K8s env loader scripts
COPY --chown=root:root shared/scripts/load-k8s-env.sh /usr/local/bin/load-k8s-env.sh
COPY --chown=root:root shared/scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/load-k8s-env.sh /usr/local/bin/docker-entrypoint.sh

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

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["/usr/bin/dumb-init", "--", "node", "dist/server.js"]
