# syntax=docker/dockerfile:1

# Bun is only used to install dependencies from bun.lock; the app builds and runs on Node.js.
FROM oven/bun:1-alpine AS bun

FROM node:24-alpine AS base
WORKDIR /app
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

FROM base AS production-deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
	PORT=3000 \
	HOST=0.0.0.0
WORKDIR /app
COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node drizzle ./drizzle
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server.js"]
