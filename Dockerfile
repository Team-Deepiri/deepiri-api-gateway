FROM ghcr.io/team-deepiri/deepiri-suite:18-alpine
ENV NODE_PATH=/app/node_modules

# Build shared-utils inside the image from source (no host dist/node_modules required).
COPY shared/deepiri-shared-utils/package.json /shared/deepiri-shared-utils/
COPY shared/deepiri-shared-utils/package-lock.json /shared/deepiri-shared-utils/
COPY shared/deepiri-shared-utils/tsconfig.json /shared/deepiri-shared-utils/
COPY shared/deepiri-shared-utils/src /shared/deepiri-shared-utils/src
COPY backend/deepiri-api-gateway/package.json ./
COPY backend/deepiri-api-gateway/package-lock.json ./

RUN node -e "const fs=require('fs'),lock=JSON.parse(fs.readFileSync('package-lock.json'));for(const k of Object.keys(lock.packages)){if(k.includes('deepiri-shared-utils')||k.includes('@team-deepiri/shared-utils')||k.includes('@deepiri/shared-utils'))delete lock.packages[k]}fs.writeFileSync('package-lock.json',JSON.stringify(lock));" \
    && cd /shared/deepiri-shared-utils \
    && npm ci --legacy-peer-deps \
    && npm run build \
    && node -e "const fs=require('fs'),p=JSON.parse(fs.readFileSync('package.json'));delete p.scripts.prepare;fs.writeFileSync('package.json',JSON.stringify(p,null,2));" \
    && rm -rf node_modules \
    && cd /app \
    && npm install --legacy-peer-deps file:/shared/deepiri-shared-utils \
    && npm ci --legacy-peer-deps \
    && cd /shared/deepiri-shared-utils \
    && npm ci --omit=dev --legacy-peer-deps \
    && cd /app \
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
