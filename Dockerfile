# StockPilot production image.
#
# Multi-stage so the runtime image contains the built application and nothing
# else: no compiler, no dev dependencies, no source. A smaller image is not the
# point — a smaller attack surface is. There is no npm in the final stage, so a
# compromised process cannot install anything.
#
# Build:  docker build -t stockpilot .
# Run:    docker run -p 3000:3000 --env-file .env.local stockpilot

# ── Stage 1: dependencies ─────────────────────────────────────────────────────
FROM node:22.22-bookworm-slim AS deps

WORKDIR /app

# Copy only the manifests first, so this layer is cached until they change —
# dependency installs are by far the slowest step.
COPY package.json package-lock.json ./

# `npm ci` installs exactly what the lockfile says. `npm install` may resolve a
# newer version, which means the image differs from what CI tested.
RUN npm ci --ignore-scripts

# ── Stage 2: build ────────────────────────────────────────────────────────────
FROM node:22.22-bookworm-slim AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# The build validates configuration at import time, so placeholder values are
# supplied here. They never reach the runtime image.
RUN DATABASE_URL=postgres://placeholder:5432/placeholder \
    SESSION_SECRET=build-time-placeholder-value-not-used-at-runtime \
    npm run build

# ── Stage 3: runtime ──────────────────────────────────────────────────────────
FROM node:22.22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run as an unprivileged user. Node's official images ship a `node` user for
# exactly this; running as root means a container escape starts as root.
RUN mkdir -p /app && chown -R node:node /app

# `output: 'standalone'` emits a self-contained server with only the modules it
# actually imports, so node_modules is not copied wholesale.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# The agent and the migrations run from source, so they need their own files.
COPY --from=builder --chown=node:node /app/src ./src
COPY --from=builder --chown=node:node /app/drizzle ./drizzle
COPY --from=builder --chown=node:node /app/scripts ./scripts

USER node

EXPOSE 3000

# Readiness, not liveness: this checks the database too, so an unhealthy
# instance is taken out of rotation rather than restarted in a loop.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `server.js` is what the standalone build emits.
CMD ["node", "server.js"]
