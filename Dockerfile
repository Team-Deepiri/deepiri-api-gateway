FROM node:18-alpine

WORKDIR /app

RUN apk add --no-cache curl dumb-init bash

# Create user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# 🔑 FIX: give nodejs ownership of /app itself
RUN chown -R nodejs:nodejs /app

# Copy K8s env loader scripts
COPY --chown=root:root scripts/load-k8s-env.sh /usr/local/bin/load-k8s-env.sh
COPY --chown=root:root scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/load-k8s-env.sh /usr/local/bin/docker-entrypoint.sh

# Copy package files and .npmrc for GitHub Packages auth
COPY --chown=nodejs:nodejs package*.json ./
COPY --chown=nodejs:nodejs .npmrc ./

USER nodejs

RUN --mount=type=secret,id=github_token,uid=1001 \
    { echo "@team-deepiri:registry=https://npm.pkg.github.com"; \
      echo "//npm.pkg.github.com/:_authToken=$(cat /run/secrets/github_token)"; \
    } > .npmrc && \
    npm ci --legacy-peer-deps && \
    npm cache clean --force && \
    echo "@team-deepiri:registry=https://npm.pkg.github.com" > .npmrc

COPY --chown=nodejs:nodejs tsconfig.json ./
COPY --chown=nodejs:nodejs src ./src

RUN npm run build && \
    npm prune --production && \
    npm cache clean --force

EXPOSE 5000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["/usr/bin/dumb-init", "--", "node", "dist/server.js"]
