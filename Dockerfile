FROM ghcr.io/team-deepiri/deepiri-base:18-alpine

COPY --chown=nodejs:nodejs backend/deepiri-api-gateway/package*.json ./

USER nodejs

RUN --mount=type=secret,id=github_token,uid=1001 \
    { echo "@team-deepiri:registry=https://npm.pkg.github.com"; \
      echo "//npm.pkg.github.com/:_authToken=$(cat /run/secrets/github_token)"; \
    } > .npmrc \
 && npm ci --legacy-peer-deps \
 && npm cache clean --force \
 && echo "@team-deepiri:registry=https://npm.pkg.github.com" > .npmrc

COPY --chown=nodejs:nodejs backend/deepiri-api-gateway/tsconfig.json ./
COPY --chown=nodejs:nodejs backend/deepiri-api-gateway/src ./src

RUN npm run build && \
    npm prune --production && \
    npm cache clean --force

EXPOSE 5000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["/usr/bin/dumb-init", "--", "node", "dist/server.js"]
