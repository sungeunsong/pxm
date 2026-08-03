FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile
COPY apps/api apps/api
COPY apps/web apps/web
COPY packages/contracts packages/contracts
RUN pnpm --filter api build && pnpm --filter web build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 WEB_DIST_DIR=/app/apps/web/dist \
  PXM_RUN_AS_UID=1000 PXM_RUN_AS_GID=1000
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/plugin-manifests ./plugin-manifests
COPY --from=build /app/apps/api/plugin-controls.json ./plugin-controls.json
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages ./packages
COPY infra/production/load-secrets.sh /usr/local/bin/pxm-load-secrets
RUN chmod 0555 /usr/local/bin/pxm-load-secrets \
  && mkdir -p /var/lib/pxm /app/logs \
  && chown -R node:node /var/lib/pxm /app/logs
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/pxm-load-secrets"]
CMD ["node", "apps/api/dist/main.js"]
