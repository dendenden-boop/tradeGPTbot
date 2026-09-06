# Official multi-platform image index, verified on 2026-09-05.
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build

WORKDIR /workspace
RUN npm install --global pnpm@11.25.0 --ignore-scripts

# .dockerignore admits only build inputs and excludes credentials/generated files.
COPY . .
RUN pnpm install --frozen-lockfile --store-dir=/pnpm/store
RUN pnpm -r build
RUN pnpm --filter @ctp/api --offline --store-dir=/pnpm/store deploy --prod /opt/api

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
