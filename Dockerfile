FROM node:18-alpine AS shared-utils-builder
WORKDIR /shared-utils
COPY platform-services/shared/deepiri-shared-utils/package.json ./
COPY platform-services/shared/deepiri-shared-utils/tsconfig.json ./
COPY platform-services/shared/deepiri-shared-utils/src ./src
RUN npm install --legacy-peer-deps && npm run build

FROM node:18-alpine

WORKDIR /app

RUN apk add --no-cache curl dumb-init bash

# Create user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

RUN chown -R nodejs:nodejs /app

# Copy K8s env loader scripts
COPY --chown=root:root platform-services/shared/scripts/load-k8s-env.sh /usr/local/bin/load-k8s-env.sh
COPY --chown=root:root platform-services/shared/scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/load-k8s-env.sh /usr/local/bin/docker-entrypoint.sh

COPY --chown=nodejs:nodejs platform-services/backend/deepiri-api-gateway/package*.json ./

RUN node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));delete p.dependencies['@deepiri/shared-utils'];fs.writeFileSync('package.json',JSON.stringify(p,null,2))"

USER nodejs

RUN npm install --legacy-peer-deps && npm cache clean --force

COPY --from=shared-utils-builder /shared-utils/package.json /app/node_modules/@deepiri/shared-utils/package.json
COPY --from=shared-utils-builder /shared-utils/dist /app/node_modules/@deepiri/shared-utils/dist

COPY --chown=nodejs:nodejs platform-services/backend/deepiri-api-gateway/tsconfig.json ./
COPY --chown=nodejs:nodejs platform-services/backend/deepiri-api-gateway/src ./src

RUN npm run build && \
    npm prune --production && \
    npm cache clean --force

EXPOSE 5000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["/usr/bin/dumb-init", "--", "node", "dist/server.js"]
