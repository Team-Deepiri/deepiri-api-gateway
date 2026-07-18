FROM ghcr.io/team-deepiri/deepiri-suite:18-alpine
ENV NODE_PATH=/app/node_modules


# Bedd runtime (Bun-style) — musl binary for Alpine
ARG BEDD_IMAGE=ghcr.io/team-deepiri/bedd:0.6
COPY --from=${BEDD_IMAGE} /opt/bedd/bedd-musl /usr/local/bin/bedd
COPY --from=${BEDD_IMAGE} /opt/bedd/skills /opt/bedd/skills
ENV BEDD_SKILLS_DIR=/opt/bedd/skills

COPY shared/deepiri-shared-utils/dist /shared/deepiri-shared-utils/dist
COPY shared/deepiri-shared-utils/node_modules /shared/deepiri-shared-utils/node_modules
RUN npm install --prefix /shared/deepiri-shared-utils --no-save --omit=dev winston ioredis dotenv
COPY backend/deepiri-api-gateway/package.json ./
COPY backend/deepiri-api-gateway/package-lock.json ./

RUN node -e "const fs=require('fs'),lock=JSON.parse(fs.readFileSync('package-lock.json'));for(const k of Object.keys(lock.packages)){if(k.includes('deepiri-shared-utils')||k.includes('@team-deepiri/shared-utils')||k.includes('@deepiri/shared-utils'))delete lock.packages[k]}fs.writeFileSync('package-lock.json',JSON.stringify(lock));" \
    && mkdir -p /shared/deepiri-shared-utils \
    && printf '{"name":"@team-deepiri/shared-utils","version":"0.0.0","main":"dist/index.js"}' > /shared/deepiri-shared-utils/package.json \
    && cd /app \
    && npm install --legacy-peer-deps file:/shared/deepiri-shared-utils \
    && npm ci --legacy-peer-deps \
    && npm cache clean --force

COPY backend/deepiri-api-gateway/tsconfig.json ./
COPY backend/deepiri-api-gateway/src ./src

RUN npm run build \
    && npm prune --production \
    && npm cache clean --force

RUN chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 5000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["/usr/bin/dumb-init", "--", "node", "dist/server.js"]
