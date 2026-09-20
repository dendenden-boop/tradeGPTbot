# Official multi-platform image index, verified on 2026-09-05.
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build

WORKDIR /workspace
RUN npm install --global pnpm@11.25.0 --ignore-scripts

# .dockerignore admits only build inputs and excludes credentials/generated files.
COPY . .
RUN pnpm install --frozen-lockfile --store-dir=/pnpm/store
RUN pnpm -r build
# pnpm 11 may verify release age via online attestations without caching full metadata.
# Verify the derived deployment lockfile first; materialize that exact graph offline.
RUN pnpm --filter @ctp/api --store-dir=/pnpm/store deploy --prod --lockfile-only /opt/api-policy
RUN --network=none pnpm --filter @ctp/api --offline --store-dir=/pnpm/store deploy --prod /opt/api \
    && cmp /opt/api-policy/pnpm-lock.yaml /opt/api/pnpm-lock.yaml

# Development-only helpers retain build tooling; neither is copied into runtime.
FROM build AS local-tools
ENV NODE_ENV=development
USER node
CMD ["node", "scripts/provision-development.mjs"]

FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /opt/api/ ./

USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "dist/server.js"]
