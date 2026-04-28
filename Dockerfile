FROM ghcr.io/team-deepiri/deepiri-base:18-alpine

COPY --chown=nodejs:nodejs shared/deepiri-shared-utils/package*.json /shared/deepiri-shared-utils/
COPY --chown=nodejs:nodejs shared/deepiri-shared-utils/tsconfig.json /shared/deepiri-shared-utils/
COPY --chown=nodejs:nodejs shared/deepiri-shared-utils/src /shared/deepiri-shared-utils/src
COPY --chown=nodejs:nodejs backend/deepiri-api-gateway/package*.json ./

USER nodejs

RUN cd /shared/deepiri-shared-utils \
 && npm install --legacy-peer-deps \
 && npm run build \
 && cd /app \
 && npm install --legacy-peer-deps \
 && npm cache clean --force

COPY --chown=nodejs:nodejs backend/deepiri-api-gateway/tsconfig.json ./
COPY --chown=nodejs:nodejs backend/deepiri-api-gateway/src ./src

RUN npm run build && \
    npm prune --production && \
    npm cache clean --force

EXPOSE 5000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["/usr/bin/dumb-init", "--", "node", "dist/server.js"]
