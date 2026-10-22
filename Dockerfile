# Box Yard: API + web app + orchestrator Claude, in one image.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl tini \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @anthropic-ai/claude-code --no-audit --no-fund
COPY --from=build /app /app
ENV NODE_ENV=production \
    BOXYARD_DATA_DIR=/data \
    PORT=3000 \
    DISABLE_AUTOUPDATER=1
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fs http://localhost:3000/healthz || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/server/index.js"]
